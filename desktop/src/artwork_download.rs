//! Full-library prefetch uses the same validated cache paths as ordinary artwork requests.
use super::*;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::thread;

#[cfg(test)]
#[path = "artwork_download_tests.rs"]
mod tests;

pub(super) struct BulkJob {
    status: Mutex<Value>,
    cancel: AtomicBool,
}

impl BulkJob {
    fn new() -> Self {
        Self {
            status: Mutex::new(json!({
                "running": true, "stage": "Preparing artwork catalogs…", "completed": 0,
                "total": 0, "available": 0, "missing": 0, "failed": 0,
                "cancelled": false, "error": null,
            })),
            cancel: AtomicBool::new(false),
        }
    }
    fn stage(&self, message: &str) {
        self.status.lock().unwrap()["stage"] = json!(message);
    }
    fn check_cancel(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Relaxed) {
            Err("Download cancelled".into())
        } else {
            Ok(())
        }
    }
    fn finish(&self, error: Option<String>) {
        let mut status = self.status.lock().unwrap();
        status["running"] = json!(false);
        status["cancelled"] = json!(self.cancel.load(Ordering::Relaxed));
        status["error"] = json!(error);
    }
}

impl ArtworkCache {
    pub fn download_status(&self) -> Value {
        match self.bulk_job.lock().unwrap().as_ref() {
            Some(job) => job.status.lock().unwrap().clone(),
            None => json!({"running": false, "stage": "Ready", "completed": 0, "total": 0,
                "available": 0, "missing": 0, "failed": 0, "cancelled": false, "error": null}),
        }
    }

    pub fn start_download(self: &Arc<Self>) -> Result<Value, String> {
        if !self.downloads {
            return Err("Artwork downloads are disabled by --no-art-download".into());
        }
        let mut current = self.bulk_job.lock().unwrap();
        if let Some(job) = current.as_ref() {
            let status = job.status.lock().unwrap();
            if status["running"] == true {
                return Ok(status.clone());
            }
        }
        let job = Arc::new(BulkJob::new());
        let initial = job.status.lock().unwrap().clone();
        *current = Some(job.clone());
        let cache = Arc::clone(self);
        thread::spawn(move || match cache.download_plan(&job) {
            Ok(plan) => cache.run_download(plan, &job),
            Err(error) => job.finish(if job.cancel.load(Ordering::Relaxed) {
                None
            } else {
                Some(error)
            }),
        });
        Ok(initial)
    }

    pub fn cancel_download(&self) -> Value {
        if let Some(job) = self.bulk_job.lock().unwrap().as_ref() {
            job.cancel.store(true, Ordering::Relaxed);
            job.stage("Stopping after the current downloads…");
        }
        self.download_status()
    }

    fn download_plan(&self, job: &BulkJob) -> Result<Vec<String>, String> {
        for (platform, _) in PLATFORMS {
            job.check_cancel()?;
            job.stage(&format!("Preparing {platform} matching database…"));
            self.read(&format!("dat/{platform}.dat"))?
                .ok_or_else(|| format!("The {platform} matching database is unavailable"))?;
        }
        job.check_cancel()?;
        job.stage("Preparing cartridge artwork index…");
        let bytes = self
            .load(
                &self.root.join("index.json"),
                &format!("{}index.json", self.hosted),
                true,
            )?
            .ok_or("The cartridge artwork index is unavailable")?;
        let index: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let mut images = BTreeSet::new();
        for entry in index.as_object().ok_or("Invalid artwork index")?.values() {
            for media in ["wheel", "support-texture", "support-scan"] {
                if let Some(path) = entry[media].as_str() {
                    images.insert(path.to_owned());
                }
            }
        }
        for scan in near_catalog().as_object().unwrap().values() {
            images.insert(format!(
                "SNES/support-texture/{}.png",
                scan["slug"].as_str().unwrap()
            ));
        }
        for (platform, system) in PLATFORMS {
            job.check_cancel()?;
            job.stage(&format!("Preparing {platform} cover and logo catalog…"));
            let tree = self.thumbnail_catalog(platform, system, job)?;
            images.extend(catalog_paths(platform, &tree)?);
        }
        Ok(images.into_iter().collect())
    }

    fn thumbnail_catalog(
        &self,
        platform: &str,
        system: &str,
        job: &BulkJob,
    ) -> Result<Value, String> {
        job.check_cancel()?;
        let file = self.root.join("catalogs").join(format!("{platform}.json"));
        let cached = self.cached(&file)?;
        let recent = fs::metadata(&file)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age < MISSING_TTL);
        if recent {
            if let Some(bytes) = &cached {
                return serde_json::from_slice(bytes).map_err(|e| e.to_string());
            }
        }
        let repository = system.replace(' ', "_");
        let url = format!(
            "{}repos/libretro-thumbnails/{repository}/git/trees/master",
            self.github
        );
        let bytes = match self.download(&url) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return Err(format!("The {platform} artwork catalog is unavailable")),
            Err(error) => {
                if let Some(bytes) = cached {
                    return serde_json::from_slice(&bytes).map_err(|e| e.to_string());
                }
                return Err(format!(
                    "Cannot load the {platform} artwork catalog: {error}"
                ));
            }
        };
        let root: Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Invalid {platform} artwork catalog: {e}"))?;
        let mut entries = Vec::new();
        let mut found_covers = false;
        for entry in root["tree"]
            .as_array()
            .ok_or("Invalid artwork repository tree")?
        {
            job.check_cancel()?;
            let folder = entry["path"].as_str().unwrap_or("");
            if entry["type"] != "tree"
                || (folder != "Named_Boxarts" && !(folder == "Named_Logos" && platform != "PSX"))
            {
                continue;
            }
            found_covers |= folder == "Named_Boxarts";
            let sha = entry["sha"]
                .as_str()
                .ok_or("Missing artwork folder revision")?;
            if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("Invalid artwork folder revision".into());
            }
            // Only direct image files are used; recursive traversal is unnecessary.
            let url = format!(
                "{}repos/libretro-thumbnails/{repository}/git/trees/{sha}",
                self.github
            );
            let bytes = self
                .download(&url)
                .map_err(|error| format!("Cannot load the {platform} {folder} catalog: {error}"))?
                .ok_or("Artwork folder catalog unavailable")?;
            let subtree: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if subtree["truncated"] == true {
                return Err(format!("The {platform} {folder} catalog is incomplete"));
            }
            for entry in subtree["tree"]
                .as_array()
                .ok_or("Invalid artwork folder tree")?
            {
                if let Some(path) = entry["path"].as_str() {
                    let mut entry = entry.clone();
                    entry["path"] = json!(format!("{folder}/{path}"));
                    entries.push(entry);
                }
            }
        }
        if !found_covers {
            return Err(format!("The {platform} cover folder is unavailable"));
        }
        let tree = json!({"truncated": false, "tree": entries});
        catalog_paths(platform, &tree)?;
        self.write(&file, &serde_json::to_vec(&tree).unwrap())?;
        Ok(tree)
    }

    fn run_download(self: &Arc<Self>, plan: Vec<String>, job: &Arc<BulkJob>) {
        let total = plan.len();
        job.status.lock().unwrap()["total"] = json!(total);
        job.stage("Downloading the five-platform artwork library…");
        let plan = Arc::new(plan);
        let next = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();
        for _ in 0..4 {
            let (cache, plan, next, job) = (self.clone(), plan.clone(), next.clone(), job.clone());
            workers.push(thread::spawn(move || {
                while !job.cancel.load(Ordering::Relaxed) {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(path) = plan.get(index) else {
                        break;
                    };
                    let result = cache.read(path);
                    let mut status = job.status.lock().unwrap();
                    let field = match result {
                        Ok(Some(_)) => "available",
                        Ok(None) => "missing",
                        Err(error) => {
                            eprintln!("Asset download {path}: {error}");
                            if status["error"].is_null() {
                                status["error"] = json!(format!("{path}: {error}"));
                            }
                            "failed"
                        }
                    };
                    status[field] = json!(status[field].as_u64().unwrap() + 1);
                    status["completed"] = json!(status["completed"].as_u64().unwrap() + 1);
                    if !job.cancel.load(Ordering::Relaxed) {
                        status["stage"] = json!(format!(
                            "Downloading assets: {} of {total}",
                            status["completed"]
                        ));
                    }
                }
            }));
        }
        let mut panic = false;
        for worker in workers {
            if worker.join().is_err() {
                panic = true;
            }
        }
        let error = if panic {
            Some("An asset download worker stopped unexpectedly".into())
        } else {
            job.status.lock().unwrap()["error"]
                .as_str()
                .map(str::to_owned)
        };
        job.finish(error);
    }
}

fn catalog_paths(platform: &str, tree: &Value) -> Result<Vec<String>, String> {
    if tree["truncated"] == true {
        return Err(format!(
            "The {platform} catalog is incomplete; try again later"
        ));
    }
    let mut paths = Vec::new();
    for entry in tree["tree"].as_array().ok_or("Invalid artwork tree")? {
        if entry["type"] != "blob" {
            continue;
        }
        let Some((folder, file)) = entry["path"].as_str().and_then(|p| p.split_once('/')) else {
            continue;
        };
        if folder != "Named_Boxarts" && !(folder == "Named_Logos" && platform != "PSX") {
            continue;
        }
        if !valid_image_name(file) {
            continue;
        }
        paths.push(format!(
            "thumbnails/{platform}/{folder}/{}",
            utf8_percent_encode(file, NON_ALPHANUMERIC)
        ));
    }
    Ok(paths)
}
