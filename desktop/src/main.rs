//! The studio as one file: web/ compiled in, served on localhost, and opened in the default
//! browser. Game names and artwork are fetched from the network; the UI is bundled locally.
use std::io::{self, BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

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
    help: bool,
}

fn options(args: impl Iterator<Item = std::ffi::OsString>) -> Result<Options, String> {
    let mut result = Options::default();
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--no-open") => result.no_open = true,
            Some("--help" | "-h") => result.help = true,
            Some("--art-dir") => {
                let path = args.next().filter(|p| !p.to_string_lossy().starts_with("--"))
                    .ok_or("--art-dir requires a directory containing index.json")?;
                result.art_dir = Some(PathBuf::from(path));
            }
            _ => return Err(format!("unknown option: {}; use --help", arg.to_string_lossy())),
        }
    }
    Ok(result)
}

fn main() {
    let opts = options(std::env::args_os().skip(1)).unwrap_or_else(|error| {
        eprintln!("Cart Studio: {error}");
        std::process::exit(2)
    });
    if opts.help {
        println!("Usage: cart-studio [--no-open] [--art-dir PATH]");
        println!("Serve a local artwork collection containing index.json; opens your browser by default.");
        return;
    }
    let art_dir = Arc::new(opts.art_dir.map(|path| {
        let root = path.canonicalize()?;
        let index = std::fs::read(root.join("index.json"))?;
        let value: serde_json::Value = serde_json::from_slice(&index)?;
        if !value.is_object() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "index.json must be an object"));
        }
        Ok::<_, io::Error>(root)
    }).transpose().unwrap_or_else(|error| {
        eprintln!("Cart Studio: cannot open --art-dir: {error}");
        std::process::exit(2)
    }));

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
    if let Some(root) = art_dir.as_ref() {
        println!("Local artwork: {}", root.display());
    }
    if !opts.no_open && !open(&url) {
        println!("Open that address in a browser.");
    }

    let music = Arc::new(music::MusicSearch::new());
    for stream in listener.incoming().flatten() {
        let music = Arc::clone(&music);
        let art_dir = Arc::clone(&art_dir);
        thread::spawn(move || {
            let _ = serve(stream, &music, art_dir.as_deref());
        });
    }
}

fn serve(stream: TcpStream, music: &music::MusicSearch, art_dir: Option<&Path>) -> io::Result<()> {
    // Browsers open connections ahead of need and leave some of them silent.
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(&stream);

    let mut request = String::new();
    reader.read_line(&mut request)?;
    let mut words = request.split_whitespace();
    let (method, target) = (words.next().unwrap_or(""), words.next().unwrap_or(""));

    // The headers are read and dropped; closing on unread input resets the connection.
    let mut header = String::new();
    loop {
        header.clear();
        if reader.read_line(&mut header)? <= 2 {
            break;
        }
    }

    let path = target
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let head = method == "HEAD";

    if let Some(relative) = path.strip_prefix("art/") {
        if method != "GET" && !head {
            return reply(&stream, 405, "text/plain", b"method not allowed", false, None, "GET, HEAD");
        }
        let bytes = art_dir.and_then(|root| art_file(root, relative));
        return match bytes {
            Some(bytes) => reply(&stream, 200, content_type(relative), &bytes, head, None, "GET, HEAD"),
            None => reply(&stream, 404, "text/plain", b"not found", head, None, "GET, HEAD"),
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
        (200, "text/javascript; charset=utf-8", if art_dir.is_some() { LOCAL_ART_CONFIG } else { CONFIG })
    } else {
        match FILES.iter().find(|(name, _)| *name == path) {
            Some((name, bytes)) => (200, content_type(name), bytes),
            None => (404, "text/plain", b"not found"),
        }
    };
    reply(&stream, status, kind, body, head, None, "GET, HEAD")
}

fn art_file(root: &Path, relative: &str) -> Option<Vec<u8>> {
    if relative.contains(['\\', '%', ':']) ||
        Path::new(relative).components().any(|part| !matches!(part, Component::Normal(_))) {
        return None;
    }
    let parts: Vec<_> = relative.split('/').collect();
    let media = parts.len() == 3 && ["GBA", "GB", "GBC", "SNES", "PSX"].contains(&parts[0]) &&
        ["wheel", "support-texture", "support-scan"].contains(&parts[1]) && parts[2].ends_with(".png");
    if relative != "index.json" && !media {
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
            serve(listener.accept().unwrap().0, &music::MusicSearch::new(), None).unwrap();
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
    fn local_art_only_serves_the_index_and_contained_media() {
        let root = std::env::temp_dir().join(format!("studio-art-{}", std::process::id()));
        std::fs::create_dir_all(root.join("SNES/support-texture")).unwrap();
        std::fs::write(root.join("index.json"), b"{}").unwrap();
        std::fs::write(root.join("SNES/support-texture/test.png"), b"label").unwrap();
        let canonical = root.canonicalize().unwrap();
        assert_eq!(art_file(&canonical, "index.json"), Some(b"{}".to_vec()));
        assert_eq!(art_file(&canonical, "SNES/support-texture/test.png"), Some(b"label".to_vec()));
        for path in ["../index.json", "SNES/../index.json", "source/raw.png", "sources.json", "SNES\\support-texture\\test.png", "%2e%2e/index.json"] {
            assert_eq!(art_file(&canonical, path), None, "{path}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artwork_cli_accepts_a_path_and_rejects_missing_values() {
        let opts = options(["--no-open", "--art-dir", "local art"].map(Into::into).into_iter()).unwrap();
        assert!(opts.no_open);
        assert_eq!(opts.art_dir, Some(PathBuf::from("local art")));
        assert!(options(["--art-dir", "--no-open"].map(Into::into).into_iter()).is_err());
    }
}
