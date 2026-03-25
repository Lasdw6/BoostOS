mod commit;
mod diff;
mod inodes;
mod overlay;
mod registry;

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use clap::{Parser, Subcommand};
use fuser::MountOption;
use nix::sys::signal::Signal;
use nix::unistd::{ForkResult, Pid};

use overlay::BoostOverlay;
use registry::{OverlayState, REGISTRY_BASE};

// ── CLI definition ─────────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(name = "boostos-overlay", version, about = "Copy-on-write filesystem overlays for parallel agent branches")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create an overlay for a directory. Prints the mount path on success.
    Create {
        /// Directory to overlay (must exist)
        path: PathBuf,
    },
    /// List all active overlays.
    List,
    /// Show what changed in an overlay (A=added, M=modified, D=deleted).
    Diff {
        /// Overlay ID (or prefix) or mount path
        id_or_mount: String,
    },
    /// Apply overlay changes to the source directory, then discard the overlay.
    Commit {
        /// Overlay ID (or prefix) or mount path
        id_or_mount: String,
    },
    /// Unmount the overlay and discard all changes.
    Discard {
        /// Overlay ID (or prefix) or mount path
        id_or_mount: String,
    },
}

// ── Entry point ────────────────────────────────────────────────────────────────

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Create { path } => cmd_create(path),
        Cmd::List => cmd_list(),
        Cmd::Diff { id_or_mount } => cmd_diff(id_or_mount),
        Cmd::Commit { id_or_mount } => cmd_commit(id_or_mount),
        Cmd::Discard { id_or_mount } => cmd_discard(id_or_mount),
    }
}

// ── create ─────────────────────────────────────────────────────────────────────

fn cmd_create(source_path: PathBuf) -> anyhow::Result<()> {
    let source = source_path
        .canonicalize()
        .map_err(|e| anyhow::anyhow!("Cannot resolve path {}: {}", source_path.display(), e))?;

    if !source.is_dir() {
        anyhow::bail!("{} is not a directory", source.display());
    }

    // Generate short ID from UUID
    let id: String = uuid::Uuid::new_v4().to_string()[..8].to_string();
    let base = PathBuf::from(REGISTRY_BASE).join(&id);
    let upper = base.join("upper");
    let mnt = base.join("mnt");

    fs::create_dir_all(&upper)?;
    fs::create_dir_all(&mnt)?;

    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs();

    let state = OverlayState {
        id: id.clone(),
        source: source.clone(),
        mount: mnt.clone(),
        upper: upper.clone(),
        pid: 0,
        created_at,
    };

    match unsafe { nix::unistd::fork() }? {
        ForkResult::Child => {
            // Mount FUSE — blocks until unmounted or SIGTERM.
            // Parent writes state.json with our PID; we don't touch the registry.
            let fs_impl = BoostOverlay::new(source, upper);
            fuser::mount2(
                fs_impl,
                &mnt,
                &[
                    MountOption::AutoUnmount,
                    MountOption::FSName("boostos-overlay".into()),
                ],
            )?;
            Ok(())
        }
        ForkResult::Parent { child } => {
            // Write final state.json with the child's PID.
            let parent_state = OverlayState {
                pid: child.as_raw(),
                ..state
            };
            registry::write(&parent_state)?;

            // Wait for the FUSE mount to become active, then print path.
            wait_for_mount(&mnt)?;
            println!("{}", mnt.display());
            Ok(())
        }
    }
}

fn wait_for_mount(mnt: &std::path::Path) -> anyhow::Result<()> {
    let mnt_str = mnt.to_string_lossy().to_string();
    for _ in 0..50 {
        if let Ok(mounts) = fs::read_to_string("/proc/mounts") {
            // /proc/mounts: device mountpoint fstype options dump pass
            if mounts.lines().any(|line| {
                let mut cols = line.split_whitespace();
                cols.next(); // device
                cols.next().map_or(false, |mp| mp == mnt_str)
            }) {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    anyhow::bail!("Timed out waiting for FUSE mount at {}", mnt.display())
}

// ── list ───────────────────────────────────────────────────────────────────────

fn cmd_list() -> anyhow::Result<()> {
    let overlays = registry::list();
    if overlays.is_empty() {
        eprintln!("No active overlays.");
        return Ok(());
    }
    println!("{:<10}  {:>6}  {:<40}  {}", "ID", "PID", "SOURCE", "MOUNT");
    println!("{}", "-".repeat(80));
    for o in overlays {
        println!(
            "{:<10}  {:>6}  {:<40}  {}",
            o.id,
            o.pid,
            o.source.display(),
            o.mount.display()
        );
    }
    Ok(())
}

// ── diff ───────────────────────────────────────────────────────────────────────

fn cmd_diff(id_or_mount: String) -> anyhow::Result<()> {
    let state = registry::find(&id_or_mount)
        .ok_or_else(|| anyhow::anyhow!("Overlay not found: {}", id_or_mount))?;
    diff::run(&state);
    Ok(())
}

// ── commit ─────────────────────────────────────────────────────────────────────

fn cmd_commit(id_or_mount: String) -> anyhow::Result<()> {
    let state = registry::find(&id_or_mount)
        .ok_or_else(|| anyhow::anyhow!("Overlay not found: {}", id_or_mount))?;
    commit::apply(&state)?;
    eprintln!("Changes applied to {}", state.source.display());
    cmd_discard(state.id)
}

// ── discard ────────────────────────────────────────────────────────────────────

fn cmd_discard(id_or_mount: String) -> anyhow::Result<()> {
    let state = registry::find(&id_or_mount)
        .ok_or_else(|| anyhow::anyhow!("Overlay not found: {}", id_or_mount))?;

    // Signal the FUSE process to exit (AutoUnmount will clean up the kernel mount)
    if state.pid > 0 {
        let pid = Pid::from_raw(state.pid);
        let _ = nix::sys::signal::kill(pid, Signal::SIGTERM);

        // Wait up to 5 seconds for the process to exit
        for _ in 0..50 {
            let proc_path = format!("/proc/{}", state.pid);
            if !std::path::Path::new(&proc_path).exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    // Forcibly unmount if still mounted (belt-and-suspenders)
    let mnt_str = state.mount.to_string_lossy().to_string();
    let _ = std::process::Command::new("fusermount")
        .args(["-uz", &mnt_str])
        .status();

    // Remove the overlay directory tree
    let base = PathBuf::from(REGISTRY_BASE).join(&state.id);
    let _ = fs::remove_dir_all(&base);

    eprintln!("Discarded overlay {}", state.id);
    Ok(())
}
