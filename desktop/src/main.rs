//! The studio as one file: web/ compiled in, served on localhost, and opened in the default
//! browser. Missing game names/artwork are downloaded into a persistent user cache.
use std::io::{self, BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

mod artwork;
mod music;

include!(concat!(env!("OUT_DIR"), "/web.rs"));

const PORT: u16 = 8765;
const CONFIG: &[u8] =
    b"export const DEFAULT_MUSIC_API = new URL('/api/music/', location.origin).href;\nexport const DEFAULT_ART_BASE = 'https://art.slot-cfw.fyi/';\n";
const LOCAL_ART_CONFIG: &[u8] =
    b"export const DEFAULT_MUSIC_API = new URL('/api/music/', location.origin).href;\nexport const DEFAULT_ART_BASE = new URL('/art/', location.origin).href;\n";

#[derive(Default)]
struct Options {
    no_open: bool,
    art_dir: Option<PathBuf>,
    cache_dir: Option<PathBuf>,
    no_art_download: bool,
    help: bool,
}

fn options(args: impl Iterator<Item = std::ffi::OsString>) -> Result<Options, String> {
    let mut result = Options::default();
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--no-open") => result.no_open = true,
            Some("--no-art-download") => result.no_art_download = true,
            Some("--help" | "-h") => result.help = true,
            Some("--art-dir") => {
                let path = args
                    .next()
                    .filter(|p| !p.to_string_lossy().starts_with("--"))
                    .ok_or("--art-dir requires a directory containing index.json")?;
                result.art_dir = Some(PathBuf::from(path));
            }
            Some("--cache-dir") => {
                let path = args
                    .next()
                    .filter(|p| !p.to_string_lossy().starts_with("--"))
                    .ok_or("--cache-dir requires a directory")?;
                result.cache_dir = Some(PathBuf::from(path));
            }
            _ => {
                return Err(format!(
                    "unknown option: {}; use --help",
                    arg.to_string_lossy()
                ))
            }
        }
    }
    Ok(result)
}

fn adjacent_art(executable: &Path) -> Option<PathBuf> {
    let directory = executable.parent()?.join("cart-studio-art");
    (directory.join("index.json").is_file() && directory.join("library.json").is_file())
        .then_some(directory)
}

fn main() {
    let opts = options(std::env::args_os().skip(1)).unwrap_or_else(|error| {
        eprintln!("Cart Studio: {error}");
        std::process::exit(2)
    });
    if opts.help {
        println!("Usage: cart-studio [--no-open] [--art-dir PATH] [--cache-dir PATH] [--no-art-download]");
        println!("Missing artwork is downloaded as needed into an artwork folder beside this executable.");
        println!("--cache-dir overrides that directory; --no-art-download uses cached files only.");
        println!("--art-dir serves a prepared collection containing index.json.");
        println!("A cart-studio-art folder beside the executable is used automatically.");
        return;
    }
    let selected_art = opts.art_dir.or_else(|| {
        if opts.cache_dir.is_some() {
            return None;
        }
        std::env::current_exe()
            .ok()
            .and_then(|exe| adjacent_art(&exe))
    });
    let artwork = if let Some(path) = selected_art {
        let root = (|| {
            let root = path.canonicalize()?;
            let index = std::fs::read(root.join("index.json"))?;
            let value: serde_json::Value = serde_json::from_slice(&index)?;
            if !value.is_object() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "index.json must be an object",
                ));
            }
            Ok::<_, io::Error>(root)
        })()
        .unwrap_or_else(|error| {
            eprintln!("Cart Studio: cannot open --art-dir: {error}");
            std::process::exit(2)
        });
        Artwork::Directory(root)
    } else {
        let root = opts
            .cache_dir
            .map(Ok)
            .unwrap_or_else(artwork::default_directory)
            .and_then(|root| artwork::ArtworkCache::new(root, !opts.no_art_download))
            .unwrap_or_else(|error| {
                eprintln!("Cart Studio: {error}");
                std::process::exit(2)
            });
        Artwork::Cache(Arc::new(root))
    };
    let artwork = Arc::new(artwork);

    // The usual port first: the browser keys what it remembers of the studio, the card folder
    // among it, on the origin, and the port is part of that.
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, PORT))
        .or_else(|_| TcpListener::bind((Ipv4Addr::LOCALHOST, 0)))
        .expect("no free port on 127.0.0.1");
    let url = format!(
        "http://127.0.0.1:{}/",
        listener.local_addr().unwrap().port()
    );

    println!("Cart Studio is at {url}");
    println!("Close this window, or press Ctrl-C, to stop it.");
    match artwork.as_ref() {
        Artwork::Directory(root) => println!("Local artwork: {}", root.display()),
        Artwork::Cache(cache) => println!("Artwork cache: {}", cache.root.display()),
    }
    if !opts.no_open && !open(&url) {
        println!("Open that address in a browser.");
    }

    let music = Arc::new(music::MusicSearch::new());
    for stream in listener.incoming().flatten() {
        let music = Arc::clone(&music);
        let artwork = Arc::clone(&artwork);
        thread::spawn(move || {
            let _ = serve(stream, &music, Some(&artwork));
        });
    }
}

enum Artwork {
    Directory(PathBuf),
    Cache(Arc<artwork::ArtworkCache>),
}

fn serve(
    stream: TcpStream,
    music: &music::MusicSearch,
    artwork: Option<&Artwork>,
) -> io::Result<()> {
    // Browsers open connections ahead of need and leave some of them silent.
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(&stream);

    let mut request = String::new();
    reader.read_line(&mut request)?;
    let mut words = request.split_whitespace();
    let (method, target) = (words.next().unwrap_or(""), words.next().unwrap_or(""));

    // The headers are read and dropped; closing on unread input resets the connection.
    let mut header = String::new();
    let mut origin = None;
    loop {
        header.clear();
        if reader.read_line(&mut header)? <= 2 {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("origin") {
                origin = Some(value.trim().to_owned());
            }
        }
    }

    let path = target
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let head = method == "HEAD";

    if [
        "api/artwork/download",
        "api/artwork/status",
        "api/artwork/cancel",
    ]
    .contains(&path)
    {
        let expected = if path == "api/artwork/status" {
            "GET"
        } else {
            "POST"
        };
        let (status, body) = if method != expected {
            (
                405,
                serde_json::json!({"error": format!("Use {expected} for this artwork operation")}),
            )
        } else if method == "POST"
            && ![
                format!("http://{}", stream.local_addr()?),
                format!("http://localhost:{}", stream.local_addr()?.port()),
            ]
            .iter()
            .any(|allowed| origin.as_deref() == Some(allowed.as_str()))
        {
            (
                403,
                serde_json::json!({"error": "Start artwork downloads from Cart Studio"}),
            )
        } else if let Some(Artwork::Cache(cache)) = artwork {
            match path {
                "api/artwork/download" => match cache.start_download() {
                    Ok(value) => (200, value),
                    Err(error) => (503, serde_json::json!({"error": error})),
                },
                "api/artwork/cancel" => (200, cache.cancel_download()),
                _ => (200, cache.download_status()),
            }
        } else {
            (
                503,
                serde_json::json!({"error": "Use the automatic artwork cache to download assets"}),
            )
        };
        return reply(
            &stream,
            status,
            "application/json",
            &serde_json::to_vec(&body).unwrap(),
            head,
            None,
            expected,
        );
    }

    if let Some(relative) = path.strip_prefix("art/") {
        if method != "GET" && !head {
            return reply(
                &stream,
                405,
                "text/plain",
                b"method not allowed",
                false,
                None,
                "GET, HEAD",
            );
        }
        let bytes = match artwork {
            Some(Artwork::Directory(root)) => Ok(art_file(root, relative)),
            Some(Artwork::Cache(cache)) => cache.read(relative),
            None => Ok(None),
        };
        return match bytes {
            Ok(Some(bytes)) => reply(
                &stream,
                200,
                content_type(relative),
                &bytes,
                head,
                None,
                "GET, HEAD",
            ),
            Ok(None) => reply(
                &stream,
                404,
                "text/plain",
                b"not found",
                head,
                None,
                "GET, HEAD",
            ),
            Err(error) => {
                eprintln!("Cart Studio artwork: {error}");
                reply(
                    &stream,
                    503,
                    "application/json",
                    &serde_json::to_vec(&serde_json::json!({"error": error})).unwrap(),
                    head,
                    Some("5"),
                    "GET, HEAD",
                )
            }
        };
    }

    if path == "api/music/search" {
        let response = if method == "GET" {
            music.search(target)
        } else {
            music::Response::error(405, "Use GET for album search")
        };
        return reply(
            &stream,
            response.status,
            "application/json",
            &response.body,
            head,
            response.retry_after.as_deref(),
            "GET",
        );
    }
    let (status, kind, body): (u16, &str, &[u8]) = if method != "GET" && !head {
        (405, "text/plain", b"method not allowed")
    } else if path == "config.js" {
        (
            200,
            "text/javascript; charset=utf-8",
            if artwork.is_some() {
                LOCAL_ART_CONFIG
            } else {
                CONFIG
            },
        )
    } else {
        match FILES.iter().find(|(name, _)| *name == path) {
            Some((name, bytes)) => (200, content_type(name), bytes),
            None => (404, "text/plain", b"not found"),
        }
    };
    reply(&stream, status, kind, body, head, None, "GET, HEAD")
}

fn art_file(root: &Path, relative: &str) -> Option<Vec<u8>> {
    if relative.contains(['\\', '%', ':'])
        || Path::new(relative)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let parts: Vec<_> = relative.split('/').collect();
    let media = parts.len() == 3
        && ["GBA", "GB", "GBC", "SNES", "PSX"].contains(&parts[0])
        && ["wheel", "boxart", "support-texture", "support-scan"].contains(&parts[1])
        && parts[2].ends_with(".png");
    let database = parts.len() == 2
        && parts[0] == "dat"
        && ["GBA.dat", "GB.dat", "GBC.dat", "SNES.dat", "PSX.dat"].contains(&parts[1]);
    if !["index.json", "library.json"].contains(&relative) && !media && !database {
        return None;
    }
    let file = root.join(relative).canonicalize().ok()?;
    if !file.starts_with(root) {
        return None;
    }
    std::fs::read(file).ok()
}

fn reply(
    mut out: &TcpStream,
    status: u16,
    kind: &str,
    body: &[u8],
    head: bool,
    retry_after: Option<&str>,
    allowed: &str,
) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        403 => "Forbidden",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    write!(
        out,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\n\
         Cache-Control: no-cache\r\nConnection: close\r\n",
        body.len()
    )?;
    if let Some(seconds) = retry_after {
        write!(out, "Retry-After: {seconds}\r\n")?;
    }
    if status == 405 {
        write!(out, "Allow: {allowed}\r\n")?;
    }
    write!(out, "\r\n")?;
    if !head {
        out.write_all(body)?;
    }
    out.flush()
}

fn content_type(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        // Anything else and the browser refuses to compile it as it streams.
        "wasm" => "application/wasm",
        "png" => "image/png",
        "gif" => "image/gif",
        "txt" => "text/plain; charset=utf-8",
        "json" => "application/json",
        "dat" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn open(url: &str) -> bool {
    #[cfg(windows)]
    let mut command = {
        let mut c = Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let mut command = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    command.spawn().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn request(method: &str, path: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            serve(
                listener.accept().unwrap().0,
                &music::MusicSearch::new(),
                None,
            )
            .unwrap();
        });
        let mut stream = TcpStream::connect(address).unwrap();
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        server.join().unwrap();
        response
    }

    #[test]
    fn desktop_config_uses_the_local_api_and_invalid_searches_do_not_contact_upstream() {
        let config = request("GET", "/config.js");
        assert!(config.starts_with("HTTP/1.1 200"));
        assert!(config.contains("new URL('/api/music/', location.origin).href"));
        assert!(!config.contains("studio.slot-cfw.fyi"));
        let missing = request("GET", "/api/music/search?album=");
        assert!(missing.starts_with("HTTP/1.1 400"));
        assert!(missing.contains("application/json"));
        let post = request("POST", "/api/music/search?album=Album");
        assert!(post.starts_with("HTTP/1.1 405"));
        assert!(post.contains("Allow: GET\r\n"));
    }

    #[test]
    fn artwork_download_endpoints_require_the_app_origin_and_correct_methods() {
        fn call(method: &str, path: &str, local_origin: bool) -> String {
            let directory = tempfile::tempdir().unwrap();
            let cache = artwork::ArtworkCache::new(directory.path().to_owned(), false).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                serve(
                    listener.accept().unwrap().0,
                    &music::MusicSearch::new(),
                    Some(&Artwork::Cache(Arc::new(cache))),
                )
                .unwrap();
            });
            let mut stream = TcpStream::connect(address).unwrap();
            let origin = if local_origin {
                format!("http://{address}")
            } else {
                "https://example.com".into()
            };
            write!(stream, "{method} {path} HTTP/1.1\r\nHost: {address}\r\nOrigin: {origin}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            server.join().unwrap();
            response
        }
        assert!(call("GET", "/api/artwork/status", true).starts_with("HTTP/1.1 200"));
        assert!(call("GET", "/api/artwork/download", true).starts_with("HTTP/1.1 405"));
        assert!(call("POST", "/api/artwork/download", false).starts_with("HTTP/1.1 403"));
        let response = call("POST", "/api/artwork/download", true);
        assert!(response.starts_with("HTTP/1.1 503"));
        assert!(response.contains("--no-art-download"));
        assert!(call("POST", "/api/artwork/cancel", true).starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn local_art_only_serves_the_index_and_contained_media() {
        let root = std::env::temp_dir().join(format!("studio-art-{}", std::process::id()));
        std::fs::create_dir_all(root.join("SNES/support-texture")).unwrap();
        std::fs::write(root.join("index.json"), b"{}").unwrap();
        std::fs::write(root.join("SNES/support-texture/test.png"), b"label").unwrap();
        std::fs::create_dir_all(root.join("dat")).unwrap();
        std::fs::write(root.join("dat/PSX.dat"), b"database").unwrap();
        std::fs::write(root.join("library.json"), b"{}").unwrap();
        let canonical = root.canonicalize().unwrap();
        assert_eq!(art_file(&canonical, "index.json"), Some(b"{}".to_vec()));
        assert_eq!(
            art_file(&canonical, "SNES/support-texture/test.png"),
            Some(b"label".to_vec())
        );
        assert_eq!(
            art_file(&canonical, "dat/PSX.dat"),
            Some(b"database".to_vec())
        );
        assert_eq!(art_file(&canonical, "library.json"), Some(b"{}".to_vec()));
        for path in [
            "../index.json",
            "SNES/../index.json",
            "source/raw.png",
            "sources.json",
            "SNES\\support-texture\\test.png",
            "%2e%2e/index.json",
        ] {
            assert_eq!(art_file(&canonical, path), None, "{path}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installed_collection_is_discovered_beside_the_executable() {
        let root = std::env::temp_dir().join(format!("studio-discover-{}", std::process::id()));
        let art = root.join("cart-studio-art");
        std::fs::create_dir_all(&art).unwrap();
        let exe = root.join("cart-studio.exe");
        assert_eq!(adjacent_art(&exe), None);
        std::fs::write(art.join("index.json"), b"{}").unwrap();
        std::fs::write(art.join("library.json"), b"{}").unwrap();
        assert_eq!(adjacent_art(&exe), Some(art));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artwork_cli_accepts_a_path_and_rejects_missing_values() {
        let opts = options(
            ["--no-open", "--art-dir", "local art"]
                .map(Into::into)
                .into_iter(),
        )
        .unwrap();
        assert!(opts.no_open);
        assert_eq!(opts.art_dir, Some(PathBuf::from("local art")));
        assert!(options(["--art-dir", "--no-open"].map(Into::into).into_iter()).is_err());
        let opts = options(
            ["--cache-dir", "cache with spaces", "--no-art-download"]
                .map(Into::into)
                .into_iter(),
        )
        .unwrap();
        assert_eq!(opts.cache_dir, Some(PathBuf::from("cache with spaces")));
        assert!(opts.no_art_download);
        assert!(options(["--cache-dir", "--no-open"].map(Into::into).into_iter()).is_err());
    }
}
