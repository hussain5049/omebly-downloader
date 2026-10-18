//! Direct downloads at full speed: the file is cut into chunks and up to 16 connections fetch them at once (as IDM
//! does). Finished chunks are remembered next to the file, so a paused or broken download continues where it stopped.

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_RANGE, RANGE};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::fs::FileExt;
#[cfg(unix)]
use std::os::unix::fs::FileExt;

/// How a download is going, sent to the screen a few times a second.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Progress {
    pub done: u64,
    pub total: u64,
    pub speed: f64,
    /// 16 numbers from 0 to 1: how full each part of the bar is.
    pub parts: Vec<f32>,
    pub connections: usize,
}

#[derive(Serialize, Deserialize)]
struct State {
    url: String,
    total: u64,
    chunk: u64,
    done: Vec<bool>,
}

pub struct Request {
    pub url: String,
    pub dest: PathBuf,
    pub headers: Vec<(String, String)>,
    pub connections: usize,
}

const SEGMENTS: usize = 16;

fn header_map(headers: &[(String, String)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
            map.insert(name, value);
        }
    }
    map
}

fn temp_of(dest: &Path) -> PathBuf {
    let mut p = dest.as_os_str().to_owned();
    p.push(".omebly-part");
    PathBuf::from(p)
}
fn state_of(dest: &Path) -> PathBuf {
    let mut p = dest.as_os_str().to_owned();
    p.push(".omebly-state");
    PathBuf::from(p)
}

/// Picks a free name: "Lesson.mp4", then "Lesson (2).mp4", …
pub fn unique(dest: &Path) -> PathBuf {
    if !dest.exists() {
        return dest.to_path_buf();
    }
    let stem = dest.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = dest.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for n in 2..10_000 {
        let p = dest.with_file_name(format!("{stem} ({n}){ext}"));
        if !p.exists() {
            return p;
        }
    }
    dest.to_path_buf()
}

/// Downloads the file; returns where it was saved. `stop` pauses it (the finished chunks are kept).
pub async fn download(
    client: &reqwest::Client,
    req: &Request,
    stop: Arc<AtomicBool>,
    report: impl Fn(Progress) + Send + Sync + 'static,
) -> Result<PathBuf, String> {
    let headers = header_map(&req.headers);
    // Does the server let us fetch pieces? Ask for the first byte.
    let probe = client
        .get(&req.url)
        .headers(headers.clone())
        .header(RANGE, "bytes=0-0")
        .send()
        .await
        .map_err(|e| format!("Could not reach the site: {e}"))?;
    if !probe.status().is_success() {
        return Err(format!("The site answered {}", probe.status()));
    }
    let total = probe
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit('/').next())
        .and_then(|v| v.parse::<u64>().ok());
    let ranged = probe.status().as_u16() == 206 && total.is_some();
    drop(probe);
    if let Some(dir) = req.dest.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not make the folder: {e}"))?;
    }
    if !ranged {
        return single(client, req, headers, stop, report).await;
    }
    let total = total.unwrap_or(0);
    let temp = temp_of(&req.dest);
    let state_path = state_of(&req.dest);

    // Chunks of 1 to 8 MB, several per connection, so a fast connection takes more of them.
    let chunk = (total / (req.connections.max(1) as u64 * 8)).clamp(1 << 20, 8 << 20);
    let count = total.div_ceil(chunk) as usize;
    let mut state = fs::read(&state_path)
        .ok()
        .and_then(|b| serde_json::from_slice::<State>(&b).ok())
        .filter(|s| s.total == total && s.chunk == chunk && s.done.len() == count && temp.exists())
        .unwrap_or(State { url: req.url.clone(), total, chunk, done: vec![false; count] });
    if !temp.exists() {
        let f = File::create(&temp).map_err(|e| format!("Could not create the file: {e}"))?;
        f.set_len(total).map_err(|e| format!("Not enough room on the disk: {e}"))?;
        state.done = vec![false; count];
    }
    let queue: Arc<Mutex<VecDeque<usize>>> = Arc::new(Mutex::new((0..count).filter(|&i| !state.done[i]).collect()));
    let done_flags: Arc<Vec<AtomicBool>> = Arc::new(state.done.iter().map(|&d| AtomicBool::new(d)).collect());
    let chunk_bytes: Arc<Vec<AtomicU64>> = Arc::new(
        (0..count).map(|i| AtomicU64::new(if state.done[i] { chunk.min(total - i as u64 * chunk) } else { 0 })).collect(),
    );
    let failed: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let workers = req.connections.clamp(1, 32).min(queue.lock().unwrap().len().max(1));

    let mut tasks = Vec::new();
    for _ in 0..workers {
        let (client, url, headers, temp) = (client.clone(), req.url.clone(), headers.clone(), temp.clone());
        let (queue, done_flags, chunk_bytes, failed, stop) = (queue.clone(), done_flags.clone(), chunk_bytes.clone(), failed.clone(), stop.clone());
        tasks.push(tokio::spawn(async move {
            let file = match OpenOptions::new().write(true).open(&temp) {
                Ok(f) => f,
                Err(e) => { *failed.lock().unwrap() = Some(format!("Could not write the file: {e}")); return; }
            };
            loop {
                if stop.load(Ordering::Relaxed) || failed.lock().unwrap().is_some() { return; }
                let Some(i) = queue.lock().unwrap().pop_front() else { return };
                let start = i as u64 * chunk;
                let end = (start + chunk).min(total) - 1;
                let mut tries = 0;
                loop {
                    chunk_bytes[i].store(0, Ordering::Relaxed);
                    match fetch_range(&client, &url, &headers, start, end, &file, &chunk_bytes[i], &stop).await {
                        Ok(()) => { done_flags[i].store(true, Ordering::Relaxed); break; }
                        Err(_) if stop.load(Ordering::Relaxed) => { queue.lock().unwrap().push_front(i); return; }
                        Err(e) => {
                            tries += 1;
                            if tries >= 6 { *failed.lock().unwrap() = Some(e); return; }
                            tokio::time::sleep(Duration::from_millis(400 * tries)).await; // the line dropped: try again
                        }
                    }
                }
            }
        }));
    }

    // Report progress while the workers run; save which chunks are done every few seconds.
    let started = Instant::now();
    let (mut last_done, mut last_t, mut speed) = (0u64, Instant::now(), 0f64);
    let mut last_save = Instant::now();
    loop {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let done: u64 = chunk_bytes.iter().map(|b| b.load(Ordering::Relaxed)).sum();
        let dt = last_t.elapsed().as_secs_f64();
        if dt > 0.0 {
            let now_speed = (done.saturating_sub(last_done)) as f64 / dt;
            speed = if started.elapsed().as_secs_f64() < 1.0 { now_speed } else { speed * 0.7 + now_speed * 0.3 };
        }
        last_done = done;
        last_t = Instant::now();
        let parts = (0..SEGMENTS)
            .map(|s| {
                let (a, b) = (s * count / SEGMENTS, ((s + 1) * count / SEGMENTS).max(s * count / SEGMENTS + 1).min(count));
                let (mut have, mut want) = (0u64, 0u64);
                for i in a..b { have += chunk_bytes[i].load(Ordering::Relaxed); want += chunk.min(total - i as u64 * chunk); }
                if want == 0 { 1.0 } else { have as f32 / want as f32 }
            })
            .collect();
        let running = tasks.iter().filter(|t| !t.is_finished()).count();
        report(Progress { done, total, speed, parts, connections: running });
        if last_save.elapsed() > Duration::from_secs(3) || running == 0 {
            state.done = done_flags.iter().map(|d| d.load(Ordering::Relaxed)).collect();
            let _ = fs::write(&state_path, serde_json::to_vec(&state).unwrap_or_default());
            last_save = Instant::now();
        }
        if running == 0 { break; }
    }
    if let Some(e) = failed.lock().unwrap().take() { return Err(e); }
    if stop.load(Ordering::Relaxed) { return Err("paused".into()); }
    if !done_flags.iter().all(|d| d.load(Ordering::Relaxed)) { return Err("Some parts did not arrive".into()); }
    let dest = unique(&req.dest);
    fs::rename(&temp, &dest).map_err(|e| format!("Could not finish the file: {e}"))?;
    let _ = fs::remove_file(&state_path);
    Ok(dest)
}

#[allow(clippy::too_many_arguments)]
async fn fetch_range(
    client: &reqwest::Client, url: &str, headers: &HeaderMap, start: u64, end: u64, file: &File, got: &AtomicU64, stop: &AtomicBool,
) -> Result<(), String> {
    let res = client
        .get(url)
        .headers(headers.clone())
        .header(RANGE, format!("bytes={start}-{end}"))
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status().as_u16() != 206 { return Err(format!("The site answered {}", res.status())); }
    let mut stream = res.bytes_stream();
    let mut pos = start;
    let mut buf: Vec<u8> = Vec::with_capacity(512 * 1024);
    while let Some(piece) = stream.next().await {
        if stop.load(Ordering::Relaxed) { return Err("paused".into()); }
        let piece = piece.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&piece);
        if buf.len() >= 256 * 1024 {
            write_at(file, &buf, pos)?;
            pos += buf.len() as u64;
            got.fetch_add(buf.len() as u64, Ordering::Relaxed);
            buf.clear();
        }
    }
    if !buf.is_empty() {
        write_at(file, &buf, pos)?;
        pos += buf.len() as u64;
        got.fetch_add(buf.len() as u64, Ordering::Relaxed);
    }
    if pos != end + 1 { return Err("The connection closed early".into()); }
    Ok(())
}

fn write_at(file: &File, buf: &[u8], mut pos: u64) -> Result<(), String> {
    let mut rest = buf;
    while !rest.is_empty() {
        #[cfg(windows)]
        let n = file.seek_write(rest, pos).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let n = file.write_at(rest, pos).map_err(|e| e.to_string())?;
        rest = &rest[n..];
        pos += n as u64;
    }
    Ok(())
}

/// A site that only sends the whole file in one go: one connection, start to end.
async fn single(
    client: &reqwest::Client, req: &Request, headers: HeaderMap, stop: Arc<AtomicBool>, report: impl Fn(Progress) + Send + Sync + 'static,
) -> Result<PathBuf, String> {
    let res = client.get(&req.url).headers(headers).send().await.map_err(|e| format!("Could not reach the site: {e}"))?;
    if !res.status().is_success() { return Err(format!("The site answered {}", res.status())); }
    let total = res.content_length().unwrap_or(0);
    let temp = temp_of(&req.dest);
    let file = File::create(&temp).map_err(|e| format!("Could not create the file: {e}"))?;
    let mut stream = res.bytes_stream();
    let (mut done, mut pos, start, mut last) = (0u64, 0u64, Instant::now(), Instant::now());
    while let Some(piece) = stream.next().await {
        if stop.load(Ordering::Relaxed) { drop(file); let _ = fs::remove_file(&temp); return Err("paused".into()); }
        let piece = piece.map_err(|e| e.to_string())?;
        write_at(&file, &piece, pos)?;
        pos += piece.len() as u64;
        done += piece.len() as u64;
        if last.elapsed() > Duration::from_millis(250) {
            let speed = done as f64 / start.elapsed().as_secs_f64().max(0.001);
            let f = if total > 0 { done as f32 / total as f32 } else { 0.0 };
            report(Progress { done, total, speed, parts: (0..SEGMENTS).map(|s| ((f * SEGMENTS as f32) - s as f32).clamp(0.0, 1.0)).collect(), connections: 1 });
            last = Instant::now();
        }
    }
    drop(file);
    let dest = unique(&req.dest);
    fs::rename(&temp, &dest).map_err(|e| format!("Could not finish the file: {e}"))?;
    Ok(dest)
}
