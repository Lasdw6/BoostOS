use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fuser::{
    FileAttr, FileType, Filesystem, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory,
    ReplyEmpty, ReplyEntry, ReplyOpen, ReplyWrite, Request, TimeOrNow,
};
use libc::{EIO, ENOENT};

use crate::inodes::InodeMap;

const TTL: Duration = Duration::from_secs(1);

fn meta_to_attr(ino: u64, m: &fs::Metadata) -> FileAttr {
    let kind = if m.is_dir() {
        FileType::Directory
    } else {
        FileType::RegularFile
    };
    // Build ctime safely; clamp negative values to epoch
    let ctime_secs = m.ctime().max(0) as u64;
    let ctime_nsecs = m.ctime_nsec().max(0) as u64;
    let ctime = UNIX_EPOCH
        .checked_add(Duration::from_secs(ctime_secs))
        .and_then(|t| t.checked_add(Duration::from_nanos(ctime_nsecs)))
        .unwrap_or(UNIX_EPOCH);
    FileAttr {
        ino,
        size: m.len(),
        blocks: (m.len() + 511) / 512,
        atime: m.accessed().unwrap_or(UNIX_EPOCH),
        mtime: m.modified().unwrap_or(UNIX_EPOCH),
        ctime,
        crtime: UNIX_EPOCH,
        kind,
        perm: (m.mode() & 0o7777) as u16,
        nlink: m.nlink() as u32,
        uid: m.uid(),
        gid: m.gid(),
        rdev: m.rdev() as u32,
        blksize: 4096,
        flags: 0,
    }
}

fn whiteout_of(name: &OsStr) -> String {
    format!(".wh.{}", name.to_string_lossy())
}

fn is_whiteout(name: &str) -> bool {
    name.starts_with(".wh.")
}

fn unwh(name: &str) -> &str {
    name.strip_prefix(".wh.").unwrap_or(name)
}

/// Join a relative overlay path with a root.
/// rel="" means the root itself.
fn abs(root: &Path, rel: &str) -> PathBuf {
    if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    }
}

/// Build a child relative path from a parent rel and a name.
fn child_rel(parent_rel: &str, name: &OsStr) -> String {
    let n = name.to_string_lossy();
    if parent_rel.is_empty() {
        n.into_owned()
    } else {
        format!("{}/{}", parent_rel, n)
    }
}

/// Return the parent relative path (strip last component).
fn parent_rel(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(i) => &rel[..i],
        None => "",
    }
}

pub struct BoostOverlay {
    lower: PathBuf,
    upper: PathBuf,
    inodes: InodeMap,
}

impl BoostOverlay {
    pub fn new(lower: PathBuf, upper: PathBuf) -> Self {
        Self {
            lower,
            upper,
            inodes: InodeMap::new(),
        }
    }

    fn up(&self, rel: &str) -> PathBuf {
        abs(&self.upper, rel)
    }

    fn lo(&self, rel: &str) -> PathBuf {
        abs(&self.lower, rel)
    }

    /// Whether a whiteout marker exists for `name` in `parent_rel`'s upper dir.
    fn whited_out(&self, parent_rel: &str, name: &OsStr) -> bool {
        self.up(parent_rel).join(whiteout_of(name)).exists()
    }

    /// Real path on disk (upper first, then lower). Returns None if not found.
    fn real(&self, ino: u64) -> Option<PathBuf> {
        let rel = self.inodes.get_rel(ino)?;
        let up = self.up(rel);
        if up.exists() {
            return Some(up);
        }
        let lo = self.lo(rel);
        if lo.exists() {
            return Some(lo);
        }
        None
    }

    /// Copy-on-write: ensure `rel` exists in upper (copy from lower if needed).
    /// Returns the upper path.
    fn cow(&self, rel: &str) -> std::io::Result<PathBuf> {
        let up = self.up(rel);
        if up.exists() {
            return Ok(up);
        }
        let lo = self.lo(rel);
        if !lo.exists() {
            return Err(std::io::Error::from_raw_os_error(ENOENT));
        }
        if let Some(p) = up.parent() {
            fs::create_dir_all(p)?;
        }
        fs::copy(&lo, &up)?;
        Ok(up)
    }

    /// Ensure the upper directory exists for a given parent rel path.
    fn ensure_upper_dir(&self, parent_rel: &str) -> std::io::Result<()> {
        fs::create_dir_all(self.up(parent_rel))
    }
}

impl Filesystem for BoostOverlay {
    fn lookup(&mut self, _req: &Request, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let par = match self.inodes.get_rel(parent) {
            Some(r) => r.to_string(),
            None => {
                reply.error(ENOENT);
                return;
            }
        };

        // Hide whiteout files from user
        let name_str = name.to_string_lossy();
        if is_whiteout(&name_str) {
            reply.error(ENOENT);
            return;
        }

        // Check if this entry is whited out in upper
        if self.whited_out(&par, name) {
            reply.error(ENOENT);
            return;
        }

        let crel = child_rel(&par, name);
        let up = self.up(&crel);
        let lo = self.lo(&crel);

        let real = if up.exists() {
            &up
        } else if lo.exists() {
            &lo
        } else {
            reply.error(ENOENT);
            return;
        };

        let meta = match fs::metadata(real) {
            Ok(m) => m,
            Err(_) => {
                reply.error(EIO);
                return;
            }
        };

        let ino = self.inodes.get_or_assign(&crel);
        reply.entry(&TTL, &meta_to_attr(ino, &meta), 0);
    }

    fn getattr(&mut self, _req: &Request, ino: u64, _fh: Option<u64>, reply: ReplyAttr) {
        match self.real(ino).and_then(|p| fs::metadata(&p).ok()) {
            Some(meta) => reply.attr(&TTL, &meta_to_attr(ino, &meta)),
            None => reply.error(ENOENT),
        }
    }

    fn setattr(
        &mut self,
        _req: &Request,
        ino: u64,
        mode: Option<u32>,
        uid: Option<u32>,
        gid: Option<u32>,
        size: Option<u64>,
        _atime: Option<TimeOrNow>,
        _mtime: Option<TimeOrNow>,
        _ctime: Option<SystemTime>,
        _fh: Option<u64>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<u32>,
        reply: ReplyAttr,
    ) {
        let rel = match self.inodes.get_rel(ino) {
            Some(r) => r.to_string(),
            None => {
                reply.error(ENOENT);
                return;
            }
        };

        let path = match self.cow(&rel) {
            Ok(p) => p,
            Err(_) => {
                reply.error(ENOENT);
                return;
            }
        };

        if let Some(m) = mode {
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(m));
        }

        if let Some(sz) = size {
            if let Ok(f) = OpenOptions::new().write(true).open(&path) {
                let _ = f.set_len(sz);
            }
        }

        if uid.is_some() || gid.is_some() {
            use nix::unistd::{chown, Gid, Uid};
            let _ = chown(
                path.as_path(),
                uid.map(Uid::from_raw),
                gid.map(Gid::from_raw),
            );
        }

        match fs::metadata(&path) {
            Ok(meta) => reply.attr(&TTL, &meta_to_attr(ino, &meta)),
            Err(_) => reply.error(EIO),
        }
    }

    fn readdir(&mut self, _req: &Request, ino: u64, _fh: u64, offset: i64, mut reply: ReplyDirectory) {
        let rel = match self.inodes.get_rel(ino) {
            Some(r) => r.to_string(),
            None => {
                reply.error(ENOENT);
                return;
            }
        };

        let up_dir = self.up(&rel);
        let lo_dir = self.lo(&rel);

        // Collect upper entries and whiteout names
        let mut upper_names: HashSet<String> = HashSet::new();
        let mut whited: HashSet<String> = HashSet::new();

        if up_dir.exists() {
            if let Ok(rd) = fs::read_dir(&up_dir) {
                for entry in rd.flatten() {
                    let n = entry.file_name().to_string_lossy().to_string();
                    if is_whiteout(&n) {
                        whited.insert(unwh(&n).to_string());
                    } else {
                        upper_names.insert(n);
                    }
                }
            }
        }

        // (offset, name, kind, child_rel)
        let mut entries: Vec<(i64, String, FileType, String)> = Vec::new();

        // . and ..
        entries.push((1, ".".to_string(), FileType::Directory, rel.clone()));
        let par_rel = parent_rel(&rel).to_string();
        entries.push((2, "..".to_string(), FileType::Directory, par_rel));

        let mut pos: i64 = 2;

        // Upper entries
        for name in &upper_names {
            pos += 1;
            let crel = child_rel(&rel, OsStr::new(name));
            let kind = if self.up(&crel).is_dir() {
                FileType::Directory
            } else {
                FileType::RegularFile
            };
            entries.push((pos, name.clone(), kind, crel));
        }

        // Lower entries not whited-out and not already in upper
        if lo_dir.exists() {
            if let Ok(rd) = fs::read_dir(&lo_dir) {
                for entry in rd.flatten() {
                    let n = entry.file_name().to_string_lossy().to_string();
                    if whited.contains(&n) || upper_names.contains(&n) {
                        continue;
                    }
                    pos += 1;
                    let crel = child_rel(&rel, OsStr::new(&n));
                    let kind = if entry.path().is_dir() {
                        FileType::Directory
                    } else {
                        FileType::RegularFile
                    };
                    entries.push((pos, n, kind, crel));
                }
            }
        }

        for (off, name, kind, crel) in entries {
            if off <= offset {
                continue;
            }
            let child_ino = if name == "." {
                ino
            } else if name == ".." {
                self.inodes.get_or_assign(&crel)
            } else {
                self.inodes.get_or_assign(&crel)
            };
            if reply.add(child_ino, off, kind, &name) {
                break;
            }
        }

        reply.ok();
    }

    fn read(
        &mut self,
        _req: &Request,
        ino: u64,
        _fh: u64,
        offset: i64,
        size: u32,
        _flags: i32,
        _lock: Option<u64>,
        reply: ReplyData,
    ) {
        let Some(path) = self.real(ino) else {
            reply.error(ENOENT);
            return;
        };
        let Ok(mut f) = fs::File::open(&path) else {
            reply.error(EIO);
            return;
        };
        if f.seek(SeekFrom::Start(offset as u64)).is_err() {
            reply.error(EIO);
            return;
        }
        let mut buf = vec![0u8; size as usize];
        match f.read(&mut buf) {
            Ok(n) => reply.data(&buf[..n]),
            Err(_) => reply.error(EIO),
        }
    }

    fn write(
        &mut self,
        _req: &Request,
        ino: u64,
        _fh: u64,
        offset: i64,
        data: &[u8],
        _write_flags: u32,
        _flags: i32,
        _lock: Option<u64>,
        reply: ReplyWrite,
    ) {
        let rel = match self.inodes.get_rel(ino) {
            Some(r) => r.to_string(),
            None => {
                reply.error(ENOENT);
                return;
            }
        };
        let path = match self.cow(&rel) {
            Ok(p) => p,
            Err(_) => {
                reply.error(EIO);
                return;
            }
        };
        let Ok(mut f) = OpenOptions::new().write(true).open(&path) else {
            reply.error(EIO);
            return;
        };
        if f.seek(SeekFrom::Start(offset as u64)).is_err() {
            reply.error(EIO);
            return;
        }
        match f.write_all(data) {
            Ok(_) => reply.written(data.len() as u32),
            Err(_) => reply.error(EIO),
        }
    }

    fn create(
        &mut self,
        _req: &Request,
        parent: u64,
        name: &OsStr,
        mode: u32,
        _umask: u32,
        _flags: i32,
        reply: ReplyCreate,
    ) {
        let par = match self.inodes.get_rel(parent) {
            Some(r) => r.to_string(),
            None => {
                reply.error(ENOENT);
                return;
            }
        };
        let crel = child_rel(&par, name);
        let up = self.up(&crel);

        if let Some(p) = up.parent() {
            if fs::create_dir_all(p).is_err() {
                reply.error(EIO);
                return;
            }
        }

        // Remove any whiteout that may exist
        let wh = self.up(&par).join(whiteout_of(name));
        let _ = fs::remove_file(&wh);

        let Ok(_f) = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(&up)
        else {
            reply.error(EIO);
            return;
        };

        let Ok(meta) = fs::metadata(&up) else {
            reply.error(EIO);
            return;
        };
        let ino = self.inodes.get_or_assign(&crel);
        reply.created(&TTL, &meta_to_attr(ino, &meta), 0, 0, 0);
    }

    fn unlink(&mut self, _req: &Request, parent: u64, name: &OsStr, reply: ReplyEmpty) {
        let par = match self.inodes.get_rel(parent) {
            Some(r) => r.to_string(),
            None => {
                reply.error(ENOENT);
                return;
            }
        };
        let crel = child_rel(&par, name);
        let up = self.up(&crel);
        let lo = self.lo(&crel);

        // Remove from upper if present
        if up.exists() {
            let _ = fs::remove_file(&up);
        }

        if lo.exists() {
            // Need a whiteout so lower entry is hidden
            let _ = self.ensure_upper_dir(&par);
            let wh = self.up(&par).join(whiteout_of(name));
            match fs::write(&wh, b"") {
                Ok(_) => {
                    self.inodes.remove(&crel);
                    reply.ok();
                }
                Err(_) => reply.error(EIO),
            }
        } else {
            self.inodes.remove(&crel);
            reply.ok();
        }
    }

    fn mkdir(
        &mut self,
        _req: &Request,
        parent: u64,
        name: &OsStr,
        mode: u32,
        _umask: u32,
        reply: ReplyEntry,
    ) {
        let par = match self.inodes.get_rel(parent) {
            Some(r) => r.to_string(),
            None => {
                reply.error(ENOENT);
                return;
            }
        };
        let crel = child_rel(&par, name);
        let up = self.up(&crel);

        // Remove any whiteout that may exist
        let wh = self.up(&par).join(whiteout_of(name));
        let _ = fs::remove_file(&wh);

        match fs::create_dir_all(&up) {
            Ok(_) => {
                let _ = fs::set_permissions(&up, fs::Permissions::from_mode(mode));
                let Ok(meta) = fs::metadata(&up) else {
                    reply.error(EIO);
                    return;
                };
                let ino = self.inodes.get_or_assign(&crel);
                reply.entry(&TTL, &meta_to_attr(ino, &meta), 0);
            }
            Err(_) => reply.error(EIO),
        }
    }

    fn rmdir(&mut self, _req: &Request, parent: u64, name: &OsStr, reply: ReplyEmpty) {
        let par = match self.inodes.get_rel(parent) {
            Some(r) => r.to_string(),
            None => {
                reply.error(ENOENT);
                return;
            }
        };
        let crel = child_rel(&par, name);
        let up = self.up(&crel);
        let lo = self.lo(&crel);

        if up.exists() {
            let _ = fs::remove_dir_all(&up);
        }

        if lo.exists() {
            let _ = self.ensure_upper_dir(&par);
            let wh = self.up(&par).join(whiteout_of(name));
            match fs::write(&wh, b"") {
                Ok(_) => {
                    self.inodes.remove(&crel);
                    reply.ok();
                }
                Err(_) => reply.error(EIO),
            }
        } else {
            self.inodes.remove(&crel);
            reply.ok();
        }
    }

    fn rename(
        &mut self,
        _req: &Request,
        parent: u64,
        name: &OsStr,
        newparent: u64,
        newname: &OsStr,
        _flags: u32,
        reply: ReplyEmpty,
    ) {
        let par = match self.inodes.get_rel(parent) {
            Some(r) => r.to_string(),
            None => {
                reply.error(ENOENT);
                return;
            }
        };
        let newpar = match self.inodes.get_rel(newparent) {
            Some(r) => r.to_string(),
            None => {
                reply.error(ENOENT);
                return;
            }
        };

        let old_rel = child_rel(&par, name);
        let new_rel = child_rel(&newpar, newname);
        let old_lo = self.lo(&old_rel);

        // Ensure source is in upper (CoW)
        let old_up = match self.cow(&old_rel) {
            Ok(p) => p,
            Err(_) => {
                reply.error(ENOENT);
                return;
            }
        };

        let new_up = self.up(&new_rel);
        if let Some(p) = new_up.parent() {
            let _ = fs::create_dir_all(p);
        }

        // Remove whiteout at new destination if present
        let new_wh = self.up(&newpar).join(whiteout_of(newname));
        let _ = fs::remove_file(&new_wh);

        match fs::rename(&old_up, &new_up) {
            Ok(_) => {
                // Create whiteout for old path if it existed in lower
                if old_lo.exists() {
                    let _ = self.ensure_upper_dir(&par);
                    let wh = self.up(&par).join(whiteout_of(name));
                    let _ = fs::write(&wh, b"");
                }
                self.inodes.rename(&old_rel, &new_rel);
                reply.ok();
            }
            Err(_) => reply.error(EIO),
        }
    }

    fn open(&mut self, _req: &Request, _ino: u64, _flags: i32, reply: ReplyOpen) {
        reply.opened(0, 0);
    }

    fn opendir(&mut self, _req: &Request, _ino: u64, _flags: i32, reply: ReplyOpen) {
        reply.opened(0, 0);
    }

    fn release(
        &mut self,
        _req: &Request,
        _ino: u64,
        _fh: u64,
        _flags: i32,
        _lock: Option<u64>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        reply.ok();
    }

    fn releasedir(
        &mut self,
        _req: &Request,
        _ino: u64,
        _fh: u64,
        _flags: i32,
        reply: ReplyEmpty,
    ) {
        reply.ok();
    }

    fn flush(&mut self, _req: &Request, _ino: u64, _fh: u64, _lock: u64, reply: ReplyEmpty) {
        reply.ok();
    }

    fn fsync(&mut self, _req: &Request, _ino: u64, _fh: u64, _datasync: bool, reply: ReplyEmpty) {
        reply.ok();
    }

    fn fsyncdir(
        &mut self,
        _req: &Request,
        _ino: u64,
        _fh: u64,
        _datasync: bool,
        reply: ReplyEmpty,
    ) {
        reply.ok();
    }

    fn access(&mut self, _req: &Request, _ino: u64, _mask: i32, reply: ReplyEmpty) {
        reply.ok();
    }

    fn statfs(&mut self, _req: &Request, _ino: u64, reply: fuser::ReplyStatfs) {
        reply.statfs(0, 0, 0, 0, 0, 512, 255, 0);
    }
}
