//! The download list: what is waiting, downloading, paused and finished. Up to three run at once; each direct file
//! uses up to 16 connections. The list is kept in the app's folder so it survives a restart.

pub mod http;
pub mod sites;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State { Waiting, Downloading, Paused, Done, Failed, Protected }

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Cookie { pub domain: String, pub path: String, pub name: String, pub value: String, pub secure: bool, #[serde(default)] pub expires: f64, #[serde(default, rename = "hostOnly")] pub host_only: bool }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub id: u64,
    /// "file" (direct, 16 parts) or "site" (a stream or video site, through yt-dlp)
    pub how: String,
    pub kind: String,
    pub url: String,
    pub title: String,
    pub group: String,
    pub site: String,
    pub folder: String,
    pub name: String,
    pub ext: String,
    #[serde(default)] pub height: u32,
    #[serde(default)] pub languages: Vec<String>,
    #[serde(default)] pub subtitles: Vec<String>,
    pub state: State,
    #[serde(default)] pub error: String,
    #[serde(default)] pub saved: String,
    #[serde(default)] pub done: u64,
    #[serde(default)] pub total: u64,
    #[serde(default)] pub speed: f64,
    #[serde(default)] pub eta: f64,
    #[serde(default)] pub parts: Vec<f32>,
    #[serde(default)] pub connections: usize,
    #[serde(default)] pub phase: String,
    pub added: u64,
    #[serde(default)] pub finished: u64,
    /// Sent by the browser for this download only; never written to disk.
    #[serde(skip)] pub headers: Vec<(String, String)>,
    #[serde(skip)] pub cookies: Vec<Cookie>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings { pub folder: String, pub connections: usize, pub at_once: usize }

/// What the extension (or the Add a link box) sends.
#[derive(Debug, Deserialize)]
pub struct Incoming {
    #[serde(default)] pub page: PageInfo,
    pub items: Vec<IncomingItem>,
    #[serde(default)] pub headers: HashMap<String, String>,
    #[serde(default)] pub cookies: Vec<Cookie>,
}
#[derive(Debug, Default, Deserialize)]
pub struct PageInfo { #[serde(default)] #[allow(dead_code)] pub url: String, #[serde(default)] pub title: String }
#[derive(Debug, Deserialize)]
pub struct IncomingItem {
    pub url: String,
    #[serde(default)] pub title: String,
    #[serde(default)] pub kind: String,
    #[serde(default, rename = "needsApp")] pub needs_app: bool,
    #[serde(default)] pub ext: String,
    #[serde(default)] pub height: u32,
    #[serde(default)] pub name: String,
    #[serde(default)] pub folder: String,
    #[serde(default)] pub languages: Vec<String>,
    #[serde(default)] pub subtitles: Vec<String>,
}

pub fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }

/// A file or folder name Windows accepts.
pub fn safe_name(s: &str) -> String {
    let cleaned: String = s.chars().map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { ' ' } else { c }).collect();
    let words = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut t: String = words.trim_matches(|c: char| c == '.' || c == ' ').chars().take(120).collect();
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3"];
    if t.is_empty() || reserved.contains(&t.to_ascii_uppercase().as_str()) { t = format!("Download {t}").trim().to_string(); }
    t
}

pub struct Manager {
    pub jobs: Mutex<Vec<Job>>,
    pub settings: Mutex<Settings>,
    stops: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    next_id: AtomicU64,
    data_dir: PathBuf,
    pub dirty: AtomicBool,
    client: reqwest::Client,
    pub ytdlp: Option<PathBuf>,
    pub ffmpeg_dir: Option<PathBuf>,
}

impl Manager {
    pub fn new(data_dir: PathBuf, downloads: PathBuf) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&data_dir);
        let mut jobs: Vec<Job> = std::fs::read(data_dir.join("downloads.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        // A download that was running when the app closed waits to be continued.
        for j in jobs.iter_mut() { if j.state == State::Downloading { j.state = State::Paused; j.speed = 0.0; } }
        let settings = std::fs::read(data_dir.join("settings.json")).ok().and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(Settings { folder: downloads.join("Omebly").to_string_lossy().to_string(), connections: 16, at_once: 3 });
        let next = jobs.iter().map(|j| j.id).max().unwrap_or(0) + 1;
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36")
            .connect_timeout(Duration::from_secs(20))
            .pool_max_idle_per_host(32)
            .build()
            .expect("http client");
        Arc::new(Manager {
            jobs: Mutex::new(jobs), settings: Mutex::new(settings), stops: Mutex::new(HashMap::new()), next_id: AtomicU64::new(next),
            data_dir, dirty: AtomicBool::new(true), client, ytdlp: find_tool("yt-dlp"), ffmpeg_dir: find_tool("ffmpeg").and_then(|p| p.parent().map(Path::to_path_buf)),
        })
    }

    pub fn save(&self) {
        if let Ok(b) = serde_json::to_vec_pretty(&*self.jobs.lock().unwrap()) { let _ = std::fs::write(self.data_dir.join("downloads.json"), b); }
        if let Ok(b) = serde_json::to_vec_pretty(&*self.settings.lock().unwrap()) { let _ = std::fs::write(self.data_dir.join("settings.json"), b); }
    }
    fn touch(&self) { self.dirty.store(true, Ordering::Relaxed); }

    /// Adds what the browser sent: one entry per item, in a folder named after the page, numbered in page order
    /// when there are several videos or audio files (so a course's lessons stay in order).
    pub fn add(self: &Arc<Self>, inc: Incoming) -> usize {
        let base = PathBuf::from(&self.settings.lock().unwrap().folder);
        let group = safe_name(if inc.page.title.is_empty() { "Downloads" } else { &inc.page.title });
        let mut headers: Vec<(String, String)> = Vec::new();
        if let Some(r) = inc.headers.get("referer").filter(|r| r.starts_with("http")) { headers.push(("Referer".into(), r.clone())); }
        if let Some(u) = inc.headers.get("userAgent").filter(|u| !u.is_empty() && u.len() < 400) { headers.push(("User-Agent".into(), u.clone())); }
        let media = inc.items.iter().filter(|i| i.kind == "video" || i.kind == "audio").count();
        let mut added = 0;
        for (n, it) in inc.items.into_iter().enumerate() {
            if !(it.url.starts_with("http://") || it.url.starts_with("https://")) { continue; }
            let site = url::Url::parse(&it.url).ok().and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string())).unwrap_or_default();
            let title = if it.title.is_empty() { "Download".to_string() } else { it.title.clone() };
            let folder = if it.folder.is_empty() { base.join(&group) } else { base.join(safe_name(&it.folder)) };
            let numbered = media > 1 && (it.kind == "video" || it.kind == "audio");
            let plain = strip_number(&title);
            let name = if !it.name.is_empty() { safe_name(&it.name) } else if numbered { safe_name(&format!("{:02} {}", n + 1, plain)) } else { safe_name(&title) };
            let ext = it.ext.trim_start_matches('.').to_ascii_lowercase();
            let how = if it.needs_app || ext == "m3u8" || ext == "mpd" { "site" } else { "file" };
            let id = self.next_id.fetch_add(1, Ordering::Relaxed);
            let cookies = inc.cookies.iter().filter(|c| cookie_matches(c, &site)).cloned().collect();
            self.jobs.lock().unwrap().push(Job {
                id, how: how.into(), kind: if it.kind.is_empty() { "file".into() } else { it.kind.clone() }, url: it.url.clone(), title, group: group.clone(), site,
                folder: folder.to_string_lossy().to_string(), name, ext, height: it.height, languages: it.languages, subtitles: it.subtitles,
                state: State::Waiting, error: String::new(), saved: String::new(), done: 0, total: 0, speed: 0.0, eta: 0.0, parts: vec![0.0; 16],
                connections: 0, phase: String::new(), added: now(), finished: 0, headers: headers.clone(), cookies,
            });
            added += 1;
        }
        self.touch();
        self.save();
        self.schedule();
        added
    }

    /// Starts waiting downloads while fewer than the allowed number run.
    pub fn schedule(self: &Arc<Self>) {
        let at_once = self.settings.lock().unwrap().at_once.max(1);
        let mut start = Vec::new();
        {
            let mut jobs = self.jobs.lock().unwrap();
            let running = jobs.iter().filter(|j| j.state == State::Downloading).count();
            for j in jobs.iter_mut().filter(|j| j.state == State::Waiting).take(at_once.saturating_sub(running)) {
                j.state = State::Downloading;
                j.error.clear();
                start.push(j.clone());
            }
        }
        for job in start { self.clone().run(job); }
        self.touch();
    }

    fn update(&self, id: u64, f: impl FnOnce(&mut Job)) {
        if let Some(j) = self.jobs.lock().unwrap().iter_mut().find(|j| j.id == id) { f(j); }
        self.touch();
    }

    fn run(self: Arc<Self>, job: Job) {
        let stop = Arc::new(AtomicBool::new(false));
        self.stops.lock().unwrap().insert(job.id, stop.clone());
        let connections = self.settings.lock().unwrap().connections.clamp(1, 32);
        tauri::async_runtime::spawn(async move {
            let id = job.id;
            let result = if job.how == "file" {
                let dest = PathBuf::from(&job.folder).join(format!("{}.{}", job.name, if job.ext.is_empty() { "bin" } else { &job.ext }));
                let mut headers = job.headers.clone();
                if let Some(c) = cookie_header(&job.cookies) { headers.push(("Cookie".into(), c)); }
                let req = http::Request { url: job.url.clone(), dest, headers, connections };
                let me = self.clone();
                http::download(&self.client, &req, stop.clone(), move |p| me.update(id, |j| {
                    j.done = p.done; j.total = p.total; j.speed = p.speed; j.parts = p.parts; j.connections = p.connections;
                    j.eta = if p.speed > 1.0 && p.total > p.done { (p.total - p.done) as f64 / p.speed } else { 0.0 };
                })).await
            } else {
                self.clone().run_site(&job, stop.clone(), connections).await
            };
            self.stops.lock().unwrap().remove(&id);
            self.update(id, |j| {
                j.speed = 0.0; j.connections = 0;
                match &result {
                    Ok(path) => { j.state = State::Done; j.saved = path.to_string_lossy().to_string(); j.finished = now(); j.parts = vec![1.0; 16]; if j.total == 0 { j.total = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0); } j.done = j.total; }
                    Err(e) if e == "paused" => { if j.state == State::Downloading { j.state = State::Paused; } }
                    Err(e) if e.starts_with("Protected") => { j.state = State::Protected; j.error = e.clone(); }
                    Err(e) => { j.state = State::Failed; j.error = e.clone(); }
                }
            });
            self.save();
            self.schedule();
        });
    }

    async fn run_site(self: Arc<Self>, job: &Job, stop: Arc<AtomicBool>, connections: usize) -> Result<PathBuf, String> {
        let Some(ytdlp) = self.ytdlp.clone() else { return Err("The site reader (yt-dlp) is missing. Reinstall Omebly Downloader.".into()) };
        sites::check_stream(&self.client, &job.url, &job.headers).await?;
        let cookies_file = if job.cookies.is_empty() { None } else { write_cookies(&self.data_dir, job.id, &job.cookies) };
        let req = sites::SiteRequest {
            url: job.url.clone(), folder: PathBuf::from(&job.folder), name: job.name.clone(), height: job.height, audio_only: job.kind == "audio",
            languages: job.languages.clone(), subtitles: job.subtitles.clone(), headers: job.headers.clone(), cookies_file: cookies_file.clone(), connections,
        };
        let ffmpeg = self.ffmpeg_dir.clone();
        let me = self.clone();
        let id = job.id;
        let result = tauri::async_runtime::spawn_blocking(move || {
            sites::download(&ytdlp, ffmpeg.as_deref(), &req, stop, |p| me.update(id, |j| {
                j.phase = p.phase.clone();
                if p.phase == "joining" { j.speed = 0.0; return; }
                j.done = p.done; j.total = p.total.max(p.done); j.speed = p.speed; j.eta = p.eta;
                let f = if p.fragments.1 > 0 { p.fragments.0 as f32 / p.fragments.1 as f32 } else if p.total > 0 { p.done as f32 / p.total as f32 } else { 0.0 };
                j.parts = (0..16).map(|s| (f * 16.0 - s as f32).clamp(0.0, 1.0)).collect();
                j.connections = if p.fragments.1 > 0 { connections } else { 1 };
            }))
        }).await.map_err(|e| e.to_string())?;
        if let Some(c) = cookies_file { let _ = std::fs::remove_file(c); }
        result
    }

    pub fn pause(&self, id: u64) {
        if let Some(s) = self.stops.lock().unwrap().get(&id) { s.store(true, Ordering::Relaxed); }
        self.update(id, |j| if j.state == State::Downloading || j.state == State::Waiting { j.state = State::Paused; j.speed = 0.0; });
        self.save();
    }
    pub fn resume(self: &Arc<Self>, id: u64) {
        self.update(id, |j| if matches!(j.state, State::Paused | State::Failed) { j.state = State::Waiting; j.error.clear(); });
        self.schedule();
    }
    pub fn remove(&self, id: u64) {
        self.pause(id);
        self.jobs.lock().unwrap().retain(|j| j.id != id);
        self.touch();
        self.save();
    }
    pub fn snapshot(&self) -> Vec<Job> { self.jobs.lock().unwrap().clone() }
}

fn strip_number(t: &str) -> String {
    let s = t.trim_start();
    let digits = s.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 && digits <= 3 {
        let rest = &s[digits..];
        let rest2 = rest.trim_start_matches([' ', '.', ')', ':', '-', '–']);
        if rest2.len() < rest.len() && !rest2.is_empty() { return rest2.to_string(); }
    }
    t.to_string()
}

fn cookie_matches(c: &Cookie, host: &str) -> bool {
    let d = c.domain.trim_start_matches('.');
    !d.is_empty() && (host == d || host.ends_with(&format!(".{d}")))
}
fn cookie_header(cookies: &[Cookie]) -> Option<String> {
    if cookies.is_empty() { return None; }
    Some(cookies.iter().map(|c| format!("{}={}", c.name, c.value)).collect::<Vec<_>>().join("; "))
}
/// A cookies file for yt-dlp (Netscape format), only for this download, deleted when it ends.
fn write_cookies(dir: &Path, id: u64, cookies: &[Cookie]) -> Option<PathBuf> {
    let mut s = String::from("# Netscape HTTP Cookie File\n");
    for c in cookies {
        let domain = if c.host_only { c.domain.trim_start_matches('.').to_string() } else if c.domain.starts_with('.') { c.domain.clone() } else { format!(".{}", c.domain) };
        let clean = |v: &str| v.replace(['\t', '\n', '\r'], "");
        s.push_str(&format!("{}\t{}\t{}\t{}\t{}\t{}\t{}\n", clean(&domain), if c.host_only { "FALSE" } else { "TRUE" }, clean(&c.path), if c.secure { "TRUE" } else { "FALSE" }, c.expires.max(0.0) as u64, clean(&c.name), clean(&c.value)));
    }
    let p = dir.join(format!("cookies-{id}.txt"));
    std::fs::write(&p, s).ok().map(|_| p)
}

/// Finds yt-dlp or FFmpeg: next to the app first, then where Windows finds programs.
pub fn find_tool(name: &str) -> Option<PathBuf> {
    let exe = format!("{name}.exe");
    if let Ok(me) = std::env::current_exe() {
        if let Some(dir) = me.parent() {
            for p in [dir.join(&exe), dir.join("tools").join(&exe), dir.join("resources").join(&exe)] { if p.exists() { return Some(p); } }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&path) { let p = d.join(&exe); if p.exists() { return Some(p); } }
    }
    // Installed with winget but not on this program's PATH yet.
    let packages = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Microsoft").join("WinGet").join("Packages");
    for entry in std::fs::read_dir(&packages).ok()?.flatten() {
        let n = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if !n.contains(name) { continue; }
        let direct = entry.path().join(&exe);
        if direct.exists() { return Some(direct); }
        for sub in std::fs::read_dir(entry.path()).ok()?.flatten() {
            for p in [sub.path().join("bin").join(&exe), sub.path().join(&exe)] { if p.exists() { return Some(p); } }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_are_safe_for_windows() {
        assert_eq!(safe_name("a/b:c*?\"<>|d"), "a b c d");
        assert_eq!(safe_name("CON"), "Download CON");
        assert_eq!(safe_name("  .hidden. "), "hidden");
    }
    #[test]
    fn lesson_numbers_are_not_repeated() {
        assert_eq!(strip_number("3. Components and props"), "Components and props");
        assert_eq!(strip_number("2026 plans"), "2026 plans");
        assert_eq!(strip_number("Intro"), "Intro");
    }
}
