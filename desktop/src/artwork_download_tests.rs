use super::super::tests::{image_bytes, Server};
use super::*;

#[test]
fn playstation_catalog_recovers_from_temporary_server_failures_and_is_cached() {
    let server = Server::new();
    let directory = tempfile::tempdir().unwrap();
    let mut cache = server.cache(directory.path());
    cache.github = format!("{}api/", server.base);
    let system = "Sony - PlayStation";
    let sha = "1111111111111111111111111111111111111111";
    server.reply(
        "/api/repos/libretro-thumbnails/Sony_-_PlayStation/git/trees/master",
        200,
        &serde_json::to_vec(&json!({"tree": [
            {"type": "tree", "path": "Named_Boxarts", "sha": sha}
        ]}))
        .unwrap(),
    );
    let path = format!("/api/repos/libretro-thumbnails/Sony_-_PlayStation/git/trees/{sha}");
    let tree = serde_json::to_vec(&json!({"truncated": false, "tree": [
        {"type": "blob", "path": "Game (USA).png"},
        {"type": "tree", "path": "Nested"}
    ]}))
    .unwrap();
    server.reply_sequence(
        &path,
        &[(500, b"temporary"), (503, b"temporary"), (200, &tree)],
    );
    let tree = cache
        .thumbnail_catalog("PSX", system, &BulkJob::new())
        .unwrap();
    assert_eq!(catalog_paths("PSX", &tree).unwrap().len(), 1);
    assert_eq!(server.requests.lock().unwrap().len(), 4);
    cache
        .thumbnail_catalog("PSX", system, &BulkJob::new())
        .unwrap();
    assert_eq!(server.requests.lock().unwrap().len(), 4);
}

#[test]
fn persistent_server_failure_is_bounded_identifies_url_and_remains_retryable() {
    let server = Server::new();
    let directory = tempfile::tempdir().unwrap();
    let cache = server.cache(directory.path());
    let path = "/hosted/GB/wheel/11111111.png";
    server.reply(path, 500, b"temporary");
    let error = cache.read("GB/wheel/11111111.png").unwrap_err();
    assert!(error.contains("HTTP 500"));
    assert!(error.contains(&format!("{}hosted/GB/wheel/11111111.png", server.base)));
    assert_eq!(server.requests.lock().unwrap().len(), 3);
    assert!(!directory.path().join("GB/wheel/11111111.missing").exists());
    let png = image_bytes(image::ImageFormat::Png);
    server.reply(path, 200, &png);
    assert!(cache.read("GB/wheel/11111111.png").unwrap().is_some());
    assert_eq!(server.requests.lock().unwrap().len(), 4);
    server.reply("/hosted/GB/wheel/22222222.png", 403, b"forbidden");
    assert!(cache
        .read("GB/wheel/22222222.png")
        .unwrap_err()
        .contains("HTTP 403"));
    assert_eq!(server.requests.lock().unwrap().len(), 5);
}

#[test]
fn full_plan_covers_five_platforms_hosted_art_and_all_reviewed_snes_labels() {
    let server = Server::new();
    let directory = tempfile::tempdir().unwrap();
    let mut cache = server.cache(directory.path());
    cache.github = format!("{}api/", server.base);
    server.reply(
        "/hosted/index.json",
        200,
        &serde_json::to_vec(&json!({"12345678": {
            "wheel": "GB/wheel/12345678.png", "support-scan": "GB/support-scan/12345678.png"
        }}))
        .unwrap(),
    );
    let tree = json!({"truncated": false, "tree": [
        {"type": "tree", "path": "Named_Boxarts", "sha": "1111111111111111111111111111111111111111"},
        {"type": "tree", "path": "Named_Logos", "sha": "2222222222222222222222222222222222222222"},
    ]});
    for (platform, system) in PLATFORMS {
        let set = if *platform == "PSX" {
            "redump"
        } else {
            "no-intro"
        };
        server.reply(
            &format!(
                "/raw/libretro/libretro-database/master/metadat/{set}/{}.dat",
                utf8_percent_encode(system, NON_ALPHANUMERIC)
            ),
            200,
            b"game ( name \"Fixture\" )",
        );
        server.reply(
            &format!(
                "/api/repos/libretro-thumbnails/{}/git/trees/master",
                system.replace(' ', "_")
            ),
            200,
            &serde_json::to_vec(&tree).unwrap(),
        );
        for sha in [
            "1111111111111111111111111111111111111111",
            "2222222222222222222222222222222222222222",
        ] {
            server.reply(
                &format!(
                    "/api/repos/libretro-thumbnails/{}/git/trees/{sha}",
                    system.replace(' ', "_")
                ),
                200,
                &serde_json::to_vec(&json!({"truncated": false, "tree": [
                    {"type": "blob", "path": "Game (USA).png"},
                    {"type": "blob", "path": "../private.png"},
                    {"type": "blob", "path": "Ignored.txt"}
                ]}))
                .unwrap(),
            );
        }
    }
    let plan = cache.download_plan(&BulkJob::new()).unwrap();
    assert_eq!(plan.len(), near_catalog().as_object().unwrap().len() + 11);
    for (platform, _) in PLATFORMS {
        assert!(plan
            .iter()
            .any(|p| p.starts_with(&format!("thumbnails/{platform}/Named_Boxarts/"))));
    }
    assert!(!plan
        .iter()
        .any(|p| p.starts_with("thumbnails/PSX/Named_Logos/")));
    assert!(plan.contains(&"SNES/support-texture/chrono-trigger.png".to_owned()));
    assert!(plan.contains(&"GB/support-scan/12345678.png".to_owned()));
    assert_eq!(server.requests.lock().unwrap().len(), 20);
    cache.download_plan(&BulkJob::new()).unwrap();
    assert_eq!(
        server.requests.lock().unwrap().len(),
        20,
        "cached metadata and catalogs must be reused"
    );
    assert!(catalog_paths("GBA", &json!({"truncated": true})).is_err());
}

#[test]
fn bulk_progress_counts_failures_and_resumes_without_redownloading_successes() {
    let server = Server::new();
    let directory = tempfile::tempdir().unwrap();
    let cache = Arc::new(server.cache(directory.path()));
    let png = image_bytes(image::ImageFormat::Png);
    server.reply("/hosted/GB/wheel/11111111.png", 200, &png);
    server.reply("/hosted/GB/support-scan/33333333.png", 200, b"bad image");
    let plan = vec![
        "GB/wheel/11111111.png".into(),
        "GB/support-texture/22222222.png".into(),
        "GB/support-scan/33333333.png".into(),
    ];
    let job = Arc::new(BulkJob::new());
    *cache.bulk_job.lock().unwrap() = Some(job.clone());
    cache.run_download(plan.clone(), &job);
    let status = cache.download_status();
    assert_eq!(status["completed"], 3);
    assert_eq!(status["available"], 1);
    assert_eq!(status["missing"], 1);
    assert_eq!(status["failed"], 1);
    assert_eq!(status["running"], false);
    server.reply("/hosted/GB/support-scan/33333333.png", 200, &png);
    let job = Arc::new(BulkJob::new());
    *cache.bulk_job.lock().unwrap() = Some(job.clone());
    cache.run_download(plan, &job);
    let status = cache.download_status();
    assert_eq!(status["available"], 2);
    assert_eq!(status["failed"], 0);
    assert!(status["error"].is_null());
    assert_eq!(server.requests.lock().unwrap().len(), 4);
}

#[test]
fn cancellation_stops_new_downloads_and_disabled_mode_rejects_bulk_start() {
    let server = Server::new();
    let directory = tempfile::tempdir().unwrap();
    let cache = Arc::new(server.cache(directory.path()));
    let job = Arc::new(BulkJob::new());
    *cache.bulk_job.lock().unwrap() = Some(job.clone());
    cache.cancel_download();
    cache.run_download(vec!["GB/wheel/11111111.png".into()], &job);
    assert_eq!(cache.download_status()["cancelled"], true);
    assert_eq!(cache.download_status()["completed"], 0);
    assert!(server.requests.lock().unwrap().is_empty());
    let offline = Arc::new(ArtworkCache::new(directory.path().to_owned(), false).unwrap());
    assert!(offline.start_download().is_err());
}
