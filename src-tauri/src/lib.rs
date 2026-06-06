use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};

pub struct LoopManager {
    processes: Arc<Mutex<HashMap<String, u32>>>,
}

/// Base directory that holds all loop workspaces and the manifest.
/// Lives under the OS app-data dir, e.g. on macOS:
///   ~/Library/Application Support/<bundle-id>/loops
fn loops_base(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {}", e))?;
    Ok(dir.join("loops"))
}

#[derive(serde::Deserialize)]
struct FileSpec {
    dir: String,
    name: String,
    content: String,
}

#[derive(serde::Serialize)]
struct FileOut {
    dir: String,
    name: String,
    content: String,
}

/// Reject path components that could escape the loop directory.
fn safe_component(s: &str) -> bool {
    !s.is_empty() && !s.contains("..") && !s.starts_with('/') && !s.contains('\0')
}

/// MIME type for an image filename, or None for non-images.
fn image_mime(name: &str) -> Option<&'static str> {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

#[tauri::command]
fn write_loop_files(
    app: AppHandle,
    loop_id: String,
    files: Vec<FileSpec>,
) -> Result<String, String> {
    let loop_dir = loops_base(&app)?.join(&loop_id);
    std::fs::create_dir_all(&loop_dir).map_err(|e| e.to_string())?;

    for f in &files {
        if !safe_component(&f.dir) || !safe_component(&f.name) {
            return Err(format!("unsafe file path: {}/{}", f.dir, f.name));
        }
        let dir = loop_dir.join(&f.dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(&f.name);

        // Images arrive as data URLs — decode the base64 payload to real bytes
        // so a genuine image file lands on disk. Everything else is text.
        if image_mime(&f.name).is_some() {
            if let Some(comma) = f.content.find(",") {
                if f.content.starts_with("data:") {
                    use base64::Engine;
                    let payload = &f.content[comma + 1..];
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(payload)
                        .map_err(|e| e.to_string())?;
                    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
                    continue;
                }
            }
            // Not a data URL (e.g. an SVG stored as text) — write as-is.
            std::fs::write(&path, &f.content).map_err(|e| e.to_string())?;
            continue;
        }

        std::fs::write(&path, &f.content).map_err(|e| e.to_string())?;

        #[cfg(unix)]
        if f.name.ends_with(".sh") {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(loop_dir.to_string_lossy().into_owned())
}

/// Enumerate the files actually on disk under plans/ and scripts/ralph/ so the
/// UI reflects whatever the loop created or changed.
#[tauri::command]
fn read_loop_files(app: AppHandle, loop_id: String) -> Result<Vec<FileOut>, String> {
    let loop_dir = loops_base(&app)?.join(&loop_id);
    let mut out = Vec::new();

    for sub in ["plans", "scripts/ralph"] {
        let dir = loop_dir.join(sub);
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // dir may not exist yet
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            // Images come back as data URLs so the UI can render them; other
            // files are read as text.
            let content = if let Some(mime) = image_mime(&name) {
                match std::fs::read(&path) {
                    Ok(bytes) => {
                        use base64::Engine;
                        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                        format!("data:{};base64,{}", mime, b64)
                    }
                    Err(_) => continue,
                }
            } else {
                std::fs::read_to_string(&path).unwrap_or_default()
            };
            out.push(FileOut {
                dir: sub.to_string(),
                name,
                content,
            });
        }
    }

    Ok(out)
}

#[tauri::command]
fn rename_loop_file(
    app: AppHandle,
    loop_id: String,
    dir: String,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    if !safe_component(&dir) || !safe_component(&old_name) || !safe_component(&new_name) {
        return Err("unsafe file path".to_string());
    }
    let base = loops_base(&app)?.join(&loop_id).join(&dir);
    let from = base.join(&old_name);
    let to = base.join(&new_name);
    match std::fs::rename(&from, &to) {
        Ok(_) => {
            #[cfg(unix)]
            if new_name.ends_with(".sh") {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&to, std::fs::Permissions::from_mode(0o755));
            }
            Ok(())
        }
        // Not on disk yet (e.g. added but never run) — the rename in app state
        // is enough; the file will be written under its new name on next run.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn delete_loop_file(app: AppHandle, loop_id: String, dir: String, name: String) -> Result<(), String> {
    if !safe_component(&dir) || !safe_component(&name) {
        return Err(format!("unsafe file path: {}/{}", dir, name));
    }
    let path = loops_base(&app)?.join(&loop_id).join(&dir).join(&name);
    match std::fs::remove_file(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn load_loops(app: AppHandle) -> Result<String, String> {
    let manifest = loops_base(&app)?.join("loops.json");
    match std::fs::read_to_string(&manifest) {
        Ok(contents) => Ok(contents),
        // No manifest yet (first launch) — signal with "null" so the
        // frontend knows to seed defaults rather than treating it as empty.
        Err(_) => Ok("null".to_string()),
    }
}

#[tauri::command]
fn save_loops(app: AppHandle, loops: String) -> Result<(), String> {
    let loops_dir = loops_base(&app)?;
    std::fs::create_dir_all(&loops_dir).map_err(|e| e.to_string())?;
    std::fs::write(loops_dir.join("loops.json"), &loops).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_loop_dir(app: AppHandle, loop_id: String) -> Result<(), String> {
    let loop_dir = loops_base(&app)?.join(&loop_id);
    match std::fs::remove_dir_all(&loop_dir) {
        Ok(_) => Ok(()),
        // Not existing on disk (e.g. never run) is fine.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn run_loop(
    loop_id: String,
    loop_dir: String,
    app: AppHandle,
    manager: State<LoopManager>,
) -> Result<(), String> {
    let script_path = format!("{}/scripts/ralph/ralph.sh", loop_dir);

    let mut child = Command::new("bash")
        .arg(&script_path)
        .current_dir(&loop_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start script: {}", e))?;

    let pid = child.id();
    let stdout = child.stdout.take().expect("stdout pipe");
    let stderr = child.stderr.take().expect("stderr pipe");

    manager.processes.lock().unwrap().insert(loop_id.clone(), pid);
    let processes = Arc::clone(&manager.processes);

    // Stream stdout to frontend
    let app1 = app.clone();
    let lid1 = loop_id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().flatten() {
            app1.emit(
                "loop-output",
                serde_json::json!({ "loopId": lid1, "line": line, "stream": "stdout" }),
            )
            .ok();
        }
    });

    // Stream stderr to frontend
    let app2 = app.clone();
    let lid2 = loop_id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().flatten() {
            app2.emit(
                "loop-output",
                serde_json::json!({ "loopId": lid2, "line": line, "stream": "stderr" }),
            )
            .ok();
        }
    });

    // Wait for process exit, then notify frontend
    let app3 = app.clone();
    let lid3 = loop_id.clone();
    std::thread::spawn(move || {
        let mut ch = child;
        let code = ch.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        processes.lock().unwrap().remove(&lid3);
        app3.emit(
            "loop-ended",
            serde_json::json!({ "loopId": lid3, "exitCode": code }),
        )
        .ok();
    });

    Ok(())
}

#[tauri::command]
fn stop_loop(loop_id: String, manager: State<LoopManager>) -> Result<(), String> {
    let map = manager.processes.lock().unwrap();
    if let Some(&pid) = map.get(&loop_id) {
        // SIGTERM to the process; ralph.sh's child processes will also receive it
        // since bash propagates signals to its process group
        Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Reflect loop counts in the menu-bar tray: a compact title next to the icon,
/// a full tooltip, and labeled rows in the dropdown menu.
#[tauri::command]
fn set_tray_status(
    app: AppHandle,
    total: usize,
    running: usize,
    review: usize,
) -> Result<(), String> {
    let tray = match app.tray_by_id("main-tray") {
        Some(t) => t,
        None => return Ok(()),
    };

    // Compact at-a-glance title: total loop count, plus markers for the
    // actionable states (▶ running, ⚠ needs review).
    let mut title = format!("{}", total);
    if running > 0 {
        title.push_str(&format!(" {}▶", running));
    }
    if review > 0 {
        title.push_str(&format!(" {}⚠", review));
    }
    tray.set_title(Some(title.as_str())).map_err(|e| e.to_string())?;

    // Hover tooltip with the full breakdown.
    let tip = format!(
        "Ralph · {} loop{} · {} running · {} need review",
        total,
        if total == 1 { "" } else { "s" },
        running,
        review
    );
    let _ = tray.set_tooltip(Some(&tip));

    // Rebuild the menu so the labeled counts stay current.
    let info_total = MenuItem::with_id(
        &app,
        "info_total",
        format!("{} loop{}", total, if total == 1 { "" } else { "s" }),
        false,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let info_running = MenuItem::with_id(&app, "info_running", format!("{} running", running), false, None::<&str>)
        .map_err(|e| e.to_string())?;
    let info_review = MenuItem::with_id(&app, "info_review", format!("{} need review", review), false, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep1 = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let sep2 = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let open_item = MenuItem::with_id(&app, "open", "Open Ralph", true, None::<&str>).map_err(|e| e.to_string())?;
    let quit_item = MenuItem::with_id(&app, "quit", "Quit Ralph", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(
        &app,
        &[&info_total, &info_running, &info_review, &sep1, &open_item, &sep2, &quit_item],
    )
    .map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;

    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// A GUI app launched from Finder/Dock inherits a minimal PATH and can't find
/// tools like `claude`, `node`, or `python3` that live in the user's shell PATH.
/// Capture the login shell's PATH and apply it so loops can run those CLIs.
#[cfg(target_family = "unix")]
fn inherit_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // `-lc` sources the user's login profile without needing a TTY.
    if let Ok(out) = Command::new(&shell)
        .args(["-lc", "printf %s \"$PATH\""])
        .output()
    {
        if out.status.success() {
            if let Ok(path) = String::from_utf8(out.stdout) {
                let path = path.trim();
                if !path.is_empty() {
                    std::env::set_var("PATH", path);
                }
            }
        }
    }

    // Safety net: make sure the usual locations are present even if the above
    // came back thin.
    if let Ok(home) = std::env::var("HOME") {
        let current = std::env::var("PATH").unwrap_or_default();
        let mut parts: Vec<String> = current.split(':').map(|s| s.to_string()).collect();
        for extra in [
            format!("{home}/.local/bin"),
            "/usr/local/bin".to_string(),
            "/opt/homebrew/bin".to_string(),
        ] {
            if !parts.iter().any(|p| p == &extra) {
                parts.push(extra);
            }
        }
        std::env::set_var("PATH", parts.join(":"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_family = "unix")]
    inherit_shell_path();

    tauri::Builder::default()
        .manage(LoopManager {
            processes: Arc::new(Mutex::new(HashMap::new())),
        })
        .invoke_handler(tauri::generate_handler![
            write_loop_files,
            read_loop_files,
            delete_loop_file,
            rename_loop_file,
            run_loop,
            stop_loop,
            load_loops,
            save_loops,
            delete_loop_dir,
            set_tray_status
        ])
        .setup(|app| {
            let open_item = MenuItem::with_id(app, "open", "Open Ralph", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Ralph", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &separator, &quit_item])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(tauri::include_image!("icons/tray.png"))
                .icon_as_template(true)
                .tooltip("Ralph Loop Junkie")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left-click the icon to reveal the window.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it to the tray instead of quitting, so
            // running loops keep going. Use "Quit Ralph" in the tray to exit.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
