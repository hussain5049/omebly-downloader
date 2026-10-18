// Omebly Downloader: the Windows app. The browser extension finds what is on a page; this app downloads it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod engine;

use engine::{Incoming, Manager, Settings};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager as _, State};

type Shared = Arc<Manager>;

#[tauri::command]
fn list(m: State<Shared>) -> Vec<engine::Job> { m.snapshot() }
#[tauri::command]
fn pause(m: State<Shared>, id: u64) { m.pause(id) }
#[tauri::command]
fn resume(m: State<Shared>, id: u64) { m.resume(id) }
#[tauri::command]
fn remove(m: State<Shared>, id: u64) { m.remove(id) }
#[tauri::command]
fn pause_all(m: State<Shared>) { for j in m.snapshot() { if matches!(j.state, engine::State::Downloading | engine::State::Waiting) { m.pause(j.id) } } }
#[tauri::command]
fn resume_all(m: State<Shared>) { for j in m.snapshot() { if j.state == engine::State::Paused { m.resume(j.id) } } }
#[tauri::command]
fn clear_finished(m: State<Shared>) { for j in m.snapshot() { if matches!(j.state, engine::State::Done | engine::State::Failed | engine::State::Protected) { m.remove(j.id) } } }
#[tauri::command]
fn add_links(m: State<Shared>, text: String) -> usize {
    // Links typed or pasted into "Add a link": direct files use 16 parts; pages and streams go to the site reader.
    let items = text.split_whitespace().filter(|u| u.starts_with("http://") || u.starts_with("https://")).take(200).map(|u| {
        let path = url::Url::parse(u).map(|x| x.path().to_ascii_lowercase()).unwrap_or_default();
        let ext = path.rsplit('/').next().and_then(|f| f.rsplit_once('.')).map(|(_, e)| e.to_string()).filter(|e| e.len() <= 5).unwrap_or_default();
        let name = url::Url::parse(u).ok().and_then(|x| x.path_segments().and_then(|mut s| s.next_back().map(|s| s.to_string()))).unwrap_or_default();
        let title = name.rsplit_once('.').map(|(a, _)| a.to_string()).unwrap_or(name);
        let needs_app = ext.is_empty() || ext == "m3u8" || ext == "mpd" || ext == "html" || ext == "php";
        serde_json::json!({ "url": u, "title": title, "kind": if needs_app { "video" } else { "file" }, "needsApp": needs_app, "ext": ext })
    }).collect::<Vec<_>>();
    let inc: Incoming = serde_json::from_value(serde_json::json!({ "page": { "title": "Added links" }, "items": items })).unwrap();
    m.add(inc)
}
#[tauri::command]
fn settings(m: State<Shared>) -> Settings { m.settings.lock().unwrap().clone() }
#[tauri::command]
fn save_settings(m: State<Shared>, s: Settings) {
    // An empty or relative folder keeps the one already set (never a folder next to the app).
    let mut cur = m.settings.lock().unwrap();
    let folder = if std::path::Path::new(s.folder.trim()).is_absolute() { s.folder.trim().to_string() } else { cur.folder.clone() };
    *cur = Settings { folder, connections: s.connections.clamp(1, 32), at_once: s.at_once.clamp(1, 10) };
    drop(cur);
    m.save();
    m.schedule();
}
#[tauri::command]
fn tools(m: State<Shared>) -> serde_json::Value {
    serde_json::json!({ "ytdlp": m.ytdlp.as_ref().map(|p| p.to_string_lossy().to_string()), "ffmpeg": m.ffmpeg_dir.as_ref().map(|p| p.to_string_lossy().to_string()), "version": env!("CARGO_PKG_VERSION") })
}
/// Shows a finished file in Explorer (or opens it).
#[tauri::command]
fn reveal(m: State<Shared>, id: u64, open: bool) {
    let Some(j) = m.snapshot().into_iter().find(|j| j.id == id) else { return };
    let target = if j.saved.is_empty() { j.folder.clone() } else { j.saved.clone() };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("explorer");
        // A program or script is never run from here: its folder is shown instead (Security 324).
        let risky = ["exe", "msi", "bat", "cmd", "com", "scr", "ps1", "vbs", "vbe", "js", "jse", "wsf", "hta", "lnk", "reg", "cpl", "jar", "msix", "appx"];
        let runs = std::path::Path::new(&target).extension().map(|e| risky.contains(&e.to_string_lossy().to_ascii_lowercase().as_str())).unwrap_or(false);
        if open && !runs { cmd.arg(&target); } else { cmd.arg(format!("/select,{target}")); }
        let _ = cmd.creation_flags(0x0800_0000).spawn();
    }
}

/// Takes the messages the extension left in the inbox.
fn take_inbox(m: &Shared) {
    let Ok(dir) = std::fs::read_dir(bridge::inbox()) else { return };
    let mut files: Vec<_> = dir.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "json")).collect();
    files.sort();
    for f in files {
        if let Ok(b) = std::fs::read(&f) {
            if let Ok(inc) = serde_json::from_slice::<Incoming>(&b) { m.add(inc); }
        }
        let _ = std::fs::remove_file(&f);
    }
}

fn main() {
    if bridge::started_by_browser() {
        bridge::run();
        return;
    }
    let mut builder = tauri::Builder::default();
    // One app at a time; a test copy (OMEBLY_DATA_DIR) stays separate from the real one.
    if std::env::var_os("OMEBLY_DATA_DIR").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Opened again (by the extension or by hand): show the window and take any new downloads.
            if let Some(w) = app.get_webview_window("main") { let _ = w.unminimize(); let _ = w.set_focus(); }
            if let Some(m) = app.try_state::<Shared>() { take_inbox(&m); }
        }));
    }
    builder
        .setup(|app| {
            let downloads = std::env::var_os("OMEBLY_DOWNLOADS").map(std::path::PathBuf::from).or_else(|| app.path().download_dir().ok()).unwrap_or_else(bridge::data_dir);
            // Leftovers from a crash: cookie files for downloads that ended are removed at start (Security 324).
            if let Ok(dir) = std::fs::read_dir(bridge::data_dir()) { for e in dir.flatten() { if e.file_name().to_string_lossy().starts_with("cookies-") { let _ = std::fs::remove_file(e.path()); } } }
            let m = Manager::new(bridge::data_dir(), downloads);
            app.manage(m.clone());
            if std::env::var_os("OMEBLY_DATA_DIR").is_none() { bridge::register(); } // tests leave the browsers alone
            take_inbox(&m);
            m.schedule();
            // The screen gets the list whenever it changes (at most a few times a second); the inbox is checked too.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut tick = 0u32;
                loop {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    if m.dirty.swap(false, Ordering::Relaxed) { let _ = handle.emit("jobs", m.snapshot()); }
                    tick += 1;
                    if tick % 4 == 0 { take_inbox(&m); }
                    if tick % 40 == 0 { m.save(); }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![list, pause, resume, remove, pause_all, resume_all, clear_finished, add_links, settings, save_settings, tools, reveal])
        .run(tauri::generate_context!())
        .expect("Omebly Downloader could not start");
}
