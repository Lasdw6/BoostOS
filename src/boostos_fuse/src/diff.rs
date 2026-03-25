use std::fs;
use std::path::Path;

use crate::registry::OverlayState;

/// Print a diff summary of what changed in an overlay.
/// Format matches git status --short: A added, M modified, D deleted.
pub fn run(state: &OverlayState) {
    let upper = &state.upper;
    let lower = &state.source;

    if !upper.exists() {
        return;
    }

    walk(upper, upper, lower);
}

fn walk(upper_root: &Path, current: &Path, lower_root: &Path) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };

    for entry in entries.flatten() {
        let fname = entry.file_name();
        let name = fname.to_string_lossy();
        let full = entry.path();

        if name.starts_with(".wh.") {
            // Whiteout = deleted from lower
            let orig = &name[4..];
            let dir_rel = current
                .strip_prefix(upper_root)
                .unwrap_or(current);
            let lo_path = lower_root.join(dir_rel).join(orig);
            println!("D {}", lo_path.strip_prefix(lower_root).unwrap_or(&lo_path).display());
        } else if full.is_dir() {
            walk(upper_root, &full, lower_root);
        } else {
            let rel = full.strip_prefix(upper_root).unwrap_or(&full);
            let lo_path = lower_root.join(rel);
            if !lo_path.exists() {
                println!("A {}", rel.display());
            } else if files_differ(&full, &lo_path) {
                println!("M {}", rel.display());
            }
        }
    }
}

fn files_differ(a: &Path, b: &Path) -> bool {
    // Compare sizes first (fast path), then content
    let (Ok(ma), Ok(mb)) = (fs::metadata(a), fs::metadata(b)) else {
        return true;
    };
    if ma.len() != mb.len() {
        return true;
    }
    match (fs::read(a), fs::read(b)) {
        (Ok(ca), Ok(cb)) => ca != cb,
        _ => true,
    }
}
