import { limiter } from './libretro.js';
import { coverHistory, coverMime, editCover, fetchCover, prepareCover, searchAlbums } from './music.js';

const $ = (id) => document.getElementById(id);
const previews = limiter(4);

export function setCoverImage(image, asset) {
  if (image.dataset.assetUrl) URL.revokeObjectURL(image.dataset.assetUrl);
  delete image.dataset.assetUrl;
  image.hidden = !asset;
  if (!asset) { image.removeAttribute('src'); return; }
  image.dataset.assetUrl = URL.createObjectURL(asset.blob);
  image.src = image.dataset.assetUrl;
}

export function createMusicEditor({ base, changed, closeCart, canEdit }) {
  let album = null;
  let controller = null;
  let generation = 0;
  let selecting = false;
  let pendingFields = null;
  const panel = $('music-editor');
  const stop = () => { controller?.abort(); generation++; selecting = false; };
  function refresh() {
    if (!album) return;
    $('music-name').textContent = album.title;
    $('music-identity').textContent = `${album.artist} · ${album.path}`;
    setCoverImage($('music-face'), album.selected);
    $('music-placeholder').hidden = !!album.selected;
    const blocked = album.loading || selecting || !canEdit();
    $('music-search').disabled = blocked;
    $('music-import').disabled = blocked;
    $('music-undo').disabled = blocked || !album.history.undo.length;
    $('music-redo').disabled = blocked || !album.history.redo.length;
    $('music-revert').disabled = blocked || album.selected === album.original;
  }
  function message(value) { $('music-message').textContent = value; }
  function newRequest() {
    stop();
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    const version = generation;
    const target = album;
    return { target, signal, current: () => album === target && generation === version && !signal.aborted,
      owns: () => album === target && generation === version };
  }
  function clearHits() {
    for (const image of $('music-hits').querySelectorAll('img')) setCoverImage(image, null);
    $('music-hits').replaceChildren();
  }
  async function select(candidate) {
    if (!canEdit()) return;
    const request = newRequest();
    selecting = true;
    refresh();
    message('Loading the cover…');
    try {
      const blob = await fetchCover(candidate.id, 1200, request.signal);
      if (!blob) throw new Error('This album has no front cover. Choose another result or import an image.');
      const asset = await prepareCover(blob, coverMime(request.target));
      asset.sourceUrl = candidate.sourceUrl;
      if (!request.current() || !canEdit()) return;
      editCover(request.target, asset);
      changed(request.target);
      message('Cover selected. Use the save button to write it to the card.');
    } catch (e) {
      if (request.owns()) message(e.message);
    } finally {
      if (request.owns()) { selecting = false; refresh(); }
    }
  }
  async function search() {
    if (!album || album.loading || !canEdit()) return;
    const title = $('music-album').value.trim();
    if (!title) { message('Enter an album title to search.'); return; }
    const request = newRequest();
    clearHits();
    message('Looking for album covers…');
    try {
      const candidates = await searchAlbums(base, $('music-artist').value, title, request.signal);
      if (!request.current()) return;
      message(candidates.length ? 'Choose a cover below, or adjust the search.' : 'No albums found. Adjust the search or import an image.');
      for (const candidate of candidates) {
        const li = document.createElement('li');
        const button = Object.assign(document.createElement('button'), { type: 'button', className: 'music-hit', disabled: true });
        const image = Object.assign(document.createElement('img'), { alt: `${candidate.title} cover`, hidden: true });
        const heading = Object.assign(document.createElement('strong'), { textContent: candidate.title });
        const artist = Object.assign(document.createElement('span'), { textContent: candidate.artist });
        const info = Object.assign(document.createElement('small'), { textContent: [candidate.year, candidate.type].filter(Boolean).join(' · ') });
        const status = Object.assign(document.createElement('small'), { textContent: 'Loading preview…' });
        button.append(image, heading, artist, info, status);
        button.addEventListener('click', () => select(candidate));
        li.append(button);
        $('music-hits').append(li);
        previews(async () => {
          if (!request.current()) return;
          try {
            const blob = await fetchCover(candidate.id, 250, request.signal);
            if (!request.current()) return;
            if (!blob) { status.textContent = 'No front cover available'; return; }
            const asset = await prepareCover(blob);
            if (!request.current()) return;
            setCoverImage(image, asset);
            status.textContent = '';
            button.disabled = false;
          } catch {
            if (request.current()) { status.textContent = 'Preview unavailable. Click to retry'; button.disabled = false; }
          }
        });
      }
    } catch (e) {
      if (request.owns()) message(e.message);
    }
  }
  function close() {
    stop();
    clearHits();
    album?.el?.root.classList.remove('current');
    album = null;
    pendingFields = null;
    setCoverImage($('music-face'), null);
    panel.hidden = true;
    if ($('editor').hidden) document.body.classList.remove('editing');
  }
  function open(next) {
    if (album === next) return;
    close();
    closeCart();
    album = next;
    album.el.root.classList.add('current');
    $('music-artist').value = album.artist === 'Unknown Artist' ? '' : album.artist;
    $('music-album').value = album.title;
    pendingFields = album.loading ? { artist: $('music-artist').value, album: $('music-album').value } : null;
    message(album.artworkError ?? (album.artwork ? 'Your current cover is kept. Search or import to replace it.' : ''));
    panel.hidden = false;
    document.body.classList.add('editing');
    refresh();
    panel.focus({ preventScroll: true });
    if (!album.artwork && !album.loading) search();
  }
  $('music-close').addEventListener('click', close);
  $('music-search-form').addEventListener('submit', (e) => { e.preventDefault(); search(); });
  for (const id of ['music-artist', 'music-album']) $(id).addEventListener('input', () => { stop(); clearHits(); refresh(); });
  $('music-import').addEventListener('click', () => $('music-file').click());
  $('music-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !album || !canEdit()) return;
    const request = newRequest();
    selecting = true;
    refresh();
    try {
      const asset = await prepareCover(file, coverMime(request.target));
      if (!request.current() || !canEdit()) return;
      editCover(request.target, asset);
      changed(request.target);
      message('Cover selected. Use the save button to write it to the card.');
    } catch (error) {
      if (request.owns()) message(error.message);
    } finally {
      if (request.owns()) { selecting = false; refresh(); }
    }
  });
  for (const action of ['undo', 'redo', 'revert']) $(`music-${action}`).addEventListener('click', () => {
    if (album && canEdit() && coverHistory(album, action)) { changed(album); refresh(); }
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    e.preventDefault();
    if (!selecting && canEdit() && coverHistory(album, e.shiftKey ? 'redo' : 'undo')) { changed(album); refresh(); }
  });
  return { open, close, refresh, current: () => album, scanFinished: (next) => {
    if (album === next) {
      if (pendingFields) {
        if ($('music-artist').value === pendingFields.artist) $('music-artist').value = next.artist === 'Unknown Artist' ? '' : next.artist;
        if ($('music-album').value === pendingFields.album) $('music-album').value = next.title;
        pendingFields = null;
      }
      refresh();
      if (!next.artwork) search();
    }
  } };
}
