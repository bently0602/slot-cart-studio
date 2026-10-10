//! The studio as one file: web/ compiled in, served on localhost, and opened in the default
//! browser. The page still fetches game names, logos and its font from the network.
use std::io::{self, BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::process::Command;
use std::thread;
use std::time::Duration;

include!(concat!(env!("OUT_DIR"), "/web.rs"));

const PORT: u16 = 8765;

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

    for stream in listener.incoming().flatten() {
        thread::spawn(move || {
            let _ = serve(stream);
        });
    }
}

fn serve(stream: TcpStream) -> io::Result<()> {
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

    let (status, kind, body): (&str, &str, &[u8]) = if method != "GET" && !head {
        (
            "405 Method Not Allowed",
            "text/plain",
            b"method not allowed",
        )
    } else {
        match FILES.iter().find(|(name, _)| *name == path) {
            Some((name, bytes)) => ("200 OK", content_type(name), bytes),
            None => ("404 Not Found", "text/plain", b"not found"),
        }
    };

    let mut out = &stream;
    write!(
        out,
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\n\
         Cache-Control: no-cache\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
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
