//! The studio as one file: web/ compiled in, served on localhost, and opened in the default
//! browser. The page still fetches game names, logos and its font from the network.
use std::io::{self, BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

mod music;

include!(concat!(env!("OUT_DIR"), "/web.rs"));

const PORT: u16 = 8765;
const CONFIG: &[u8] =
    b"export const DEFAULT_MUSIC_API = new URL('/api/music/', location.origin).href;\n";

fn main() {
    let no_open = std::env::args().any(|a| a == "--no-open");

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
    if !no_open && !open(&url) {
        println!("Open that address in a browser.");
    }

    let music = Arc::new(music::MusicSearch::new());
    for stream in listener.incoming().flatten() {
        let music = Arc::clone(&music);
        thread::spawn(move || {
            let _ = serve(stream, &music);
        });
    }
}

fn serve(stream: TcpStream, music: &music::MusicSearch) -> io::Result<()> {
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
        (200, "text/javascript; charset=utf-8", CONFIG)
    } else {
        match FILES.iter().find(|(name, _)| *name == path) {
            Some((name, bytes)) => (200, content_type(name), bytes),
            None => (404, "text/plain", b"not found"),
        }
    };
    reply(&stream, status, kind, body, head, None, "GET, HEAD")
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
            serve(listener.accept().unwrap().0, &music::MusicSearch::new()).unwrap();
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
}
