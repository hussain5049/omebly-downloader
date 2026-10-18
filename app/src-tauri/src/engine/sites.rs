//! Streams and video sites (YouTube, Vimeo, HLS and DASH streams…) through yt-dlp, the open-source site reader:
//! it fetches up to 16 pieces at once, chooses the quality and audio languages, and FFmpeg joins them into one file.
//! Before a stream is handed over, its list is checked: a stream locked with DRM is refused (Security 323).

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Clone, Debug, Default, Serialize)]
pub struct SiteProgress {
    pub done: u64,
    pub total: u64,
    pub speed: f64,
    pub eta: f64,
    pub fragments: (u64, u64),
    /// "video", "audio", "joining"
    pub phase: String,
}

pub struct SiteRequest {
    pub url: String,
    pub folder: PathBuf,
    pub name: String,
    pub height: u32,
    pub audio_only: bool,
    pub languages: Vec<String>,
    pub subtitles: Vec<String>,
    pub headers: Vec<(String, String)>,
    pub cookies_file: Option<PathBuf>,
    pub connections: usize,
}

/// True when a stream's list says it is locked with DRM (Widevine, PlayReady, FairPlay, sample-AES, DASH
/// content protection). Plain AES-128 HLS, whose key the site serves to any player, is not DRM.
pub fn is_protected_manifest(text: &str) -> bool {
    let t = text;
    if t.contains("#EXTM3U") {
        return t.lines().any(|l| {
            let u = l.to_ascii_uppercase();
            (u.starts_with("#EXT-X-KEY") || u.starts_with("#EXT-X-SESSION-KEY"))
                && (u.contains("METHOD=SAMPLE-AES")
                    || (u.contains("KEYFORMAT=") && !u.contains("KEYFORMAT=\"IDENTITY\""))
                    || u.contains("SKD://"))
        });
    }
    let lower = t.to_ascii_lowercase();
    lower.contains("<contentprotection") || lower.contains("cenc:default_kid") || lower.contains("cenc:pssh")
}

/// Fetches a stream's list (when the address is one) and refuses it if it is locked.
pub async fn check_stream(client: &reqwest::Client, url: &str, headers: &[(String, String)]) -> Result<(), String> {
    let path = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
    if !(path.ends_with(".m3u8") || path.ends_with(".mpd")) {
        return Ok(()); // a site page: yt-dlp itself refuses DRM there
    }
    let mut req = client.get(url).timeout(Duration::from_secs(20));
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let text = read_capped(req.send().await.map_err(|e| format!("Could not reach the stream: {e}"))?).await?;
    if is_protected_manifest(&text) {
        return Err("Protected: this video is locked with copy protection, so it can't be saved".into());
    }
    // A main list names one list per quality: those are checked too.
    if text.contains("#EXT-X-STREAM-INF") {
        if let Some(first) = text.lines().find(|l| !l.is_empty() && !l.starts_with('#')) {
            if let Ok(sub) = url::Url::parse(url).and_then(|b| b.join(first.trim())) {
                let mut r = client.get(sub.as_str()).timeout(Duration::from_secs(20));
                for (k, v) in headers {
                    r = r.header(k.as_str(), v.as_str());
                }
                // A quality list that cannot be read is not handed over (it might be the locked one).
                let res = r.send().await.map_err(|e| format!("Could not reach the stream: {e}"))?;
                if is_protected_manifest(&read_capped(res).await?) {
                    return Err("Protected: this video is locked with copy protection, so it can't be saved".into());
                }
            }
        }
    }
    Ok(())
}

/// A stream's list, at most 4 MB (a real list is far smaller).
async fn read_capped(res: reqwest::Response) -> Result<String, String> {
    use futures_util::StreamExt;
    let mut body = Vec::new();
    let mut s = res.bytes_stream();
    while let Some(piece) = s.next().await {
        body.extend_from_slice(&piece.map_err(|e| e.to_string())?);
        if body.len() > 4 * 1024 * 1024 { return Err("The stream's list is too large to check".into()); }
    }
    Ok(String::from_utf8_lossy(&body).to_string())
}

fn format_for(req: &SiteRequest) -> String {
    let h = if req.height > 0 { format!("[height<={}]", req.height) } else { String::new() };
    if req.audio_only {
        return "ba/b".into();
    }
    if req.languages.len() > 1 {
        let audios: Vec<String> = req.languages.iter().map(|l| format!("ba[language^={l}]")).collect();
        return format!("bv*{h}+{}/bv*{h}+ba/b{h}/bv*+ba/b", audios.join("+"));
    }
    if let Some(l) = req.languages.first() {
        return format!("bv*{h}+ba[language^={l}]/bv*{h}+ba/b{h}/bv*+ba/b");
    }
    format!("bv*{h}+ba/b{h}/bv*+ba/b")
}

/// Runs yt-dlp; returns the saved file. `stop` ends it (yt-dlp keeps its pieces and continues next time).
pub fn download(
    ytdlp: &Path,
    ffmpeg_dir: Option<&Path>,
    req: &SiteRequest,
    stop: Arc<AtomicBool>,
    report: impl Fn(SiteProgress),
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(&req.folder).map_err(|e| format!("Could not make the folder: {e}"))?;
    let template = req.folder.join(format!("{}.%(ext)s", req.name.replace('%', "%%")));
    let mut cmd = Command::new(ytdlp);
    cmd.arg(&req.url)
        // Only our own settings: no config files or plugins from elsewhere on the computer (Security 324).
        .args(["--ignore-config", "--no-plugin-dirs", "--newline", "--no-playlist", "--no-mtime", "--no-colors", "--continue"])
        .args(["-N", &req.connections.clamp(1, 32).to_string()])
        .args(["--progress-template", "download:OMEBLY%(progress)j"])
        .args(["--print", "after_move:OMEBLYFILE%(filepath)s"])
        .args(["-f", &format_for(req)])
        .arg("-o")
        .arg(&template);
    if req.audio_only {
        cmd.args(["-x", "--audio-format", "mp3", "--audio-quality", "0"]);
    } else {
        cmd.args(["--merge-output-format", if req.languages.len() > 1 { "mkv" } else { "mp4" }]);
    }
    if req.languages.len() > 1 {
        cmd.arg("--audio-multistreams");
    }
    if !req.subtitles.is_empty() {
        cmd.args(["--write-subs", "--embed-subs", "--sub-langs", &req.subtitles.join(",")]);
    }
    if let Some(dir) = ffmpeg_dir {
        cmd.arg("--ffmpeg-location").arg(dir);
    }
    if let Some(c) = &req.cookies_file {
        cmd.arg("--cookies").arg(c);
    }
    for (k, v) in &req.headers {
        cmd.args(["--add-header", &format!("{k}:{v}")]);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // no console window
    let mut child = cmd.spawn().map_err(|e| format!("Could not start the site reader (yt-dlp): {e}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let errors = std::thread::spawn(move || {
        let mut all = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            all.push_str(&line);
            all.push('\n');
        }
        all
    });
    let mut saved: Option<PathBuf> = None;
    let mut phase = "video".to_string();
    let mut parts_seen = 0;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if stop.load(Ordering::Relaxed) {
            let _ = child.kill();
            break;
        }
        if let Some(p) = line.strip_prefix("OMEBLYFILE") {
            saved = Some(PathBuf::from(p.trim()));
        } else if let Some(j) = line.strip_prefix("OMEBLY") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(j) {
                let num = |k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
                if v.get("status").and_then(|s| s.as_str()) == Some("finished") {
                    parts_seen += 1;
                    phase = if parts_seen >= 1 && !req.audio_only { "audio".into() } else { phase };
                }
                let total = if num("total_bytes") > 0.0 { num("total_bytes") } else { num("total_bytes_estimate") };
                report(SiteProgress {
                    done: num("downloaded_bytes") as u64,
                    total: total as u64,
                    speed: num("speed"),
                    eta: num("eta"),
                    fragments: (num("fragment_index") as u64, num("fragment_count") as u64),
                    phase: phase.clone(),
                });
            }
        } else if line.contains("[Merger]") || line.contains("[ExtractAudio]") || line.contains("[EmbedSubtitle]") {
            report(SiteProgress { phase: "joining".into(), ..Default::default() });
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let err = errors.join().unwrap_or_default();
    if stop.load(Ordering::Relaxed) {
        return Err("paused".into());
    }
    if !status.success() {
        if err.to_ascii_lowercase().contains("drm") {
            return Err("Protected: this video is locked with copy protection, so it can't be saved".into());
        }
        let last = err.lines().rev().find(|l| l.contains("ERROR")).unwrap_or("The site did not send the video").replace("ERROR: ", "");
        return Err(last.chars().take(300).collect());
    }
    saved.ok_or_else(|| "The video was downloaded but its file was not found".into())
}

#[cfg(test)]
mod tests {
    use super::is_protected_manifest;
    #[test]
    fn drm_lists_are_refused_and_plain_ones_are_not() {
        assert!(is_protected_manifest("#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://x\",KEYFORMAT=\"com.apple.streamingkeydelivery\"\n"));
        assert!(is_protected_manifest("#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT=\"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed\"\n"));
        assert!(is_protected_manifest("<MPD><Period><AdaptationSet><ContentProtection schemeIdUri=\"urn:uuid:edef8ba9\"/></AdaptationSet></Period></MPD>"));
        assert!(!is_protected_manifest("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:2,\na.ts\n"));
        assert!(!is_protected_manifest("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nv0.m3u8\n"));
        assert!(!is_protected_manifest("<MPD><Period><AdaptationSet><Representation/></AdaptationSet></Period></MPD>"));
    }
}
