//! The link between the browser extension and the app (Chrome's "native messaging"): the browser starts this
//! program with the extension's address; it reads one message, puts it in the app's inbox and makes sure the app
//! is open. Only Omebly Downloader's own extension is allowed (the address is checked here and by the browser).

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;

pub const HOST: &str = "com.omebly.downloader";
pub const EXTENSION_ID: &str = "cjaaiapbiobjhmbhdikahgkokpffpoij";
const MAX_MESSAGE: u32 = 8 * 1024 * 1024;

pub fn data_dir() -> PathBuf {
    // OMEBLY_DATA_DIR: a separate place for tests, so they never touch the real list or settings.
    if let Some(d) = std::env::var_os("OMEBLY_DATA_DIR") { return PathBuf::from(d); }
    PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("Omebly Downloader")
}
pub fn inbox() -> PathBuf { data_dir().join("inbox") }

/// True when the browser started us as the native messaging host.
pub fn started_by_browser() -> bool {
    std::env::args().skip(1).any(|a| a.starts_with("chrome-extension://"))
}

fn read_message() -> Option<serde_json::Value> {
    let mut len = [0u8; 4];
    std::io::stdin().read_exact(&mut len).ok()?;
    let n = u32::from_le_bytes(len);
    if n == 0 || n > MAX_MESSAGE { return None; }
    let mut buf = vec![0u8; n as usize];
    std::io::stdin().read_exact(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}
fn write_message(v: &serde_json::Value) {
    let body = serde_json::to_vec(v).unwrap_or_default();
    let mut out = std::io::stdout();
    let _ = out.write_all(&(body.len() as u32).to_le_bytes());
    let _ = out.write_all(&body);
    let _ = out.flush();
}

pub fn run() {
    let origin_ok = std::env::args().skip(1).any(|a| a == format!("chrome-extension://{EXTENSION_ID}/"));
    let Some(msg) = read_message() else { return };
    if !origin_ok {
        write_message(&serde_json::json!({ "ok": false, "error": "Only the Omebly Downloader extension can use this app." }));
        return;
    }
    match msg.get("type").and_then(|t| t.as_str()) {
        Some("hello") => write_message(&serde_json::json!({ "ok": true, "app": env!("CARGO_PKG_VERSION") })),
        Some("download") => {
            let dir = inbox();
            let _ = std::fs::create_dir_all(&dir);
            let name = format!("{}-{}.json", super::engine::now(), std::process::id());
            let ok = std::fs::write(dir.join(&name), serde_json::to_vec(&msg).unwrap_or_default()).is_ok();
            // Open the app (or wake the one already open: it takes the message from the inbox).
            // (Under test the app is already open and reads the inbox itself.)
            if let (Ok(me), None) = (std::env::current_exe(), std::env::var_os("OMEBLY_DATA_DIR")) {
                let mut cmd = Command::new(me);
                cmd.arg("--inbox");
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x0000_0008 | 0x0000_0200); // detached, its own process group
                }
                let _ = cmd.spawn();
            }
            write_message(&serde_json::json!({ "ok": ok }));
        }
        _ => write_message(&serde_json::json!({ "ok": false, "error": "Unknown request" })),
    }
}

/// Tells Chrome, Edge, Brave and Chromium where this app is (for the current user only), so the extension can reach it.
pub fn register() {
    let Ok(exe) = std::env::current_exe() else { return };
    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let manifest = dir.join(format!("{HOST}.json"));
    let body = serde_json::json!({
        "name": HOST,
        "description": "Omebly Downloader",
        "path": exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    });
    if std::fs::write(&manifest, serde_json::to_vec_pretty(&body).unwrap_or_default()).is_err() { return; }
    #[cfg(windows)]
    for browser in ["Google\\Chrome", "Microsoft\\Edge", "BraveSoftware\\Brave-Browser", "Chromium"] {
        use std::os::windows::process::CommandExt;
        let key = format!("HKCU\\Software\\{browser}\\NativeMessagingHosts\\{HOST}");
        let _ = Command::new("reg").args(["add", &key, "/ve", "/t", "REG_SZ", "/d"]).arg(&manifest).arg("/f").creation_flags(0x0800_0000).output();
    }
}
