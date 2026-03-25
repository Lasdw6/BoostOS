use std::collections::HashMap;

/// Bidirectional map between relative path strings and FUSE inode numbers.
/// Paths are relative to the overlay root, e.g. "src/main.rs".
/// The root is stored as an empty string "".
pub struct InodeMap {
    next_ino: u64,
    rel_to_ino: HashMap<String, u64>,
    ino_to_rel: HashMap<u64, String>,
}

impl InodeMap {
    pub fn new() -> Self {
        let mut m = InodeMap {
            next_ino: 2, // 1 is reserved for root
            rel_to_ino: HashMap::new(),
            ino_to_rel: HashMap::new(),
        };
        m.rel_to_ino.insert(String::new(), 1);
        m.ino_to_rel.insert(1, String::new());
        m
    }

    /// Return existing inode for rel, or assign a new one.
    pub fn get_or_assign(&mut self, rel: &str) -> u64 {
        if let Some(&ino) = self.rel_to_ino.get(rel) {
            return ino;
        }
        let ino = self.next_ino;
        self.next_ino += 1;
        self.rel_to_ino.insert(rel.to_string(), ino);
        self.ino_to_rel.insert(ino, rel.to_string());
        ino
    }

    /// Look up the relative path for an inode.
    pub fn get_rel(&self, ino: u64) -> Option<&str> {
        self.ino_to_rel.get(&ino).map(|s| s.as_str())
    }

    /// Remove an inode mapping (e.g. on unlink).
    pub fn remove(&mut self, rel: &str) {
        if let Some(ino) = self.rel_to_ino.remove(rel) {
            self.ino_to_rel.remove(&ino);
        }
    }

    /// Update path for an inode (e.g. on rename).
    pub fn rename(&mut self, old_rel: &str, new_rel: &str) {
        if let Some(ino) = self.rel_to_ino.remove(old_rel) {
            self.rel_to_ino.insert(new_rel.to_string(), ino);
            self.ino_to_rel.insert(ino, new_rel.to_string());
        }
    }
}
