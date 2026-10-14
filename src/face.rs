//! Previews for labels held in memory: SNES artwork alone, other carts drawn by slot.

use std::path::Path;

use slot_store::Platform;

use crate::{art, cart};

/// SNES shows the label alone; other platforms keep the device's cart face.
pub fn size(platform: Platform) -> (u32, u32) {
    if platform == Platform::Snes {
        (crate::label::SNES_W / 4, crate::label::SNES_H / 4)
    } else {
        cart::cart_box(platform)
    }
}

/// The platform a card folder names. It picks the GBA cart, a Game Boy pak or the PlayStation
/// case; which pak, and its plastic, is the header's to say. Anything unrecognised is GBA, which
/// is the folder the page falls back to as well.
pub fn platform_of(dir: &str) -> Platform {
    match dir {
        "GB" => Platform::Gb,
        "GBC" => Platform::Gbc,
        "PSX" => Platform::Psx,
        "SNES" => Platform::Snes,
        _ => Platform::Gba,
    }
}

/// Slot's `cart_face` reads a cart's label through `art::cover` and its pak's header through
/// `gb`. Both answer from a stash here, so the cart names the stash keys where file paths
/// would go. The title is left empty because slot's generated label is titled from the stem, not
/// the header. `shell` is the choice empty for Automatic.
fn draw(
    platform: Platform,
    code: &str,
    head: &[u8],
    shell: &str,
    stem: &str,
    key: &Path,
) -> Vec<u8> {
    if platform == Platform::Snes {
        let (w, h) = size(platform);
        if let Some(rgba) = art::cover(key, w, h) {
            return rgba;
        }
        // Keep a readable title placeholder when there is no artwork yet.
        let title = cart::clean_label(stem);
        let colour = cart::label_colour(&title);
        let mut rgba = [colour[0], colour[1], colour[2], 255].repeat((w * h) as usize);
        if let Some(font) = crate::text::label_font() {
            let layout = crate::text::fit(font, &title, w as f32 - 20.0, 4, 30.0, 10.0);
            let ink = if colour.iter().map(|v| *v as u32).sum::<u32>() > 384 {
                [24, 24, 24]
            } else {
                [240, 240, 240]
            };
            crate::text::draw_centred(&mut rgba, w, h, &layout, ink);
        }
        return rgba;
    }
    slot_store::gb::with_header(head, |rom| {
        cart::cart_face(&slot_store::Cart {
            platform,
            stem: stem.to_string(),
            rom: rom.to_path_buf(),
            label: Some(key.to_path_buf()),
            title: String::new(),
            code: code.to_string(),
            shell: slot_store::ShellChoice::parse(shell),
        })
        .rgba
    })
}

/// PNG bytes as a card holds them. Bytes that don't decode fall back to slot's generated label,
/// as they do on the device.
pub fn from_png(
    png: &[u8],
    platform: Platform,
    code: &str,
    head: &[u8],
    shell: &str,
    stem: &str,
) -> Vec<u8> {
    art::with_png(png, |key| draw(platform, code, head, shell, stem, key))
}

/// Straight RGBA, `w` by `h`: a label composed in memory, shown without a PNG round trip.
#[allow(clippy::too_many_arguments)]
pub fn from_rgba(
    rgba: &[u8],
    w: u32,
    h: u32,
    platform: Platform,
    code: &str,
    head: &[u8],
    shell: &str,
    stem: &str,
) -> Vec<u8> {
    art::with_rgba(rgba, w, h, |key| {
        draw(platform, code, head, shell, stem, key)
    })
}
