use std::fs;
use std::path::Path;

use crate::registry::OverlayState;

/// Apply all changes from the upper layer to the source directory.
/// Does not unmount — call discard afterwards (or the caller handles it).
pub fn apply(state: &OverlayState) -> anyhow::Result<()> {
    let upper = &state.upper;
    let lower = &state.source;

    if upper.exists() {
        apply_dir(upper, upper, lower)?;
    }

    Ok(())
}

fn apply_dir(upper_root: &Path, current: &Path, lower_root: &Path) -> anyhow::Result<()> {
    let entries = fs::read_dir(current)?;

    for entry in entries.flatten() {
        let fname = entry.file_name();
        let name = fname.to_string_lossy();
        let full = entry.path();

        let dir_rel = current
            .strip_prefix(upper_root)
            .unwrap_or(current);

        if name.starts_with(".wh.") {
            // Delete from lower
            let orig = &name[4..];
            let lo_target = lower_root.join(dir_rel).join(orig);
            if lo_target.is_dir() {
                let _ = fs::remove_dir_all(&lo_target);
            } else {
                let _ = fs::remove_file(&lo_target);
            }
        } else if full.is_dir() {
            // Ensure directory exists in lower, then recurse
            let lo_dir = lower_root.join(dir_rel).join(name.as_ref());
            fs::create_dir_all(&lo_dir)?;
            apply_dir(upper_root, &full, lower_root)?;
        } else {
            // Copy file to lower
            let rel = full.strip_prefix(upper_root).unwrap_or(&full);
            let lo_target = lower_root.join(rel);
            if let Some(parent) = lo_target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&full, &lo_target)?;
        }
    }

    Ok(())
}
