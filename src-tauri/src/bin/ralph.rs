//! `ralph` — supporting CLI for Ralph Loop Junkie.
//!
//! Operates on the same on-disk data the desktop app uses
//! (`<app-data>/com.ralphloopjunkie.app/loops/`), so the GUI and CLI stay in
//! sync. Commands: `list`, `run <loop>`, `stop <loop>`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

const IDENTIFIER: &str = "com.ralphloopjunkie.app";

#[derive(Deserialize)]
struct LoopFile {
    dir: String,
    name: String,
    #[serde(default)]
    content: String,
}

#[derive(Deserialize)]
struct LoopWorkspace {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    iteration: i64,
    #[serde(default)]
    last_run: Option<f64>,
    #[serde(default)]
    files: Vec<LoopFile>,
}

// The manifest uses camelCase ("lastRun"); accept both via an alias.
impl LoopWorkspace {}

fn app_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(home).join("Library/Application Support").join(IDENTIFIER))
    }
    #[cfg(target_os = "linux")]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("{}/.local/share", std::env::var("HOME").unwrap_or_default()));
        Some(PathBuf::from(base).join(IDENTIFIER))
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA").ok()?;
        Some(PathBuf::from(base).join(IDENTIFIER))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

fn loops_base() -> PathBuf {
    app_data_dir()
        .map(|d| d.join("loops"))
        .expect("could not resolve app data directory")
}

fn read_manifest() -> Vec<LoopWorkspace> {
    let path = loops_base().join("loops.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    // Re-map camelCase lastRun -> last_run via a generic value pass.
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(serde_json::Value::Array(items)) => items
            .into_iter()
            .filter_map(|mut v| {
                if let Some(obj) = v.as_object_mut() {
                    if let Some(lr) = obj.remove("lastRun") {
                        obj.insert("last_run".to_string(), lr);
                    }
                }
                serde_json::from_value(v).ok()
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn find_loop<'a>(loops: &'a [LoopWorkspace], needle: &str) -> Option<&'a LoopWorkspace> {
    let lower = needle.to_lowercase();
    loops
        .iter()
        .find(|l| l.id == needle)
        .or_else(|| loops.iter().find(|l| l.name.to_lowercase() == lower))
        .or_else(|| loops.iter().find(|l| l.id.to_lowercase() == lower))
}

fn relative_time(ts_ms: f64) -> String {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(ts_ms);
    let secs = ((now_ms - ts_ms) / 1000.0).max(0.0).round() as i64;
    if secs < 60 {
        format!("{}s ago", secs)
    } else if secs < 3600 {
        format!("{}m ago", secs / 60)
    } else if secs < 86400 {
        format!("{}h ago", secs / 3600)
    } else {
        format!("{}d ago", secs / 86400)
    }
}

fn is_image(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif"
    )
}

/// Write a loop's files to disk so a never-run loop can still execute.
fn write_loop_files(loop_dir: &Path, files: &[LoopFile]) -> Result<(), String> {
    std::fs::create_dir_all(loop_dir).map_err(|e| e.to_string())?;
    for f in files {
        if f.dir.contains("..") || f.name.contains("..") || f.name.is_empty() {
            continue;
        }
        let dir = loop_dir.join(&f.dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(&f.name);

        if is_image(&f.name) && f.content.starts_with("data:") {
            if let Some(comma) = f.content.find(',') {
                use base64::Engine;
                if let Ok(bytes) =
                    base64::engine::general_purpose::STANDARD.decode(&f.content[comma + 1..])
                {
                    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
                    continue;
                }
            }
        }

        std::fs::write(&path, &f.content).map_err(|e| e.to_string())?;

        #[cfg(unix)]
        if f.name.ends_with(".sh") {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
        }
    }
    Ok(())
}

fn cmd_list() {
    let loops = read_manifest();
    if loops.is_empty() {
        println!("No loops yet. Create one in the app, or check: {}", loops_base().display());
        return;
    }
    println!("{:<24} {:<16} {:<14} {:>5}  {}", "NAME", "ID", "STATUS", "ITER", "LAST RUN");
    for l in &loops {
        let last = l.last_run.map(relative_time).unwrap_or_else(|| "—".to_string());
        let name = if l.name.is_empty() { l.id.clone() } else { l.name.clone() };
        println!(
            "{:<24} {:<16} {:<14} {:>5}  {}",
            truncate(&name, 24),
            truncate(&l.id, 16),
            l.status,
            l.iteration,
            last
        );
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max - 1).collect();
        out.push('…');
        out
    }
}

fn cmd_run(needle: &str) -> i32 {
    let loops = read_manifest();
    let found = match find_loop(&loops, needle) {
        Some(l) => l,
        None => {
            eprintln!("ralph: no loop matching '{}'", needle);
            return 1;
        }
    };
    let loop_dir = loops_base().join(&found.id);

    // Ensure the loop's files are on disk (a loop created in the GUI but never
    // run only exists in the manifest until now).
    if let Err(e) = write_loop_files(&loop_dir, &found.files) {
        eprintln!("ralph: failed to write loop files: {}", e);
        return 1;
    }

    let script = loop_dir.join("scripts/ralph/ralph.sh");
    if !script.exists() {
        eprintln!("ralph: {} has no scripts/ralph/ralph.sh", found.id);
        return 1;
    }

    println!("▶ Running {} ({})", display_name(found), loop_dir.display());
    // Inherit stdio so output streams straight to the terminal.
    let status = Command::new("bash").arg(&script).current_dir(&loop_dir).status();
    match status {
        Ok(s) => s.code().unwrap_or(1),
        Err(e) => {
            eprintln!("ralph: failed to start loop: {}", e);
            1
        }
    }
}

fn cmd_stop(needle: &str) -> i32 {
    let loops = read_manifest();
    let found = match find_loop(&loops, needle) {
        Some(l) => l,
        None => {
            eprintln!("ralph: no loop matching '{}'", needle);
            return 1;
        }
    };
    let script = loops_base().join(&found.id).join("scripts/ralph/ralph.sh");
    let pattern = script.to_string_lossy().to_string();

    // pkill -f matches the full command line, so this stops the loop whether it
    // was started by the CLI or the app.
    let status = Command::new("pkill").arg("-f").arg(&pattern).status();
    match status {
        Ok(s) if s.success() => {
            println!("■ Stopped {}", display_name(found));
            0
        }
        Ok(_) => {
            println!("No running process found for {}", display_name(found));
            0
        }
        Err(e) => {
            eprintln!("ralph: failed to stop loop: {}", e);
            1
        }
    }
}

fn display_name(l: &LoopWorkspace) -> String {
    if l.name.is_empty() {
        l.id.clone()
    } else {
        format!("{} ({})", l.name, l.id)
    }
}

fn usage() {
    eprintln!(
        "ralph — Ralph Loop Junkie CLI\n\n\
         USAGE:\n\
         \x20 ralph list              List all loops\n\
         \x20 ralph run <loop>        Run a loop (by id or name), streaming output\n\
         \x20 ralph stop <loop>       Stop a running loop\n\n\
         Data dir: {}",
        loops_base().display()
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(|s| s.as_str()) {
        Some("list") | Some("ls") => {
            cmd_list();
            0
        }
        Some("run") => match args.get(1) {
            Some(name) => cmd_run(name),
            None => {
                eprintln!("ralph: run requires a loop id or name");
                1
            }
        },
        Some("stop") => match args.get(1) {
            Some(name) => cmd_stop(name),
            None => {
                eprintln!("ralph: stop requires a loop id or name");
                1
            }
        },
        Some("-h") | Some("--help") | Some("help") | None => {
            usage();
            0
        }
        Some(other) => {
            eprintln!("ralph: unknown command '{}'\n", other);
            usage();
            1
        }
    };
    std::process::exit(code);
}
