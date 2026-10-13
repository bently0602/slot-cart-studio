import { canRedo, canRevert, canUndo, commit, redo, revert, undo, visit, visited } from './history.js';

export function createEditor(api) {
  const ui = api.ui, H = window.Ext, b = ui.buttons, f = ui.fields;
  const panel = ui.cartEditor;
  let cart = null, built = false, picking = null;
  const menus = [];
  function closeMenus() {
    for (const menu of menus) menu.hide();
    for (const field of Object.values(f)) if (field instanceof H.form.ComboBox) field.collapse();
  }
  function change(fn, c = cart) { if (c && commit(c, () => fn(c))) api.changed(c); }
  function step(fn) { if (cart && fn(cart)) api.changed(cart); }
  function build() {
    if (built) return;
    built = true;
    const data = api.presets().map(p => [p.value, p.name]);
    for (const id of ['ed-bg-presets', 'ed-shell-presets']) f[id].store.loadData(data);
    for (const kind of ['bg', 'shell']) {
      const menu = new H.menu.ColorMenu();
      menus.push(menu);
      menu.on('select', (_, colour) => {
        menu.hide();
        if (kind === 'bg') change(c => api.setBackground(c, api.fromHex('#' + colour)));
        else change(c => api.setShell(c, { ...api.shellOf(c), colour }));
      });
      b['ed-' + kind + '-palette'].on('click', () => menu.show(b['ed-' + kind + '-palette'].el));
    }
  }
  function refresh() {
    const c = cart;
    if (!c) return;
    if (!visited(c)) visit(c);
    panel.setTitle(ui.encode(api.name(c)));
    const canvas = document.getElementById('ed-face'), face = api.face(c);
    canvas.hidden = !face;
    if (face) api.draw(canvas, face, c.platform);
    f['ed-game'].setDisabled(!api.canLabel(c));
    f['ed-game'].setValue(api.matched(c) ? c.game : '');
    const wearing = api.wearing(c);
    for (const [kind, choice] of Object.entries(ui.choices)) {
      const ok = api.available(c, kind), retry = kind === 'real' && api.realFailed(c);
      choice.panel.setVisible(kind !== 'card' || ok);
      choice.button.setDisabled(!api.canLabel(c) || (!ok && !retry && !kind.startsWith('custom')));
      choice.panel.el.dom.classList.toggle('choice-selected', wearing.kind === kind);
      choice.button.el.dom.querySelector('button').setAttribute('aria-pressed', String(wearing.kind === kind));
      const hasFile = kind === 'customLogo' ? !!c.customLogoBytes : kind === 'customLabel' ? !!c.customLabelBytes : true;
      choice.note.el.dom.textContent = retry ? 'Couldn’t load. Click to retry.' :
        kind.startsWith('custom') ? (hasFile ? 'Click again to replace the file.' : 'Import a PNG image.') :
        !ok ? 'None for this game' : api.fill() === kind ? 'Default' : '';
      const face = ok && hasFile ? api.tileFace(c, kind) : null, canvas = choice.canvas.el.dom;
      canvas.hidden = !face;
      if (face) { [canvas.width, canvas.height] = api.box(c.platform); api.draw(canvas, face, c.platform); }
    }
    const bg = api.background(c), shell = api.shellOf(c), shells = api.canShell(c);
    ui.background.setVisible(api.canBackground(c));
    f['ed-bg-custom'].setValue(api.hex(bg.rgb));
    const bgPreset = api.presets().find(p => '#' + p.value.split(' ')[1] === api.hex(bg.rgb));
    f['ed-bg-presets'].setValue(bg.auto ? '' : bgPreset?.value ?? '');
    ui.shell.setVisible(api.hasShell(c));
    f['ed-shell-custom'].setValue('#' + shell.colour);
    const shellPreset = api.presets().find(p => {
      const [, colour, finish] = p.value.split(' ');
      return colour === shell.colour && (c.platform === 'SNES' || finish === shell.finish);
    });
    f['ed-shell-presets'].setValue(shell.auto ? '' : shellPreset?.value ?? '');
    f['ed-shell-presets'].setDisabled(!shells);
    f['ed-shell-custom'].setDisabled(!shells);
    b['ed-shell-auto'].setDisabled(!shells); b['ed-shell-palette'].setDisabled(!shells);
    f['ed-finish'].setValue(shell.finish); f['ed-finish'].setDisabled(!shells || shell.auto);
    f['ed-outline'].setValue(shell.outline); f['ed-outline'].setDisabled(!shells);
    ui.setFieldVisible('ed-finish', api.hasShell(c) && c.platform !== 'SNES');
    ui.setFieldVisible('ed-outline', api.hasShell(c) && !['GBA', 'SNES'].includes(c.platform));
    b['ed-undo'].setDisabled(!canUndo(c)); b['ed-redo'].setDisabled(!canRedo(c)); b['ed-revert'].setDisabled(!canRevert(c));
    // Framework controls can lose focus when a history step disables them.
    if (panel.el.dom.contains(document.activeElement) && document.activeElement.disabled) panel.focus();
    panel.doLayout();
    ui.layoutCartChoices();
  }
  function open(c) {
    build();
    if (c === cart) return;
    closeMenus();
    cart?.el.root.classList.remove('current');
    cart = c; api.ensureTiles(c); visit(c); c.el.root.classList.add('current');
    const canvas = document.getElementById('ed-face');
    [canvas.width, canvas.height] = api.box(c.platform);
    panel.show(); refresh(); panel.focus();
  }
  function close() {
    closeMenus(); cart?.el.root.classList.remove('current'); cart = null; panel.hide();
  }
  panel.on('hide', () => { closeMenus(); cart?.el.root.classList.remove('current'); cart = null; });
  b['ed-close'].on('click', close);
  f['ed-game'].on('beforequery', query => {
    if (!cart) { query.cancel = true; return; }
    f['ed-game'].store.loadData([
      ...(api.matched(cart) ? [['__none__', 'No match']] : []),
      ...(api.search(cart, query.query) ?? []).map(name => [name, name]),
    ]);
    // The database already searches anywhere in the name; keep its results intact.
    query.forceAll = true;
  });
  // The legacy combo listens for keyup; input also covers paste and other modern input methods.
  f['ed-game'].el.dom.addEventListener('input', () => f['ed-game'].doQuery(f['ed-game'].getRawValue()));
  f['ed-game'].on('select', (_, record) => {
    const name = record.get('value');
    change(c => name === '__none__' ? api.noMatch(c) : api.chooseGame(c, name));
  });
  for (const [kind, choice] of Object.entries(ui.choices)) choice.button.on('click', () => {
    const c = cart, bytes = kind === 'customLogo' ? c.customLogoBytes : c.customLabelBytes;
    if (kind.startsWith('custom') && (!bytes || c.choice === kind)) {
      picking = kind; f['ed-file'].el.dom.click(); return;
    }
    if (kind === 'real') api.retryReal(c);
    change(c => kind === 'customLogo' ? api.useCustomLogo(c, bytes) :
      kind === 'customLabel' ? api.useCustomLabel(c, bytes) : api.choose(c, kind));
  });
  f['ed-file'].el.dom.addEventListener('change', async e => {
    const c = cart, kind = picking, file = e.target.files[0]; e.target.value = '';
    const bytes = await api.readLogo(file);
    if (bytes && kind) change(c => kind === 'customLogo' ? api.useCustomLogo(c, bytes) : api.useCustomLabel(c, bytes), c);
  });
  f['ed-bg-presets'].on('select', (_, r) => change(c => api.setBackground(c, api.fromHex('#' + r.get('value').split(' ')[1]))));
  f['ed-shell-presets'].on('select', (_, r) => {
    const [, colour, finish] = r.get('value').split(' ');
    change(c => api.setShell(c, { ...api.shellOf(c), colour, finish }));
  });
  b['ed-bg-auto'].on('click', () => change(c => api.setBackground(c, null)));
  b['ed-shell-auto'].on('click', () => change(c => api.setShell(c, null)));
  f['ed-bg-custom'].on('change', field => {
    if (field.isValid()) change(c => api.setBackground(c, api.fromHex(field.getValue())));
  });
  f['ed-shell-custom'].on('change', field => {
    if (field.isValid()) change(c => api.setShell(c, { ...api.shellOf(c), colour: field.getValue().slice(1) }));
  });
  for (const key of ['finish', 'outline']) f['ed-' + key].on('select', (_, r) =>
    change(c => api.setShell(c, { ...api.shellOf(c), [key]: r.get('value') })));
  b['ed-undo'].on('click', () => step(undo)); b['ed-redo'].on('click', () => step(redo)); b['ed-revert'].on('click', () => step(revert));
  panel.el.dom.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.key.toLowerCase() === 'z') step(e.shiftKey ? redo : undo);
    else if (e.key.toLowerCase() === 'y') step(redo);
    else return;
    e.preventDefault();
  });
  return { open, close, refresh, current: () => cart };
}
