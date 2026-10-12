//! MusicBrainz lookup for the desktop app's local server.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use unicode_normalization::UnicodeNormalization;

const UPSTREAM: &str = "https://musicbrainz.org/ws/2/release-group/";
const USER_AGENT: &str = "slot-cart-studio/0.1 (https://studio.slot-cfw.fyi/)";
const INTERVAL: Duration = Duration::from_millis(1100);
const DAY: Duration = Duration::from_secs(86400);
const MAX_BODY: u64 = 1024 * 1024;
const MAX_CACHE_BYTES: usize = 8 * 1024 * 1024;

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
    pub retry_after: Option<String>,
}

impl Response {
    pub fn error(status: u16, message: &str) -> Self {
        Self {
            status,
            body: serde_json::to_vec(&json!({ "error": message })).unwrap(),
            retry_after: None,
        }
    }

    fn busy(status: u16, seconds: u64) -> Self {
        let mut response = Self::error(
            status,
            "Album search is busy or unavailable. Try again shortly.",
        );
        response.retry_after = Some(seconds.max(1).to_string());
        response
    }
}

struct Cached {
    body: Vec<u8>,
    expires: Instant,
}

struct State {
    next_start: Instant,
    cooldown: Option<Instant>,
    failures: u32,
    cache: HashMap<String, Cached>,
}

impl State {
    fn cached(&mut self, key: &str) -> Option<Response> {
        self.cache.retain(|_, value| value.expires > Instant::now());
        self.cache.get(key).map(|entry| Response {
            status: 200,
            body: entry.body.clone(),
            retry_after: None,
        })
    }

    fn cooling_down(&self) -> Option<Response> {
        let remaining = self.cooldown?.checked_duration_since(Instant::now())?;
        Some(Response::busy(503, remaining.as_secs() + 1))
    }
}

pub struct MusicSearch {
    agent: ureq::Agent,
    endpoint: String,
    state: Mutex<State>,
    serial: Mutex<()>,
    pending: AtomicUsize,
}

struct Pending<'a>(&'a AtomicUsize);
impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl MusicSearch {
    pub fn new() -> Self {
        Self {
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(10)))
                .http_status_as_error(false)
                .max_redirects(0)
                .build()
                .into(),
            endpoint: UPSTREAM.into(),
            state: Mutex::new(State {
                // A short startup pause also avoids a burst after quickly restarting the app.
                next_start: Instant::now() + INTERVAL,
                cooldown: None,
                failures: 0,
                cache: HashMap::new(),
            }),
            serial: Mutex::new(()),
            pending: AtomicUsize::new(0),
        }
    }

    pub fn search(&self, target: &str) -> Response {
        let (artist, album) = match search_terms(target) {
            Ok(terms) => terms,
            Err(response) => return response,
        };
        let key = json!([artist.to_lowercase(), album.to_lowercase()]).to_string();
        {
            let mut state = self.state.lock().unwrap();
            if let Some(response) = state.cached(&key).or_else(|| state.cooling_down()) {
                return response;
            }
        }
        if self
            .pending
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < 8).then_some(count + 1)
            })
            .is_err()
        {
            return Response::busy(429, 3);
        }
        let _pending = Pending(&self.pending);
        let _serial = self.serial.lock().unwrap();
        let delay = {
            let mut state = self.state.lock().unwrap();
            // Duplicates waiting behind another request reuse its successful result.
            if let Some(response) = state.cached(&key).or_else(|| state.cooling_down()) {
                return response;
            }
            state.next_start.saturating_duration_since(Instant::now())
        };
        std::thread::sleep(delay);
        self.state.lock().unwrap().next_start = Instant::now() + INTERVAL;
        let query = form_urlencoded::Serializer::new(String::new())
            .append_pair("query", &search_query(&artist, &album))
            .append_pair("fmt", "json")
            .append_pair("limit", "8")
            .finish();
        let upstream = self
            .agent
            .get(format!("{}?{query}", self.endpoint))
            .header("User-Agent", USER_AGENT)
            .header("Accept", "application/json")
            .call();
        let mut upstream = match upstream {
            Ok(response) => response,
            Err(_) => return self.failed(None),
        };
        if !upstream.status().is_success() {
            let retry = upstream
                .headers()
                .get("Retry-After")
                .and_then(|value| value.to_str().ok())
                .and_then(retry_delay);
            return self.failed(retry);
        }
        let mut bytes = Vec::new();
        if upstream
            .body_mut()
            .as_reader()
            .take(MAX_BODY + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_BODY
        {
            return self.failed(None);
        }
        let body = match serde_json::from_slice(&bytes)
            .ok()
            .and_then(normalize_candidates)
        {
            Some(candidates) => serde_json::to_vec(&json!({ "candidates": candidates })).unwrap(),
            None => return self.failed(None),
        };
        let mut state = self.state.lock().unwrap();
        // Pace from completion too: a cold TLS connection must not cause a later burst.
        state.next_start = Instant::now() + INTERVAL;
        state.failures = 0;
        state.cooldown = None;
        state.cache.insert(
            key,
            Cached {
                body: body.clone(),
                expires: Instant::now() + DAY,
            },
        );
        while state.cache.len() > 256
            || state
                .cache
                .values()
                .map(|entry| entry.body.len())
                .sum::<usize>()
                > MAX_CACHE_BYTES
        {
            let oldest = state
                .cache
                .iter()
                .min_by_key(|(_, entry)| entry.expires)
                .map(|(key, _)| key.clone())
                .unwrap();
            state.cache.remove(&oldest);
        }
        Response {
            status: 200,
            body,
            retry_after: None,
        }
    }

    fn failed(&self, retry: Option<Duration>) -> Response {
        let mut state = self.state.lock().unwrap();
        state.next_start = Instant::now() + INTERVAL;
        state.failures = state.failures.saturating_add(1);
        let backoff = Duration::from_secs((3 * 2_u64.pow(state.failures.min(5) - 1)).min(60));
        let delay = retry.unwrap_or(backoff).max(backoff).min(DAY);
        state.cooldown = Some(Instant::now() + delay);
        Response::busy(503, delay.as_secs().max(1))
    }
}

fn search_terms(target: &str) -> Result<(String, String), Response> {
    let mut artist = None;
    let mut album = None;
    for (name, value) in form_urlencoded::parse(
        target
            .split_once('?')
            .map_or("", |(_, query)| query)
            .as_bytes(),
    ) {
        if name == "artist" && artist.is_none() {
            artist = Some(value.into_owned());
        } else if name == "album" && album.is_none() {
            album = Some(value.into_owned());
        }
    }
    let artist: String = artist.unwrap_or_default().trim().nfc().collect();
    let album: String = album.unwrap_or_default().trim().nfc().collect();
    if album.is_empty()
        || album.chars().count() > 200
        || artist.chars().count() > 200
        || artist.chars().chain(album.chars()).any(char::is_control)
    {
        return Err(Response::error(
            400,
            "Enter an album title and an optional artist, up to 200 characters each.",
        ));
    }
    Ok((artist, album))
}

fn search_query(artist: &str, album: &str) -> String {
    let escape = |text: &str| {
        let mut escaped = String::new();
        for c in text.chars() {
            if "+-&|!(){}[]^\"~*?:\\/".contains(c) {
                escaped.push('\\');
            }
            escaped.push(c);
        }
        escaped
    };
    let mut query = format!("releasegroup:\"{}\"", escape(album));
    if !artist.is_empty() {
        query.push_str(&format!(" AND artist:\"{}\"", escape(artist)));
    }
    query
}

fn normalize_candidates(data: Value) -> Option<Vec<Value>> {
    let groups = data.get("release-groups")?.as_array()?;
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for group in groups {
        let Some(id) = group["id"].as_str() else {
            continue;
        };
        if id.len() != 36
            || !id.bytes().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    c == b'-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
            || !seen.insert(id)
        {
            continue;
        }
        let mut artist = String::new();
        for credit in group["artist-credit"].as_array().into_iter().flatten() {
            if let Some(text) = credit.as_str() {
                artist.push_str(text);
            } else {
                artist.push_str(
                    credit["name"]
                        .as_str()
                        .or_else(|| credit["artist"]["name"].as_str())
                        .unwrap_or(""),
                );
                artist.push_str(credit["joinphrase"].as_str().unwrap_or(""));
            }
        }
        let score = group["score"]
            .as_f64()
            .or_else(|| group["score"].as_str().and_then(|score| score.parse().ok()))
            .filter(|score| score.is_finite())
            .unwrap_or(0.0);
        candidates.push(json!({
            "id": id, "title": group["title"].as_str().unwrap_or(""), "artist": artist,
            "year": group["first-release-date"].as_str().unwrap_or("").chars().take(4).collect::<String>(),
            "type": group["primary-type"].as_str().unwrap_or(""), "score": score,
            "sourceUrl": format!("https://musicbrainz.org/release-group/{id}")
        }));
    }
    candidates.sort_by(|a, b| {
        b["score"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&a["score"].as_f64().unwrap_or(0.0))
            .then_with(|| (b["type"] == "Album").cmp(&(a["type"] == "Album")))
            .then_with(|| a["title"].as_str().cmp(&b["title"].as_str()))
    });
    candidates.truncate(8);
    Some(candidates)
}

fn retry_delay(value: &str) -> Option<Duration> {
    value
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
        .or_else(|| {
            httpdate::parse_http_date(value)
                .ok()?
                .duration_since(SystemTime::now())
                .ok()
        })
        .map(|delay| delay.min(DAY).max(Duration::from_secs(1)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{mpsc, Arc};
    use std::thread;

    const ID: &str = "48117b90-a16e-34ca-a514-19c702df1158";
    const GROUPS: &str = r#"{"release-groups":[{"id":"48117b90-a16e-34ca-a514-19c702df1158","title":"Discovery","score":"100","primary-type":"Album","first-release-date":"2001-03-12","artist-credit":[{"name":"Daft Punk"}]}]}"#;

    fn response(status: &str, headers: &str, body: &str) -> String {
        format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len())
    }

    fn fixture(
        responses: Vec<String>,
        pause: Option<mpsc::Receiver<()>>,
    ) -> (
        String,
        mpsc::Receiver<(Instant, String)>,
        thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/release-group/", listener.local_addr().unwrap());
        let (tx, requests) = mpsc::channel();
        let handle = thread::spawn(move || {
            for (index, response) in responses.into_iter().enumerate() {
                let start = Instant::now();
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                start.elapsed() < Duration::from_secs(5),
                                "Expected an upstream request"
                            );
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&stream);
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    request.push_str(&line);
                }
                tx.send((Instant::now(), request)).unwrap();
                if index == 0 {
                    if let Some(pause) = &pause {
                        pause.recv_timeout(Duration::from_secs(5)).unwrap();
                    }
                }
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (endpoint, requests, handle)
    }

    #[test]
    fn query_validation_escaping_unicode_and_candidate_contract() {
        let (artist, album) =
            search_terms("/api/music/search?artist=A%20%26%20B&album=Cafe%CC%81%20%22live%22")
                .unwrap_or_else(|_| panic!());
        assert_eq!(album, "Café \"live\"");
        assert_eq!(
            search_query(&artist, &album),
            "releasegroup:\"Café \\\"live\\\"\" AND artist:\"A \\& B\""
        );
        assert_eq!(
            search_query("", "Title (live)"),
            "releasegroup:\"Title \\(live\\)\""
        );
        assert!(search_terms("/api/music/search?album=").is_err());
        assert!(search_terms("/api/music/search?album=%00").is_err());
        assert!(search_terms(&format!("/api/music/search?album={}", "a".repeat(201))).is_err());
        let mut data: Value = serde_json::from_str(GROUPS).unwrap();
        let mut single = data["release-groups"][0].clone();
        single["id"] = json!("48117b90-a16e-34ca-a514-19c702df1159");
        single["primary-type"] = json!("Single");
        single["artist-credit"] =
            json!([{"name":"A", "joinphrase":" & "}, {"artist":{"name":"B"}}]);
        data["release-groups"].as_array_mut().unwrap().extend([
            single.clone(),
            single,
            json!({"id":"invalid"}),
        ]);
        let candidates = normalize_candidates(data).unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0]["id"], ID);
        assert_eq!(candidates[0]["year"], "2001");
        assert_eq!(candidates[1]["artist"], "A & B");
        assert_eq!(
            candidates[0]["sourceUrl"],
            format!("https://musicbrainz.org/release-group/{ID}")
        );
        assert_eq!(retry_delay("120"), Some(Duration::from_secs(120)));
        let date = httpdate::fmt_http_date(SystemTime::now() + Duration::from_secs(120));
        assert!(retry_delay(&date).unwrap() > Duration::from_secs(118));
    }

    #[test]
    fn concurrent_requests_are_paced_identified_and_cached() {
        let (endpoint, requests, server) = fixture(vec![response("200 OK", "", GROUPS); 2], None);
        let service = Arc::new(MusicSearch {
            endpoint,
            ..MusicSearch::new()
        });
        let jobs: Vec<_> = ["Discovery", "Discovery", "Other"]
            .into_iter()
            .map(|album| {
                let service = Arc::clone(&service);
                thread::spawn(move || {
                    service.search(&format!("/api/music/search?artist=Daft+Punk&album={album}"))
                })
            })
            .collect();
        for job in jobs {
            assert_eq!(job.join().unwrap().status, 200);
        }
        server.join().unwrap();
        let calls: Vec<_> = requests.try_iter().collect();
        assert_eq!(calls.len(), 2);
        assert!(calls[1].0.duration_since(calls[0].0) >= Duration::from_secs(1));
        assert!(calls[0]
            .1
            .to_lowercase()
            .contains(&format!("user-agent: {}", USER_AGENT.to_lowercase())));
        assert!(calls[0].1.contains("fmt=json&limit=8"));
        assert_eq!(
            service
                .search("/api/music/search?artist=DAFT+PUNK&album=discovery")
                .status,
            200
        );
        let mut state = service.state.lock().unwrap();
        assert_eq!(state.cache.len(), 2);
        assert!(
            state
                .cache
                .values()
                .all(|entry| entry.expires.duration_since(Instant::now())
                    > Duration::from_secs(86000))
        );
        for entry in state.cache.values_mut() {
            entry.expires = Instant::now();
        }
        assert!(state.cached("missing").is_none());
        assert!(state.cache.is_empty());
    }

    #[test]
    fn queue_overflow_and_global_retry_after_prevent_further_upstream_calls() {
        let (release, pause) = mpsc::channel();
        let (endpoint, requests, server) = fixture(
            vec![response(
                "503 Service Unavailable",
                "Retry-After: 5\r\n",
                "{}",
            )],
            Some(pause),
        );
        let service = Arc::new(MusicSearch {
            endpoint,
            ..MusicSearch::new()
        });
        let jobs: Vec<_> = (0..8)
            .map(|index| {
                let service = Arc::clone(&service);
                thread::spawn(move || {
                    service.search(&format!("/api/music/search?album=Album{index}"))
                })
            })
            .collect();
        let start = Instant::now();
        while service.pending.load(Ordering::Acquire) < 8 {
            assert!(start.elapsed() < Duration::from_secs(2));
            thread::sleep(Duration::from_millis(5));
        }
        let refused = service.search("/api/music/search?album=Overflow");
        assert_eq!(refused.status, 429);
        assert_eq!(refused.retry_after.as_deref(), Some("3"));
        requests.recv_timeout(Duration::from_secs(3)).unwrap();
        release.send(()).unwrap();
        for job in jobs {
            let response = job.join().unwrap();
            assert_eq!(response.status, 503);
            assert_eq!(response.retry_after.as_deref(), Some("5"));
        }
        server.join().unwrap();
        assert_eq!(service.pending.load(Ordering::Acquire), 0);
        assert_eq!(service.state.lock().unwrap().failures, 1);
        assert!(service.state.lock().unwrap().cache.is_empty());
        assert_eq!(
            service.search("/api/music/search?album=Another").status,
            503
        );
        assert_eq!(service.state.lock().unwrap().failures, 1);
    }

    #[test]
    fn invalid_and_oversized_upstream_responses_are_not_cached() {
        for body in [
            "invalid JSON".to_string(),
            "{}".to_string(),
            "x".repeat(MAX_BODY as usize + 20),
        ] {
            let (endpoint, requests, server) = fixture(vec![response("200 OK", "", &body)], None);
            let service = MusicSearch {
                endpoint,
                ..MusicSearch::new()
            };
            let result = service.search("/api/music/search?album=Album");
            assert_eq!(result.status, 503);
            assert_eq!(result.retry_after.as_deref(), Some("3"));
            assert!(service.state.lock().unwrap().cache.is_empty());
            server.join().unwrap();
            assert_eq!(requests.try_iter().count(), 1);
        }
    }
}
