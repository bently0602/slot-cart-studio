//! Local files first; missing databases and artwork are downloaded by the executable.
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

const HOSTED: &str = "https://art.slot-cfw.fyi/";
const RAW: &str = "https://raw.githubusercontent.com/";
const NEAR: &str = "https://archive.org/download/near-snes-scans-png/";
const PLATFORMS: &[(&str, &str)] = &[
    ("GBA", "Nintendo - Game Boy Advance"),
    ("GB", "Nintendo - Game Boy"),
    ("GBC", "Nintendo - Game Boy Color"),
    ("SNES", "Nintendo - Super Nintendo Entertainment System"),
    ("PSX", "Sony - PlayStation"),
];
const MAX_BODY: u64 = 32 * 1024 * 1024;
const MISSING_TTL: Duration = Duration::from_secs(24 * 60 * 60);
static TEMP_ID: AtomicU64 = AtomicU64::new(0);
#[path = "artwork_download.rs"]
mod bulk;

pub fn default_directory() -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|e| format!("Cannot locate the executable: {e}; use --cache-dir PATH"))?;
    executable
        .parent()
        .map(|directory| directory.join("artwork"))
        .ok_or_else(|| "Cannot locate the executable directory; use --cache-dir PATH".into())
}

pub struct ArtworkCache {
    pub root: PathBuf,
    downloads: bool,
    agent: ureq::Agent,
    hosted: String,
    raw: String,
    near: String,
    github: String,
    bulk_job: Mutex<Option<Arc<bulk::BulkJob>>>,
    locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    active: Mutex<usize>,
    available: Condvar,
}

impl ArtworkCache {
    pub fn new(root: PathBuf, downloads: bool) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(|e| format!("Cannot create artwork cache at {}: {e}; use --cache-dir PATH to choose a writable directory", root.display()))?;
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        let cache = Self {
            root,
            downloads,
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(30)))
                .http_status_as_error(false)
                .max_redirects(3)
                .build()
                .into(),
            hosted: HOSTED.into(),
            raw: RAW.into(),
            near: NEAR.into(),
            github: "https://api.github.com/".into(),
            bulk_job: Mutex::new(None),
            locks: Mutex::new(HashMap::new()),
            active: Mutex::new(0),
            available: Condvar::new(),
        };
        let mut platforms = serde_json::Map::new();
        for (platform, _) in PLATFORMS {
            platforms.insert(
                (*platform).into(),
                json!({ "database": format!("dat/{platform}.dat"), "thumbnails": {} }),
            );
        }
        cache.write(
            &cache.root.join("library.json"),
            &serde_json::to_vec(&json!({
                "version": 1, "offline": true, "onDemand": true, "downloadsEnabled": downloads, "platforms": platforms,
            }))
            .unwrap(),
        )?;
        cache.write(&cache.root.join("SOURCES.txt"), b"Cart Studio automatic artwork cache\nNames/checksums: https://github.com/libretro/libretro-database (CC BY-SA 4.0)\nCovers/logos: https://github.com/libretro-thumbnails/libretro-thumbnails\nHosted cartridge artwork: https://art.slot-cfw.fyi/ (ScreenScraper; CC BY-NC-SA 4.0)\nOriginal USA SNES cartridge scans: Near, https://archive.org/details/near-snes-scans-png\nReviewed crop dimensions/hashes are recorded in near-catalog.json.\n")?;
        cache.write(
            &cache.root.join("near-catalog.json"),
            include_bytes!("../../tools/near-labels.json"),
        )?;
        Ok(cache)
    }

    pub fn read(&self, relative: &str) -> Result<Option<Vec<u8>>, String> {
        if relative == "library.json" {
            return self.cached(&self.root.join(relative));
        }
        if relative == "index.json" {
            let bytes = match self.load(
                &self.root.join(relative),
                &format!("{}index.json", self.hosted),
                true,
            ) {
                Ok(bytes) => bytes,
                Err(error) => {
                    eprintln!("Hosted artwork index unavailable: {error}");
                    None
                }
            };
            let mut index: Value = match bytes {
                Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
                None => json!({}),
            };
            for (crc, title) in near_checksums().as_object().unwrap() {
                let scan = &near_catalog()[title.as_str().unwrap()];
                index
                    .as_object_mut()
                    .ok_or("Invalid cached artwork index")?
                    .entry(crc.clone())
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .ok_or("Invalid cached artwork entry")?
                    .insert(
                        "support-texture".into(),
                        json!(format!(
                            "SNES/support-texture/{}.png",
                            scan["slug"].as_str().unwrap()
                        )),
                    );
            }
            return Ok(Some(serde_json::to_vec(&index).unwrap()));
        }
        let parts: Vec<_> = relative.split('/').collect();
        if parts.len() == 3 && parts[0] == "SNES" && parts[1] == "support-texture" {
            if let Some((title, scan)) = near_catalog()
                .as_object()
                .unwrap()
                .iter()
                .find(|(_, scan)| parts[2].strip_suffix(".png") == scan["slug"].as_str())
            {
                return self.near_label(&self.root.join(relative), title, scan);
            }
        }
        if parts.len() == 2 && parts[0] == "dat" {
            let platform = parts[1].strip_suffix(".dat").unwrap_or("");
            if let Some((_, name)) = PLATFORMS.iter().find(|(p, _)| *p == platform) {
                let set = if platform == "PSX" {
                    "redump"
                } else {
                    "no-intro"
                };
                let encoded = utf8_percent_encode(name, NON_ALPHANUMERIC);
                let url = format!(
                    "{}libretro/libretro-database/master/metadat/{set}/{encoded}.dat",
                    self.raw
                );
                return self.load(&self.root.join(relative), &url, false);
            }
        }
        if parts.len() == 4
            && parts[0] == "thumbnails"
            && PLATFORMS.iter().any(|(p, _)| *p == parts[1])
            && ["Named_Boxarts", "Named_Logos"].contains(&parts[2])
        {
            let name = percent_decode_str(parts[3])
                .decode_utf8()
                .map_err(|_| "Invalid artwork filename")?;
            if !valid_image_name(&name) {
                return Ok(None);
            }
            let system = PLATFORMS
                .iter()
                .find(|(p, _)| *p == parts[1])
                .unwrap()
                .1
                .replace(' ', "_");
            let url = format!(
                "{}libretro-thumbnails/{system}/master/{}/{}",
                self.raw,
                parts[2],
                utf8_percent_encode(&name, NON_ALPHANUMERIC)
            );
            let key = format!("{:x}", Sha256::digest(name.as_bytes()));
            let media = if parts[2] == "Named_Boxarts" {
                "boxart"
            } else {
                "wheel"
            };
            return self.load(
                &self
                    .root
                    .join(parts[1])
                    .join(media)
                    .join(format!("{key}.png")),
                &url,
                false,
            );
        }
        if parts.len() == 3
            && PLATFORMS.iter().any(|(p, _)| *p == parts[0])
            && ["wheel", "support-texture", "support-scan"].contains(&parts[1])
            && valid_checksum_image(parts[2])
        {
            return self.load(
                &self.root.join(relative),
                &format!("{}{relative}", self.hosted),
                false,
            );
        }
        Ok(None)
    }

    fn cached(&self, path: &Path) -> Result<Option<Vec<u8>>, String> {
        match path.canonicalize() {
            Ok(file) if file.starts_with(&self.root) && file.is_file() => {
                fs::read(file).map(Some).map_err(|e| e.to_string())
            }
            Ok(_) => Err("Artwork cache path is outside its directory".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn load(&self, file: &Path, url: &str, index: bool) -> Result<Option<Vec<u8>>, String> {
        let lock = self
            .locks
            .lock()
            .unwrap()
            .entry(file.to_owned())
            .or_default()
            .clone();
        let _guard = lock.lock().unwrap();
        if let Some(bytes) = self.cached(file)? {
            return Ok(Some(bytes));
        }
        if !self.downloads {
            return Ok(None);
        }
        let missing = file.with_extension("missing");
        let image_file = file.extension().is_some_and(|ext| ext == "png");
        if image_file
            && fs::metadata(&missing)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|time| time.elapsed().ok())
                .is_some_and(|age| age < MISSING_TTL)
        {
            return Ok(None);
        }
        println!(
            "Downloading artwork: {}",
            file.strip_prefix(&self.root).unwrap().display()
        );
        let Some(mut body) = self.download(url)? else {
            // A real 404 may be remembered. Network failures are retried next time.
            if image_file {
                self.write(&missing, b"404")?;
            }
            return Ok(None);
        };
        if index {
            let mut value: Value =
                serde_json::from_slice(&body).map_err(|e| format!("Invalid artwork index: {e}"))?;
            let entries = value.as_object_mut().ok_or("Invalid artwork index")?;
            for entry in entries.values_mut().filter_map(Value::as_object_mut) {
                for media in ["wheel", "support-texture", "support-scan"] {
                    if let Some(path) = entry.get(media).and_then(Value::as_str) {
                        let relative = path.strip_prefix(HOSTED).unwrap_or(path);
                        let segments: Vec<_> = relative.split('/').collect();
                        if segments.len() == 3
                            && PLATFORMS.iter().any(|(p, _)| *p == segments[0])
                            && segments[1] == media
                            && valid_checksum_image(segments[2])
                        {
                            entry.insert(media.into(), json!(relative));
                        } else {
                            entry.remove(media);
                        }
                    }
                }
            }
            body = serde_json::to_vec(&value).unwrap();
        } else if file.extension().is_some_and(|ext| ext == "dat") {
            if !String::from_utf8_lossy(&body).contains("game (") {
                return Err("Invalid matching database".into());
            }
        } else {
            // Git serves symlinks as small text files. Resolve aliases in this folder only.
            let mut seen = HashSet::from([url.to_owned()]);
            let mut current = url.to_owned();
            while body.len() <= 512 && !body.starts_with(b"\x89PNG\r\n\x1a\n") {
                let target = std::str::from_utf8(&body).unwrap_or("").trim();
                if !valid_image_name(target) {
                    break;
                }
                current = format!(
                    "{}/{}",
                    current.rsplit_once('/').unwrap().0,
                    utf8_percent_encode(target, NON_ALPHANUMERIC)
                );
                if !seen.insert(current.clone()) || seen.len() > 8 {
                    return Err("Circular artwork alias".into());
                }
                let Some(bytes) = self.download(&current)? else {
                    return Ok(None);
                };
                body = bytes;
            }
            body = png_bytes(body)?;
        }
        self.write(file, &body)?;
        Ok(Some(body))
    }

    fn download(&self, url: &str) -> Result<Option<Vec<u8>>, String> {
        let mut active = self.active.lock().unwrap();
        while *active >= 4 {
            active = self.available.wait(active).unwrap();
        }
        *active += 1;
        drop(active);
        let result = (|| {
            let mut attempt = 0;
            let mut response = loop {
                let response = self
                    .agent
                    .get(url)
                    .header("User-Agent", "CartStudio/0.1 artwork-cache")
                    .call()
                    .map_err(|e| format!("Artwork download failed for {url}: {e}"))?;
                // A transient upstream outage must not abort catalog preparation
                // on the first response. Keep retries bounded for cancellation.
                if matches!(response.status().as_u16(), 500 | 502 | 503 | 504) && attempt < 2 {
                    drop(response);
                    std::thread::sleep(Duration::from_millis(250 << attempt));
                    attempt += 1;
                    continue;
                }
                break response;
            };
            if response.status().as_u16() == 404 {
                return Ok(None);
            }
            if !response.status().is_success() {
                return Err(format!(
                    "Artwork download returned HTTP {} for {url}",
                    response.status()
                ));
            }
            let mut bytes = Vec::new();
            response
                .body_mut()
                .as_reader()
                .take(MAX_BODY + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() as u64 > MAX_BODY {
                return Err("Artwork download is too large".into());
            }
            Ok(Some(bytes))
        })();
        *self.active.lock().unwrap() -= 1;
        self.available.notify_one();
        result
    }

    fn near_label(
        &self,
        file: &Path,
        title: &str,
        spec: &Value,
    ) -> Result<Option<Vec<u8>>, String> {
        let lock = self
            .locks
            .lock()
            .unwrap()
            .entry(file.to_owned())
            .or_default()
            .clone();
        let _guard = lock.lock().unwrap();
        if let Some(bytes) = self.cached(file)? {
            return Ok(Some(bytes));
        }
        if !self.downloads {
            return Ok(None);
        }
        println!("Downloading original SNES label: {title}");
        let url = format!(
            "{}{}/cartridge.png",
            self.near,
            utf8_percent_encode(title, NON_ALPHANUMERIC)
        );
        let Some(bytes) = self.download(&url)? else {
            return Ok(None);
        };
        let label = prepare_near_label(&bytes, spec)?;
        self.write(file, &label)?;
        Ok(Some(label))
    }

    fn write(&self, file: &Path, bytes: &[u8]) -> Result<(), String> {
        let parent = file.parent().unwrap();
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        if !parent
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(&self.root)
        {
            return Err("Artwork cache path is outside its directory".into());
        }
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temporary = parent.join(format!(
            ".{}-{stamp}-{}.tmp",
            std::process::id(),
            TEMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            output.write_all(bytes)?;
            output.sync_all()?;
            drop(output);
            fs::rename(&temporary, file)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result.map_err(|e| format!("Cannot save artwork cache: {e}"))
    }
}

fn valid_image_name(name: &str) -> bool {
    name.ends_with(".png")
        && name.len() <= 512
        && !name.contains(['/', '\\', ':'])
        && !name.chars().any(char::is_control)
}

fn near_catalog() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_slice(include_bytes!("../../tools/near-labels.json")).unwrap()
    })
}

fn near_checksums() -> &'static Value {
    static CHECKSUMS: OnceLock<Value> = OnceLock::new();
    CHECKSUMS
        .get_or_init(|| serde_json::from_slice(include_bytes!("../near-checksums.json")).unwrap())
}

fn prepare_near_label(bytes: &[u8], spec: &Value) -> Result<Vec<u8>, String> {
    let hash = format!("{:x}", sha1::Sha1::digest(bytes));
    if spec["sha1"].as_str() != Some(hash.as_str()) {
        return Err("The SNES scan changed; its crop must be reviewed before use".into());
    }
    let source = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?;
    if spec["size"] != json!([source.width(), source.height()]) {
        return Err("Unexpected SNES scan dimensions".into());
    }
    let crop = spec["crop"].as_array().ok_or("Missing SNES crop")?;
    let [left, top, right, bottom]: [u32; 4] = crop
        .iter()
        .map(|v| v.as_u64().and_then(|v| u32::try_from(v).ok()))
        .collect::<Option<Vec<_>>>()
        .ok_or("Invalid SNES crop")?
        .try_into()
        .map_err(|_| "Invalid SNES crop")?;
    if left >= right || top >= bottom || right > source.width() || bottom > source.height() {
        return Err("Invalid SNES crop".into());
    }
    // Pillow's ROTATE_90 is counterclockwise: rotate270 is its image crate equivalent.
    let crop = image::imageops::rotate270(
        &source
            .crop_imm(left, top, right - left, bottom - top)
            .to_rgb8(),
    );
    let scale = (960.0 / crop.width() as f64).min(584.0 / crop.height() as f64);
    let width = (crop.width() as f64 * scale).round().clamp(1.0, 960.0) as u32;
    let height = (crop.height() as f64 * scale).round().clamp(1.0, 584.0) as u32;
    let resized =
        image::imageops::resize(&crop, width, height, image::imageops::FilterType::Lanczos3);
    let mut padded = image::RgbImage::new(960, 584);
    image::imageops::replace(
        &mut padded,
        &resized,
        ((960 - width) / 2).into(),
        ((584 - height) / 2).into(),
    );
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(padded)
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(output.into_inner())
}

fn valid_checksum_image(name: &str) -> bool {
    name.strip_suffix(".png")
        .is_some_and(|stem| stem.len() == 8 && stem.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn png_bytes(mut body: Vec<u8>) -> Result<Vec<u8>, String> {
    if body.starts_with(b"\x89PNG\r\n\x1a\n") {
        // Preserve the pixels and all valid chunks, dropping only broken optional ICC profiles.
        let mut output = body[..8].to_vec();
        let mut offset = 8;
        while offset < body.len() {
            let size = body.get(offset..offset + 4).ok_or("Truncated PNG")?;
            let end = offset + u32::from_be_bytes(size.try_into().unwrap()) as usize + 12;
            let chunk = body.get(offset..end).ok_or("Truncated PNG")?;
            let crc = u32::from_be_bytes(chunk[chunk.len() - 4..].try_into().unwrap());
            if &chunk[4..8] != b"iCCP" || crc32fast::hash(&chunk[4..chunk.len() - 4]) == crc {
                output.extend_from_slice(chunk);
            }
            offset = end;
        }
        body = output;
    }
    let reader = image::ImageReader::new(Cursor::new(&body))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let png = reader.format() == Some(image::ImageFormat::Png);
    let image = reader
        .decode()
        .map_err(|e| format!("Invalid artwork image: {e}"))?;
    if png {
        return Ok(body);
    }
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicBool;
    use std::thread;

    type Replies = Arc<Mutex<HashMap<String, std::collections::VecDeque<(u16, Vec<u8>)>>>>;
    pub(super) struct Server {
        pub(super) base: String,
        replies: Replies,
        pub(super) requests: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        worker: Option<thread::JoinHandle<()>>,
    }

    impl Server {
        pub(super) fn new() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let base = format!("http://{}/", listener.local_addr().unwrap());
            let replies: Replies = Arc::default();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let (responses, hits, done) = (replies.clone(), requests.clone(), stop.clone());
            let worker = thread::spawn(move || {
                while !done.load(Ordering::Relaxed) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    };
                    stream
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut reader = BufReader::new(&stream);
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    let path = line.split_whitespace().nth(1).unwrap().to_owned();
                    loop {
                        line.clear();
                        reader.read_line(&mut line).unwrap();
                        if line == "\r\n" || line.is_empty() {
                            break;
                        }
                    }
                    hits.lock().unwrap().push(path.clone());
                    let (status, body) = responses
                        .lock()
                        .unwrap()
                        .get_mut(&path)
                        .and_then(|queue| {
                            if queue.len() > 1 {
                                queue.pop_front()
                            } else {
                                queue.front().cloned()
                            }
                        })
                        .unwrap_or((404, Vec::new()));
                    let _ = write!(stream, "HTTP/1.1 {status} Response\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                    let _ = stream.write_all(&body);
                }
            });
            Self {
                base,
                replies,
                requests,
                stop,
                worker: Some(worker),
            }
        }
        pub(super) fn reply(&self, path: &str, status: u16, body: &[u8]) {
            self.replies
                .lock()
                .unwrap()
                .insert(path.into(), [(status, body.to_vec())].into());
        }
        pub(super) fn reply_sequence(&self, path: &str, replies: &[(u16, &[u8])]) {
            self.replies.lock().unwrap().insert(
                path.into(),
                replies
                    .iter()
                    .map(|(status, body)| (*status, body.to_vec()))
                    .collect(),
            );
        }
        pub(super) fn cache(&self, root: &Path) -> ArtworkCache {
            let mut cache = ArtworkCache::new(root.to_owned(), true).unwrap();
            cache.hosted = format!("{}hosted/", self.base);
            cache.raw = format!("{}raw/", self.base);
            cache
        }
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            self.worker.take().unwrap().join().unwrap();
        }
    }
    pub(super) fn image_bytes(format: image::ImageFormat) -> Vec<u8> {
        let image = image::DynamicImage::ImageRgb8(image::ImageBuffer::from_pixel(
            3,
            2,
            image::Rgb([200, 20, 10]),
        ));
        let mut output = Cursor::new(Vec::new());
        image.write_to(&mut output, format).unwrap();
        output.into_inner()
    }

    #[test]
    fn image_filename_guards() {
        for name in [
            "../secret.png",
            "a/b.png",
            "a\\b.png",
            "C:secret.png",
            "\0.png",
        ] {
            assert!(!valid_image_name(name));
        }
    }

    #[test]
    fn every_reviewed_snes_scan_has_valid_crop_and_checksum_metadata() {
        let catalog = near_catalog().as_object().unwrap();
        let checksums = near_checksums().as_object().unwrap();
        let covered: HashSet<_> = checksums.values().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(covered.len(), catalog.len());
        for (crc, title) in checksums {
            assert!(valid_checksum_image(&format!("{crc}.png")));
            assert!(catalog.contains_key(title.as_str().unwrap()));
        }
        for scan in catalog.values() {
            let size = scan["size"].as_array().unwrap();
            let crop = scan["crop"].as_array().unwrap();
            assert!(crop[0].as_u64().unwrap() < crop[2].as_u64().unwrap());
            assert!(crop[1].as_u64().unwrap() < crop[3].as_u64().unwrap());
            assert!(crop[2].as_u64().unwrap() <= size[0].as_u64().unwrap());
            assert!(crop[3].as_u64().unwrap() <= size[1].as_u64().unwrap());
            assert!(valid_image_name(&format!(
                "{}.png",
                scan["slug"].as_str().unwrap()
            )));
            assert_eq!(scan["sha1"].as_str().unwrap().len(), 40);
        }
    }

    #[test]
    fn original_snes_scans_are_verified_cropped_rotated_padded_and_cached() {
        let server = Server::new();
        let directory = tempfile::tempdir().unwrap();
        let mut cache = server.cache(directory.path());
        cache.near = format!("{}near/", server.base);
        let source = image::RgbImage::from_fn(8, 8, |x, y| {
            image::Rgb([(x * 20) as u8, (y * 20) as u8, 80])
        });
        let mut output = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(source)
            .write_to(&mut output, image::ImageFormat::Png)
            .unwrap();
        let body = output.into_inner();
        let spec = json!({"sha1": format!("{:x}", sha1::Sha1::digest(&body)), "size": [8,8], "crop": [2,1,4,5]});
        server.reply("/near/Toy/cartridge.png", 200, &body);
        let file = directory.path().join("SNES/support-texture/toy.png");
        let bytes = cache.near_label(&file, "Toy", &spec).unwrap().unwrap();
        let label = image::load_from_memory(&bytes).unwrap().to_rgb8();
        assert_eq!(label.dimensions(), (960, 584));
        assert_eq!(*label.get_pixel(0, 0), image::Rgb([0, 0, 0]));
        assert!(label.get_pixel(120, 160)[0] > label.get_pixel(120, 450)[0]);
        assert!(label.get_pixel(850, 160)[1] > label.get_pixel(120, 160)[1]);
        assert_eq!(
            cache.near_label(&file, "Toy", &spec).unwrap(),
            Some(bytes.clone())
        );
        let offline = ArtworkCache::new(directory.path().to_owned(), false).unwrap();
        assert_eq!(
            offline.near_label(&file, "Toy", &spec).unwrap(),
            Some(bytes)
        );
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        let mut wrong = spec.clone();
        wrong["sha1"] = json!("changed");
        assert!(prepare_near_label(&body, &wrong).is_err());
        let mut wrong = spec;
        wrong["crop"] = json!([2, 1, 99, 5]);
        assert!(prepare_near_label(&body, &wrong).is_err());
    }

    #[test]
    fn index_databases_and_images_download_once_and_survive_offline_restart() {
        let server = Server::new();
        let directory = tempfile::tempdir().unwrap();
        let cache = server.cache(directory.path());
        let index = json!({ "12345678": {"wheel": format!("{HOSTED}GB/wheel/12345678.png"), "support-texture": "https://example.com/private.png", "look": {"deep":"#abcdef"}} });
        server.reply(
            "/hosted/index.json",
            200,
            &serde_json::to_vec(&index).unwrap(),
        );
        server.reply(
            "/hosted/GB/wheel/12345678.png",
            200,
            &image_bytes(image::ImageFormat::Png),
        );
        let dat_url = "/raw/libretro/libretro-database/master/metadat/no-intro/Nintendo%20%2D%20Game%20Boy.dat";
        server.reply(dat_url, 200, b"game ( name \"Example\" )");
        let bytes = cache.read("index.json").unwrap().unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["12345678"]["wheel"], "GB/wheel/12345678.png");
        assert!(value["12345678"].get("support-texture").is_none());
        assert_eq!(value["12345678"]["look"]["deep"], "#abcdef");
        let dat = cache.read("dat/GB.dat").unwrap().unwrap();
        let png = cache.read("GB/wheel/12345678.png").unwrap().unwrap();
        assert_eq!(server.requests.lock().unwrap().len(), 3);
        let offline = ArtworkCache::new(directory.path().to_owned(), false).unwrap();
        assert_eq!(offline.read("index.json").unwrap(), Some(bytes));
        assert_eq!(offline.read("dat/GB.dat").unwrap(), Some(dat));
        assert_eq!(offline.read("GB/wheel/12345678.png").unwrap(), Some(png));
        assert_eq!(offline.read("dat/PSX.dat").unwrap(), None);
        assert_eq!(server.requests.lock().unwrap().len(), 3);
    }

    #[test]
    fn aliases_concurrent_requests_and_real_missing_images_are_cached() {
        let server = Server::new();
        let directory = tempfile::tempdir().unwrap();
        let cache = Arc::new(server.cache(directory.path()));
        server.reply("/raw/libretro-thumbnails/Nintendo_-_Game_Boy/master/Named_Logos/Alias%20%28USA%29%2Epng", 200, b"Shared.png\n");
        server.reply(
            "/raw/libretro-thumbnails/Nintendo_-_Game_Boy/master/Named_Logos/Shared%2Epng",
            200,
            &image_bytes(image::ImageFormat::Png),
        );
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let cache = cache.clone();
                thread::spawn(move || {
                    cache
                        .read("thumbnails/GB/Named_Logos/Alias%20(USA).png")
                        .unwrap()
                        .unwrap()
                })
            })
            .collect();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert!(results.iter().all(|body| *body == results[0]));
        assert_eq!(server.requests.lock().unwrap().len(), 2);
        for _ in 0..2 {
            assert_eq!(
                cache
                    .read("thumbnails/GBC/Named_Logos/Missing.png")
                    .unwrap(),
                None
            );
        }
        assert_eq!(server.requests.lock().unwrap().len(), 3);
        let offline = ArtworkCache::new(directory.path().to_owned(), false).unwrap();
        assert_eq!(
            offline
                .read("thumbnails/GB/Named_Logos/Alias%20(USA).png")
                .unwrap(),
            Some(results[0].clone())
        );
    }

    #[test]
    fn invalid_downloads_are_not_saved_and_can_be_retried() {
        let server = Server::new();
        let directory = tempfile::tempdir().unwrap();
        let cache = server.cache(directory.path());
        let url = "/raw/libretro-thumbnails/Nintendo_-_Game_Boy/master/Named_Boxarts/Game%2Epng";
        server.reply(url, 200, b"<html>Unavailable</html>");
        assert!(cache.read("thumbnails/GB/Named_Boxarts/Game.png").is_err());
        server.reply(url, 503, b"busy");
        assert!(cache.read("thumbnails/GB/Named_Boxarts/Game.png").is_err());
        server.reply(url, 200, &image_bytes(image::ImageFormat::Jpeg));
        assert!(cache
            .read("thumbnails/GB/Named_Boxarts/Game.png")
            .unwrap()
            .unwrap()
            .starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(server.requests.lock().unwrap().len(), 5);
        for path in [
            "../private.png",
            "thumbnails/GB/Named_Logos/%2e%2e%2fprivate.png",
            "SNES/support-texture/../../private.png",
            "dat/PRIVATE.dat",
        ] {
            assert_eq!(cache.read(path).unwrap(), None);
        }
        assert_eq!(server.requests.lock().unwrap().len(), 5);
        assert!(!fs::read_dir(directory.path().join("GB/boxart"))
            .unwrap()
            .any(|e| e.unwrap().path().extension().unwrap() == "tmp"));
    }

    #[test]
    fn metadata_404s_can_be_retried_and_near_labels_remain_discoverable() {
        let server = Server::new();
        let directory = tempfile::tempdir().unwrap();
        let cache = server.cache(directory.path());
        for _ in 0..2 {
            let index: Value =
                serde_json::from_slice(&cache.read("index.json").unwrap().unwrap()).unwrap();
            assert_eq!(
                index["2D206BF7"]["support-texture"],
                "SNES/support-texture/chrono-trigger.png"
            );
        }
        assert_eq!(cache.read("dat/GB.dat").unwrap(), None);
        let url = "/raw/libretro/libretro-database/master/metadat/no-intro/Nintendo%20%2D%20Game%20Boy.dat";
        server.reply(url, 200, b"game ( name \"Available now\" )");
        assert!(cache.read("dat/GB.dat").unwrap().is_some());
        assert_eq!(server.requests.lock().unwrap().len(), 4);
        assert!(!directory.path().join("index.missing").exists());
        assert!(!directory.path().join("dat/GB.missing").exists());
    }

    #[test]
    fn invalid_icc_profiles_are_removed_but_damaged_pixels_are_rejected() {
        let original = image_bytes(image::ImageFormat::Png);
        let profile = b"bad-profile";
        let mut broken = (profile.len() as u32).to_be_bytes().to_vec();
        broken.extend_from_slice(b"iCCP");
        broken.extend_from_slice(profile);
        broken.extend_from_slice(&[0; 4]);
        let mut png = original[..33].to_vec();
        png.extend(broken);
        png.extend_from_slice(&original[33..]);
        assert_eq!(png_bytes(png).unwrap(), original);
        let mut corrupt = original;
        let index = corrupt.windows(4).position(|v| v == b"IDAT").unwrap();
        corrupt[index + 4] ^= 1;
        assert!(png_bytes(corrupt).is_err());
    }
}
