// Compiles ../web into the binary as a table of (path, bytes): every file the page loads, and
// none of the tests or wasm-pack's packaging beside them.
use std::path::{Path, PathBuf};
use std::{env, fs};

const KINDS: &[&str] = &["html", "css", "js", "wasm", "png", "svg", "ico", "woff2"];
const WASM: &str = "pkg/slot_cart_studio_bg.wasm";
const MUSIC: &str = "vendor/music-metadata.js";

fn main() {
    let web = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../web");
    println!("cargo:rerun-if-changed={}", web.display());

    let mut files = Vec::new();
    walk(&web, &web, &mut files);
    files.sort();
    assert!(
        files.iter().any(|(name, _)| name == WASM),
        "web/{WASM} is missing: build it first with ./run.sh --build-only"
    );
    assert!(
        files.iter().any(|(name, _)| name == MUSIC),
        "web/{MUSIC} is missing: build it first with npm ci && npm run build"
    );

    let mut table = String::from("static FILES: &[(&str, &[u8])] = &[\n");
    for (name, path) in &files {
        table.push_str(&format!("    ({name:?}, include_bytes!({path:?})),\n"));
    }
    table.push_str("];\n");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("web.rs");
    fs::write(out, table).unwrap();
}

fn walk(root: &Path, dir: &Path, files: &mut Vec<(String, String)>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            walk(root, &path, files);
            continue;
        }
        let kind = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !KINDS.contains(&kind) {
            continue;
        }
        let name = path
            .strip_prefix(root)
            .unwrap()
            .to_str()
            .unwrap()
            .replace('\\', "/");
        let path = path.canonicalize().unwrap().to_str().unwrap().to_owned();
        files.push((name, path));
    }
}
