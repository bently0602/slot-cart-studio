// HorizonJS owns the complete interface. Browser file APIs and artwork canvases
// are hosted inside framework components; application state stays in the controllers.
export function createStudioUi() {
  const H = window.Ext;
  if (!H?.Viewport) throw new Error('HorizonJS is missing. Run npm ci && npm run build.');
  H.BLANK_IMAGE_URL = './vendor/horizonjs/resources/images/default/s.gif';
  const encode = H.util.Format.htmlEncode;
  const buttons = {}, fields = {}, choices = {}, fillChoices = {};
  let progressDialogActive = false;
  let progressOptions = null;
  function maskBackground() {
    const blocked = progressDialogActive || ['cart-editor-window', 'music-editor-window', 'fill']
      .some(id => H.getCmp(id)?.isVisible());
    for (const id of ['studio-header', 'tabs', 'studio-status']) {
      const region = document.getElementById(id);
      if (region) region.inert = blocked;
    }
    for (const id of ['cart-editor-window', 'music-editor-window', 'fill', 'studio-about']) {
      const dialog = H.getCmp(id);
      if (dialog?.rendered) dialog.el.dom.inert = progressDialogActive;
    }
  }
  function button(id, text, config = {}) {
    const b = new H.Button({ id: 'control-' + id, text, handleMouseEvents: false, ...config });
    b.on('render', () => {
      const native = b.el.dom.querySelector('button');
      native.id = id;
      native.disabled = !!b.disabled;
    });
    const sync = () => { b.el.dom.querySelector('button').disabled = !!b.disabled; };
    b.on('disable', sync); b.on('enable', sync);
    buttons[id] = b;
    return b;
  }
  function box(id, config = {}) { return new H.BoxComponent({ id, autoEl: { tag: 'div' }, ...config }); }
  function text(id, label, config = {}) {
    return fields[id] = new H.form.TextField({ id, fieldLabel: label, anchor: '96%', ...config });
  }
  function combo(id, label, data = [], config = {}) {
    return fields[id] = new H.form.ComboBox({
      id, fieldLabel: label, anchor: '96%', triggerAction: 'all', mode: 'local',
      editable: false, forceSelection: true, displayField: 'label', valueField: 'value',
      store: new H.data.SimpleStore({ fields: ['value', 'label'], data }),
      tpl: '<tpl for="."><div class="x-combo-list-item">{label:htmlEncode}</div></tpl>', ...config,
    });
  }
  function file(id, accept) {
    const f = text(id, '', { inputType: 'file', hidden: true, hideLabel: true });
    f.on('render', () => { if (accept) f.el.dom.accept = accept; });
    return f;
  }
  function windowPanel(id, title, items, config = {}) {
    const preferredSize = { width: 620, height: 800 };
    const w = new H.Window({
      id, title, ...preferredSize, layout: 'fit', closeAction: 'hide',
      constrain: true, plain: true, modal: true, items, ...config,
    });
    w.render(document.body);
    w.el.dom.setAttribute('role', 'dialog');
    w.el.dom.setAttribute('aria-modal', 'true');
    w.el.dom.setAttribute('aria-labelledby', w.header.dom.id);
    const fit = () => {
      w.setSize(Math.min(preferredSize.width, innerWidth - 20), Math.min(preferredSize.height, innerHeight - 20));
      w.center();
    };
    w.on('show', fit);
    w.on('show', maskBackground);
    w.on('hide', maskBackground);
    H.EventManager.onWindowResize(() => { if (w.isVisible()) { fit(); w.doLayout(); } });
    return w;
  }
  const cartFace = box('ed-face', { autoEl: { tag: 'canvas', cls: 'editor-art' } });
  for (const [kind, label] of Object.entries({
    card: 'On the card', real: 'Real Label', logo: 'Logo Only',
    customLogo: 'Custom logo', customLabel: 'Custom label',
  })) {
    const canvas = box('choice-' + kind, { autoEl: { tag: 'canvas', cls: 'choice-art' } });
    const note = box('choice-note-' + kind);
    const choose = button('choose-' + kind, label);
    const panel = new H.Panel({
      id: 'choice-panel-' + kind, title: label, width: 178, autoHeight: true, bodyStyle: 'padding:6px',
      items: [canvas, note], buttons: [choose],
    });
    choices[kind] = { canvas, note, button: choose, panel };
  }
  const background = new H.form.FieldSet({
    id: 'ed-background-fieldset', title: 'Background', autoHeight: true,
    items: [combo('ed-bg-presets', 'Preset'), text('ed-bg-custom', 'Hex colour', {
      regex: /^#[0-9a-f]{6}$/i, regexText: 'Use a colour such as #336699.',
    })],
    buttons: [button('ed-bg-auto', 'Automatic'), button('ed-bg-palette', 'Palette')],
  });
  const shell = new H.form.FieldSet({
    id: 'ed-shell-fieldset', title: 'Shell', autoHeight: true,
    items: [combo('ed-shell-presets', 'Preset'), text('ed-shell-custom', 'Hex colour', {
      regex: /^#[0-9a-f]{6}$/i, regexText: 'Use a colour such as #336699.',
    }), combo('ed-finish', 'Finish', [['solid', 'Solid'], ['clear', 'Clear'], ['glitter', 'Glitter']]),
    combo('ed-outline', 'Outline', [['auto', 'Auto'], ['notched', 'Notched'], ['rounded', 'Rounded']])],
    buttons: [button('ed-shell-auto', 'Automatic'), button('ed-shell-palette', 'Palette')],
  });
  const cartForm = new H.FormPanel({
    id: 'editor', labelWidth: 78, autoScroll: true, bodyStyle: 'padding:10px',
    items: [cartFace, combo('ed-game', 'Game', [], { editable: true, minChars: 0, emptyText: 'Choose a game' }),
      new H.Panel({ title: 'Label', autoHeight: true, items: [
        choices.card.panel,
        new H.Panel({ border: false, layout: 'table', layoutConfig: { columns: 2 },
          autoHeight: true, items: Object.entries(choices).filter(([kind]) => kind !== 'card').map(([, c]) => c.panel) }),
      ] }),
      file('ed-file', 'image/png,.png'), background, shell],
    bbar: [button('ed-undo', 'Undo'), button('ed-redo', 'Redo'), '->', button('ed-revert', 'Revert')],
  });
  const cartEditor = windowPanel('cart-editor-window', 'Cart editor', cartForm, {
    buttons: [button('ed-close', 'Close')],
  });
  function layoutCartChoices() {
    // Use the form's usable width, including space taken by its vertical scrollbar.
    const width = cartForm.body.getViewSize().width - cartForm.body.getPadding('lr') - 2;
    for (const [kind, c] of Object.entries(choices)) c.panel.setSize(
      Math.floor(width / (kind === 'card' ? 1 : 2)));
    cartForm.doLayout();
  }
  cartEditor.on('resize', layoutCartChoices);
  const musicHits = new H.Panel({ id: 'music-hits', border: false, autoHeight: true });
  const musicForm = new H.FormPanel({
    id: 'music-editor', labelWidth: 58, autoScroll: true, bodyStyle: 'padding:10px',
    items: [box('music-identity'), box('music-face', {
      autoEl: { tag: 'img', cls: 'editor-art music-cover', alt: 'Selected album cover' },
    }), box('music-placeholder', { autoEl: { tag: 'p', html: 'No cover selected' } }),
    text('music-artist', 'Artist', { maxLength: 200 }), text('music-album', 'Album', { maxLength: 200 }),
    new H.Panel({ border: false, autoHeight: true,
      tbar: [button('music-search', 'Search covers'), button('music-import', 'Import JPEG or PNG')] }),
    file('music-file', 'image/jpeg,image/png,.jpg,.jpeg,.png'), box('music-message'), musicHits],
    bbar: [button('music-undo', 'Undo'), button('music-redo', 'Redo'), '->', button('music-revert', 'Revert')],
  });
  const musicEditor = windowPanel('music-editor-window', 'Album editor', musicForm, {
    buttons: [button('music-save', 'Write to card', { disabled: true }), button('music-close', 'Close')],
  });
  const about = new H.Window({
    id: 'studio-about',
    title: 'About Cart Studio', width: 440, height: 300, closeAction: 'hide', modal: true,
    autoScroll: true, bodyStyle: 'padding:16px', html:
      '<p>Game names and CRCs: <a href="https://github.com/libretro/libretro-database">libretro-database</a> (<a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>).</p>' +
      '<p>Game logos: <a href="https://www.screenscraper.fr/">ScreenScraper</a> (<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">CC BY-NC-SA 4.0</a>); fallback logos: <a href="https://github.com/libretro-thumbnails">libretro-thumbnails</a>.</p>' +
      '<p>Album matches: <a href="https://musicbrainz.org/">MusicBrainz</a>; covers: <a href="https://coverartarchive.org/">Cover Art Archive</a>.</p>' +
      '<p>Interface: <a href="https://github.com/HorizonJS/HorizonJS">HorizonJS</a> ' +
      '(<a href="vendor/horizonjs/LICENSE.txt">license</a>; <a href="vendor/horizonjs/ext-all-debug.js">source</a>).</p>' +
      '<p>Game Boy is a trademark of Nintendo. Not affiliated with Nintendo.</p><p id="build"></p>',
  });
  about.render(document.body);
  const fillQuestion = box('fill-question');
  for (const [kind, title] of [['real', 'Real Label'], ['logo', 'Logo Only']]) {
    const canvas = box('fill-canvas-' + kind, { autoEl: { tag: 'canvas', cls: 'choice-art' } });
    fillChoices[kind] = { canvas, panel: new H.Panel({
      title, width: 178, autoHeight: true, bodyStyle: 'padding:6px', items: canvas,
      buttons: [button('fill-' + kind, title)],
    }) };
  }
  const fill = new H.Window({
    id: 'fill', title: 'Fill unlabelled carts', width: 400, autoHeight: true,
    modal: true, closable: false, resizable: false, closeAction: 'hide', onEsc() {},
    bodyStyle: 'padding:10px', items: [fillQuestion, new H.Panel({
      border: false, autoHeight: true, layout: 'table', layoutConfig: { columns: 2 },
      items: Object.values(fillChoices).map(c => c.panel),
    })],
  });
  fill.render(document.body);
  fill.on('show', maskBackground);
  fill.on('hide', maskBackground);
  const bannerMessage = box('banner-message');
  const banner = new H.Panel({
    id: 'banner', hidden: true, title: 'Notice', autoHeight: true, bodyStyle: 'padding:10px',
    items: bannerMessage, buttons: [button('retry', 'Retry'), button('copy-log', 'Copy log')],
  });
  const store = new H.data.SimpleStore({ fields: ['key'], data: [] });
  const grid = new H.DataView({
    id: 'grid', el: Object.assign(document.createElement('div'), { id: 'grid' }),
    cls: 'cart-library', anchor: '100%', store, itemSelector: 'article.cart', autoHeight: true,
    tpl: new H.XTemplate('<tpl for="."><article class="cart" tabindex="0" role="button">' +
      '<div class="face"><canvas hidden></canvas></div><h2 class="stem"></h2>' +
      '<p class="print"></p><p class="game"></p></article></tpl>'),
    emptyText: '<p class="empty-library">Choose an SD card to edit cartridge labels and album covers.</p>',
  });
  const cardInput = file('pick-files');
  cardInput.on('render', () => { cardInput.el.dom.setAttribute('webkitdirectory', ''); });
  const status = box('progress-text', { columnWidth: 1, autoEl: { tag: 'span', html: 'Ready' } });
  const library = new H.Panel({
    id: 'studio-library', border: false, layout: 'anchor', autoScroll: true,
    bodyStyle: 'padding:12px', items: grid,
  });
  const emptyPage = new H.Panel({
    id: 'platform-library', title: 'Library', border: false, layout: 'fit', items: library,
  });
  const platformTabs = new H.TabPanel({
    id: 'tabs', region: 'center', border: false, activeTab: 0, deferredRender: false,
    layoutOnTabChange: true, enableTabScroll: true, animScroll: false, items: emptyPage,
  });
  const header = new H.Panel({
    id: 'studio-header', region: 'north', title: 'Cart Studio', autoHeight: true, border: false,
    items: [cardInput, banner],
    tbar: [button('pick', 'Choose SD Card', { disabled: true }), button('write', 'Write to card', {
      disabled: true, hidden: true,
    }), button('fill-open', 'Fill unlabelled carts…', { hidden: true }), '->', button('about', 'About', { handler: () => {
      about.setSize(Math.min(440, innerWidth - 20), Math.min(300, innerHeight - 20)); about.show(); about.center();
    } })],
  });
  const viewport = new H.Viewport({
    id: 'studio-viewport', layout: 'border', items: [
      header,
      platformTabs,
      new H.Panel({ id: 'studio-status', region: 'south', height: 35, border: false, layout: 'column',
        bodyStyle: 'padding:5px', items: status }),
    ],
  });
  document.body.dataset.framework = 'HorizonJS';
  H.EventManager.onWindowResize(() => {
    if (banner.isVisible()) {
      viewport.doLayout();
    }
  });
  const progressDialog = H.MessageBox.getDialog();
  progressDialog.el.addClass('studio-progress-dialog');
  progressDialog.el.dom.setAttribute('role', 'dialog');
  progressDialog.el.dom.setAttribute('aria-modal', 'true');
  progressDialog.el.dom.setAttribute('aria-labelledby', progressDialog.header.dom.id);
  progressDialog.onEsc = () => {};
  const progressBar = progressDialog.body.dom.querySelector('.x-progress-wrap');
  progressBar.id = 'scan-progress';
  progressBar.setAttribute('role', 'progressbar');
  progressBar.setAttribute('aria-label', 'Card progress');
  progressBar.setAttribute('aria-valuemin', '0');
  progressBar.setAttribute('aria-valuemax', '1');
  progressDialog.on('show', () => { progressDialogActive = true; maskBackground(); });
  progressDialog.on('hide', () => {
    progressDialogActive = false;
    maskBackground();
    const editor = [cartEditor, musicEditor].find(w => w.isVisible());
    if (editor) editor.focus();
  });
  H.EventManager.onWindowResize(() => {
    if (progressDialogActive) {
      progressOptions.width = Math.min(420, innerWidth - 20);
      H.MessageBox.updateText(progressOptions.msg);
      progressDialog.center();
    }
  });
  const platformPages = new Map();
  let syncingTabs = false, choosePlatform = null;
  function moveLibrary(page) {
    if (library.ownerCt !== page) {
      library.ownerCt.remove(library, false);
      page.add(library);
    }
    page.doLayout();
  }
  function updateTabAria() {
    for (const page of [emptyPage, ...platformPages.values()]) {
      const anchor = platformTabs.getTabEl(page).querySelector('a.x-tab-right');
      const selected = platformTabs.getActiveTab() === page;
      anchor.id = page.id + '-tab';
      anchor.setAttribute('role', 'tab');
      anchor.setAttribute('aria-label', page.platformName ?? 'Library');
      anchor.setAttribute('aria-controls', page.id);
      anchor.setAttribute('aria-selected', String(selected));
      anchor.tabIndex = selected ? 0 : -1;
      if (page.rendered) {
        page.el.dom.setAttribute('role', 'tabpanel');
        page.el.dom.setAttribute('aria-labelledby', anchor.id);
      }
    }
  }
  function bindTabKeys(page) {
    const anchor = platformTabs.getTabEl(page).querySelector('a.x-tab-right');
    anchor.addEventListener('keydown', event => {
      const pages = platformPages.size ? [...platformPages.values()] : [emptyPage];
      const index = pages.indexOf(page);
      let next;
      if (event.key === 'ArrowRight') next = pages[(index + 1) % pages.length];
      else if (event.key === 'ArrowLeft') next = pages[(index + pages.length - 1) % pages.length];
      else if (event.key === 'Home') next = pages[0];
      else if (event.key === 'End') next = pages.at(-1);
      else if (event.key === 'Enter' || event.key === ' ') next = page;
      else return;
      event.preventDefault();
      platformTabs.setActiveTab(next);
      platformTabs.getTabEl(next).querySelector('a.x-tab-right').focus();
    });
  }
  platformTabs.strip.dom.setAttribute('role', 'tablist');
  platformTabs.strip.dom.setAttribute('aria-label', 'Platforms');
  bindTabKeys(emptyPage);
  updateTabAria();
  platformTabs.on('tabchange', (_, page) => {
    if (syncingTabs) return;
    moveLibrary(page);
    updateTabAria();
    if (page.platformId) choosePlatform?.(page.platformId);
  });
  const resultPanels = [];
  return {
    buttons, fields, choices, fillChoices, background, shell, cartEditor, musicEditor, fill, encode, layoutCartChoices,
    setFieldVisible(id, visible) {
      fields[id].setVisible(visible);
      const row = fields[id].el.dom.closest('.x-form-item');
      if (row) { row.hidden = !visible; if (id === 'ed-outline') row.id = 'ed-outline-row'; }
    },
    setCards(items, render) {
      store.loadData(items.map((_, i) => [i]));
      // Horizon returns its empty-text node when the store has no records.
      grid.getNodes().slice(0, items.length).forEach((node, i) => render(items[i], node));
    },
    setLoading(value) {
      status.el.dom.textContent = value || 'Ready';
      status.el.dom.title = value || 'Ready';
      if (progressDialogActive) {
        progressOptions.msg = encode(value || 'Loading…');
        H.MessageBox.updateText(progressOptions.msg);
      }
    },
    showProgress(title, message) {
      progressOptions = { title, msg: encode(message), progress: true, closable: false,
        modal: true, width: Math.min(420, innerWidth - 20), progressText: 'Please wait…' };
      H.MessageBox.show(progressOptions);
      progressDialog.keyMap.disable();
      progressDialog.center();
    },
    hideProgress() {
      H.MessageBox.hide();
    },
    setProgress(done, total) {
      const value = total ? Math.max(0, Math.min(1, done / total)) : 0;
      H.MessageBox.updateProgress(value, Math.round(value * 100) + '%');
      progressBar.setAttribute('aria-valuenow', String(value));
    },
    showBanner(message, retry, copy) {
      bannerMessage.el.dom.textContent = message;
      buttons.retry.setVisible(!!retry);
      buttons.retry.setHandler(retry || (() => {}));
      buttons['copy-log'].setVisible(!!copy);
      buttons['copy-log'].setText('Copy log');
      buttons['copy-log'].setHandler(copy || (() => {}));
      banner.setVisible(!!message);
      viewport.doLayout();
    },
    setPlatforms(platforms, selected, choose) {
      choosePlatform = choose;
      syncingTabs = true;
      platformTabs.beginUpdate();
      try {
        if ([...platformPages.keys()].join('|') !== platforms.map(p => p.id).join('|')) {
          // Keep the shared view alive while replacing platform pages for a new card.
          platformTabs.unhideTabStripItem(emptyPage);
          platformTabs.setActiveTab(emptyPage);
          moveLibrary(emptyPage);
          for (const page of platformPages.values()) platformTabs.remove(page, true);
          platformPages.clear();
          for (const p of platforms) {
            const page = new H.Panel({
              id: 'platform-' + p.id, platformId: p.id, platformName: p.name,
              title: encode(p.id), border: false, layout: 'fit',
            });
            platformTabs.add(page);
            platformPages.set(p.id, page);
            bindTabKeys(page);
          }
        }
        for (const p of platforms) platformPages.get(p.id).setTitle(encode(p.id) + ' ' + p.count);
        const page = platformPages.get(selected) ?? emptyPage;
        platformTabs.setActiveTab(page);
        moveLibrary(page);
        if (platforms.length) platformTabs.hideTabStripItem(emptyPage);
        else platformTabs.unhideTabStripItem(emptyPage);
        updateTabAria();
      } finally {
        platformTabs.endUpdate();
        syncingTabs = false;
      }
      viewport.doLayout();
    },
    clearMusicResults() { for (const panel of resultPanels) musicHits.remove(panel, true); resultPanels.length = 0; },
    addMusicResult(candidate, select) {
      const image = box(H.id(), { autoEl: { tag: 'img', cls: 'music-thumbnail', alt: encode(candidate.title) } });
      const status = box(H.id(), { autoEl: { tag: 'p', html: 'Loading preview…' } });
      const choose = new H.Button({ text: 'Use this cover', disabled: true, handleMouseEvents: false, handler: select });
      choose.on('render', () => { const b = choose.el.dom.querySelector('button'); b.className += ' music-hit'; b.disabled = true; });
      for (const event of ['enable', 'disable']) choose.on(event, () => { choose.el.dom.querySelector('button').disabled = choose.disabled; });
      const panel = new H.Panel({ title: encode(candidate.title), autoHeight: true, bodyStyle: 'padding:8px',
        items: [image, box(H.id(), { autoEl: { tag: 'p', html: encode([candidate.artist, candidate.year, candidate.type].filter(Boolean).join(' · ')) } }), status],
        buttons: [choose] });
      musicHits.add(panel); musicHits.doLayout(); resultPanels.push(panel);
      return { image: image.el.dom, status: status.el.dom, button: choose };
    },
  };
}
