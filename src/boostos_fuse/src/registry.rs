use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

pub const REGISTRY_BASE: &str = "/tmp/boostos/overlays";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayState {
    pub id: String,
    pub source: PathBuf,
    pub mount: PathBuf,
    pub upper: PathBuf,
    pub pid: i32,
    pub created_at: u64, // Unix timestamp
}

impl OverlayState {
    pub fn base_dir(&self) -> PathBuf {
        PathBuf::from(REGISTRY_BASE).join(&self.id)
    }

    pub fn state_path(&self) -> PathBuf {
        self.base_dir().join("state.json")
    }
}

pub fn write(state: &OverlayState) -> std::io::Result<()> {
    let path = state.state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    fs::write(path, json)
}

pub fn read(id: &str) -> Option<OverlayState> {
    let path = PathBuf::from(REGISTRY_BASE).join(id).join("state.json");
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn list() -> Vec<OverlayState> {
    let base = PathBuf::from(REGISTRY_BASE);
    if !base.exists() {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(&base) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let id = e.file_name().to_string_lossy().to_string();
            read(&id)
        })
        .collect()
}

/// Find an overlay by short ID prefix or full mount path.
pub fn find(id_or_mount: &str) -> Option<OverlayState> {
    // Try exact ID first
    if let Some(state) = read(id_or_mount) {
        return Some(state);
    }
    // Scan all overlays for prefix match or mount path match
    list().into_iter().find(|s| {
        s.id == id_or_mount
            || s.id.starts_with(id_or_mount)
            || s.mount.to_string_lossy() == id_or_mount
    })
}

pub fn remove(id: &str) {
    let path = PathBuf::from(REGISTRY_BASE).join(id).join("state.json");
    let _ = fs::remove_file(path);
}
