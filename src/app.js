// Hue Deck: rooms, zones, scenes and lights of a Hue Bridge, plus desktop shortcuts for any of them.
import { loadHome, refreshState, lightHex, sceneColors, hexToXy, mirekToHex } from './hue.js';
import { makeIcon, iconPng } from './icon.js';

const VERSION = '1.0.0';
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k){ try { return localStorage.getItem('huedeck.' + k); } catch (_){ return null; } },
  set(k, v){ try { localStorage.setItem('huedeck.' + k, v); } catch (_){} },
};
const T = window.__TAURI__;
// in a plain browser there's no bridge: tests hand in a pretend one
const invoke = T ? T.core.invoke : window.__hueFake;
const isWin = /Windows/.test(navigator.userAgent);

const api = {
  async get(kind){ return JSON.parse(await invoke('hue', { method: 'GET', path: '/clip/v2/resource/' + kind })).data; },
  put(kind, id, body){ return invoke('hue', { method: 'PUT', path: `/clip/v2/resource/${kind}/${id}`, body: JSON.stringify(body) }); },
};

/* ---------------- Little helpers: toast, dialog, menu ---------------- */
let toastTimer;
function toast(msg, ms = 2600){
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
let dlgDone = null;
// buttons: [{ label, value, primary }] → the clicked value (null for Esc / outside)
function dialog(title, html, buttons = [{ label: 'Close', value: null, primary: true }]){
  if (dlgDone) dlgDone(null);
  $('#dlgTitle').textContent = title; $('#dlgBody').innerHTML = html;
  const box = $('#dlgBtns'); box.innerHTML = '';
  return new Promise(res => {
    dlgDone = v => { dlgDone = null; $('#dlg').hidden = true; res(v); };
    for (const b of buttons){
      const el = document.createElement('button');
      el.className = 'btn' + (b.primary ? ' primary' : ''); el.textContent = b.label;
      el.onclick = () => dlgDone(b.value);
      box.append(el);
    }
    $('#dlg').hidden = false;
  });
}
$('#dlg').addEventListener('click', e => { if (e.target.id === 'dlg' && dlgDone) dlgDone(null); });

let menuEl = null;
function closeMenu(){ menuEl?.remove(); menuEl = null; }
// items: [label, fn] or '-' or { ver: text }
function showMenu(x, y, items){
  closeMenu();
  menuEl = document.createElement('div'); menuEl.className = 'menu';
  for (const it of items){
    if (it === '-'){ menuEl.append(Object.assign(document.createElement('div'), { className: 'sep' })); continue; }
    if (it.ver){ menuEl.append(Object.assign(document.createElement('div'), { className: 'ver', textContent: it.ver })); continue; }
    const b = document.createElement('button'); b.textContent = it[0];
    b.onclick = () => { closeMenu(); it[1](); };
    menuEl.append(b);
  }
  document.body.append(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
  menuEl.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';
}
document.addEventListener('pointerdown', e => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (menuEl) closeMenu(); else if (dlgDone) dlgDone(null);
});
window.addEventListener('blur', closeMenu);

/* ---------------- The home on screen ---------------- */
let home = null;
const shown = new Set(JSON.parse(store.get('lightsShown') || '[]'));   // cards with their lights listed
const avg = hexes => {
  if (!hexes.length) return null;
  const s = [0, 0, 0];
  for (const h of hexes){ const n = parseInt(h.slice(1), 16); s[0] += n >> 16; s[1] += n >> 8 & 255; s[2] += n & 255; }
  return '#' + s.map(v => Math.round(v / hexes.length).toString(16).padStart(2, '0')).join('');
};
const lightsOf = g => g.lights.map(id => home.lights.get(id)).filter(Boolean);
const groupColors = g => [...new Set(lightsOf(g).map(lightHex).filter(Boolean))];
const sceneGrad = cols => cols.length > 1 ? `linear-gradient(110deg,${cols.join(',')})` : cols[0];
const briOf = r => Math.round(r?.dimming?.brightness ?? 0);

function cardHtml(g){
  const gl = home.gls.get(g.gl), on = !!gl?.on?.on, ls = lightsOf(g);
  const nOn = ls.filter(l => l.on?.on).length, cols = groupColors(g), b = on ? briOf(gl) : 0;
  const glow = cols.length ? `linear-gradient(90deg,${cols.length > 1 ? cols.join(',') : cols[0] + ',' + cols[0]})` : 'transparent';
  const scenes = g.scenes.map(id => home.scenes.get(id)).filter(Boolean);
  const open = shown.has(g.id);
  return `<section class="card${on ? '' : ' off'}" data-group="${g.id}" style="--glow:${glow}">
    <div class="top">
      <div class="name" data-menu="group">${esc(g.name)}<span class="sub">${ls.length ? `${nOn} of ${ls.length} light${ls.length > 1 ? 's' : ''} on` : 'no lights'}</span></div>
      <input type="checkbox" class="sw" data-gl="${g.gl}" ${on ? 'checked' : ''} aria-label="${esc(g.name)} on or off">
      <button class="dots" data-menu="group" aria-label="More for ${esc(g.name)}">⋯</button>
    </div>
    <input type="range" class="bri" min="1" max="100" value="${b || 1}" data-gl="${g.gl}" ${on ? '' : 'disabled'} style="--p:${b}%;--fill:${avg(cols) || 'var(--accent)'}" aria-label="${esc(g.name)} brightness">
    ${scenes.length ? `<div class="scenes">${scenes.map(s => `<button class="scene${s.status?.active && s.status.active !== 'inactive' ? ' on' : ''}" data-scene="${s.id}" style="--g:${sceneGrad(sceneColors(s))}" title="${esc(s.metadata.name)} (right-click for a shortcut)">${esc(s.metadata.name)}</button>`).join('')}</div>` : ''}
    ${ls.length ? `<button class="more" data-more>${open ? '▾ Hide lights' : `▸ Lights (${ls.length})`}</button>` : ''}
    ${open ? `<div class="lights">${ls.map(lightRow).join('')}</div>` : ''}
  </section>`;
}
function lightRow(l){
  const on = !!l.on?.on, c = lightHex(l), b = on ? briOf(l) : 0, colorable = !!(l.color || l.color_temperature);
  return `<div class="light" data-light="${l.id}">
    <button class="cdot${colorable ? '' : ' none'}" data-color style="--c:${c || 'var(--track)'}" title="${colorable ? 'Color' : ''}" aria-label="${esc(l.metadata.name)} color"></button>
    <span class="ln" data-menu="light">${esc(l.metadata.name)}</span>
    ${l.dimming ? `<input type="range" class="bri small" min="1" max="100" value="${b || 1}" data-light="${l.id}" ${on ? '' : 'disabled'} style="--p:${b}%;--fill:${c || 'var(--accent)'}" aria-label="${esc(l.metadata.name)} brightness">` : '<span></span>'}
    <input type="checkbox" class="sw" data-light="${l.id}" ${on ? 'checked' : ''} aria-label="${esc(l.metadata.name)} on or off">
    <button class="dots" data-menu="light" aria-label="More for ${esc(l.metadata.name)}">⋯</button>
  </div>`;
}
function render(){
  if (!home) return;
  const main = $('#main'), y = main.scrollTop;
  const rooms = home.groups.filter(g => g.kind === 'room'), zones = home.groups.filter(g => g.kind === 'zone');
  main.innerHTML = !home.groups.length ? '<div class="empty">This bridge has no rooms yet. Make some in the Hue app on your phone, then come back.</div>'
    : (rooms.length ? `<h2>Rooms</h2><div class="grid">${rooms.map(cardHtml).join('')}</div>` : '') +
      (zones.length ? `<h2>Zones</h2><div class="grid">${zones.map(cardHtml).join('')}</div>` : '');
  main.scrollTop = y;
  const hg = home.home && home.gls.get(home.home);
  $('#homeBox').hidden = !hg;
  if (hg) $('#homeSw').checked = !!hg.on?.on;
}

/* ---------------- Changing things (shown at once, then sent; the next refresh shows the truth) ---------------- */
let busyUntil = 0;   // no refresh while a slider is being dragged or right after a change
const hold = ms => { busyUntil = Math.max(busyUntil, Date.now() + ms); };
async function send(kind, id, body){
  hold(1500);
  try { await api.put(kind, id, body); }
  catch (e){ toast(String(e.message || e)); }
  setTimeout(refresh, 900);
}
function setOn(kind, id, on){
  const r = (kind === 'light' ? home.lights : home.gls).get(id);
  if (r) r.on = { on };
  if (kind === 'grouped_light'){   // the room's lights follow
    const g = home.groups.find(g => g.gl === id) || (id === home.home ? { lights: [...home.lights.keys()] } : null);
    for (const l of g ? g.lights : []) { const x = home.lights.get(l); if (x) x.on = { on }; }
  }
  render();
  send(kind, id, { on: { on } });
}
// sliders send while dragging, a few times a second
const lastSent = new Map();
function setBri(kind, id, v, final){
  const r = (kind === 'light' ? home.lights : home.gls).get(id);
  if (r) r.dimming = { ...r.dimming, brightness: v };
  hold(1500);
  const now = Date.now();
  if (!final && now - (lastSent.get(id) || 0) < 180) return;
  lastSent.set(id, now);
  api.put(kind, id, { on: { on: true }, dimming: { brightness: v } }).catch(e => toast(String(e.message || e)));
  if (final) setTimeout(refresh, 900);
}
async function recall(id){
  for (const s of home.scenes.values()) if (s.group?.rid === home.scenes.get(id)?.group?.rid) s.status = { ...s.status, active: s.id === id ? 'static' : 'inactive' };
  render();
  await send('scene', id, { recall: { action: 'active' } });
}

const main = $('#main');
main.addEventListener('change', e => {
  const t = e.target;
  if (t.classList.contains('sw')) t.dataset.gl ? setOn('grouped_light', t.dataset.gl, t.checked) : setOn('light', t.dataset.light, t.checked);
  else if (t.classList.contains('bri')) t.dataset.gl ? setBri('grouped_light', t.dataset.gl, +t.value, true) : setBri('light', t.dataset.light, +t.value, true);
});
main.addEventListener('input', e => {
  const t = e.target;
  if (!t.classList.contains('bri')) return;
  t.style.setProperty('--p', t.value + '%');
  t.dataset.gl ? setBri('grouped_light', t.dataset.gl, +t.value) : setBri('light', t.dataset.light, +t.value);
});
main.addEventListener('pointerdown', () => hold(4000));
main.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  const card = t.closest('[data-group]'), g = card && home.groups.find(g => g.id === card.dataset.group);
  if (t.dataset.scene) recall(t.dataset.scene);
  else if (t.hasAttribute('data-more')){ shown.has(g.id) ? shown.delete(g.id) : shown.add(g.id); store.set('lightsShown', JSON.stringify([...shown])); render(); }
  else if (t.hasAttribute('data-color') && !t.classList.contains('none')) colorDialog({ kind: 'light', id: t.closest('[data-light]').dataset.light });
  else if (t.dataset.menu){ const r = t.getBoundingClientRect(); itemMenu(t, r.right - 210, r.bottom + 4); }
});
main.addEventListener('contextmenu', e => {
  const t = e.target.closest('[data-menu],[data-scene],[data-light] .ln,.card');
  if (!t) return;
  e.preventDefault();
  itemMenu(t.matches('.card') ? t.querySelector('.name') : t, e.clientX, e.clientY);
});
$('#homeSw').addEventListener('change', e => setOn('grouped_light', home.home, e.target.checked));
$('#homeDots').addEventListener('click', e => { const r = e.currentTarget.getBoundingClientRect(); itemMenu(e.currentTarget, r.right - 210, r.bottom + 4); });
$('#homeBox').addEventListener('contextmenu', e => { e.preventDefault(); itemMenu($('#homeDots'), e.clientX, e.clientY); });

// what was clicked → { kind, id, name, colors, gl }
function targetOf(el){
  if (el.closest('#homeBox')) return { kind: 'home', id: home.home, gl: home.home, name: 'All lights', colors: [...new Set([...home.lights.values()].map(lightHex).filter(Boolean))].slice(0, 5) };
  const card = el.closest('[data-group]'), g = card && home.groups.find(g => g.id === card.dataset.group);
  if (el.dataset.scene){
    const s = home.scenes.get(el.dataset.scene);
    return { kind: 'scene', id: s.id, gl: g.gl, name: s.metadata.name, room: g.name, colors: sceneColors(s) };
  }
  const row = el.closest('[data-light]');
  if (row){ const l = home.lights.get(row.dataset.light); return { kind: 'light', id: l.id, name: l.metadata.name, colors: [lightHex(l) || '#ffe2a8'], light: l }; }
  return { kind: 'room', id: g.gl, gl: g.gl, name: g.name, colors: groupColors(g).slice(0, 5), group: g };
}
function itemMenu(el, x, y){
  const t = targetOf(el);
  const items = [['Make a shortcut…', () => shortcutDialog(t)]];
  if (t.kind === 'scene') items.unshift(['Turn on this scene', () => recall(t.id)]);
  if (t.kind === 'room' || t.kind === 'home') items.unshift(['Turn on', () => setOn('grouped_light', t.id, true)], ['Turn off', () => setOn('grouped_light', t.id, false)], '-');
  if (t.kind === 'room') items.push(['Color for the whole room…', () => colorDialog({ kind: 'grouped_light', id: t.id, name: t.name })]);
  if (t.kind === 'light'){
    items.unshift([t.light.on?.on ? 'Turn off' : 'Turn on', () => setOn('light', t.id, !t.light.on?.on)], '-');
    if (t.light.color || t.light.color_temperature) items.push(['Color…', () => colorDialog({ kind: 'light', id: t.id })]);
  }
  showMenu(x, y, items);
}

/* ---------------- Color ---------------- */
async function colorDialog({ kind, id, name }){
  const r = kind === 'light' ? home.lights.get(id) : null;
  const canColor = kind !== 'light' || !!r.color, ct = r?.color_temperature?.mirek_schema || { mirek_minimum: 153, mirek_maximum: 500 };
  const canWhite = kind !== 'light' || !!r.color_temperature;
  const now = (r && lightHex(r)) || '#ffd9a0';
  dialog(`Color: ${name || r.metadata.name}`, `<div class="colorbox">
    ${canColor ? `<div class="sub">Any color</div><input type="color" id="cPick" value="${now}">` : ''}
    ${canWhite ? `<div class="sub">White (cool … warm)</div><input type="range" class="ct" id="cCt" min="${ct.mirek_minimum}" max="${ct.mirek_maximum}" value="${r?.color_temperature?.mirek || 366}">` : ''}
  </div>`);
  let last = 0;
  const go = (body, final) => {
    const t = Date.now();
    if (!final && t - last < 150) return;
    last = t; hold(1500);
    api.put(kind, id, { on: { on: true }, ...body }).catch(e => toast(String(e.message || e)));
  };
  $('#cPick')?.addEventListener('input', e => go({ color: { xy: hexToXy(e.target.value) } }));
  $('#cPick')?.addEventListener('change', e => { go({ color: { xy: hexToXy(e.target.value) } }, true); setTimeout(refresh, 700); });
  $('#cCt')?.addEventListener('input', e => go({ color_temperature: { mirek: +e.target.value } }));
  $('#cCt')?.addEventListener('change', e => { go({ color_temperature: { mirek: +e.target.value } }, true); setTimeout(refresh, 700); });
}

/* ---------------- Shortcuts ---------------- */
const MODES = {
  room: [['toggle', 'Switch on and off', 'Each click flips it'], ['on', 'Always turn on', ''], ['off', 'Always turn off', '']],
  scene: [['on', 'Turn the scene on', ''], ['toggle', 'Scene on, click again for off', 'The second click switches the whole room off']],
};
MODES.home = MODES.light = MODES.room;
async function shortcutDialog(t){
  const modes = MODES[t.kind];
  let mode = modes[0][0];
  const base = t.kind === 'scene' ? `${t.room} - ${t.name}` : t.name;
  const nameFor = m => t.kind === 'scene' || m === 'toggle' ? base : `${base} ${m}`;
  let typed = false;
  const startMenu = isWin ? 'Start menu' : 'Applications menu';
  const p = dialog('Make a shortcut', `
    <div class="shot"><canvas id="shotIcon" width="256" height="256"></canvas><input class="field" id="shotName" value="${esc(nameFor(mode))}" aria-label="Shortcut name"></div>
    <div class="sub">When it's clicked</div>
    <div class="opts">${modes.map(([v, l, s]) => `<button class="opt${v === mode ? ' on' : ''}" data-mode="${v}"><span>${l}${s ? `<small>${s}</small>` : ''}</span></button>`).join('')}</div>
    <div class="hint">It works straight away, without opening Hue Deck.${isWin ? ' To put it on the taskbar: right-click the shortcut, Show more options, Pin to taskbar.' : ''}</div>`,
    [{ label: 'Cancel', value: null }, { label: 'Choose a folder…', value: 'folder' }, { label: startMenu, value: 'start' }, { label: 'Desktop', value: 'desktop', primary: true }]);
  const draw = () => {
    const c = makeIcon(t.kind, t.colors, mode), out = $('#shotIcon');
    out.getContext('2d').clearRect(0, 0, 256, 256); out.getContext('2d').drawImage(c, 0, 0);
  };
  draw();
  $('#shotName').addEventListener('input', () => { typed = true; });
  $('#dlgBody').querySelector('.opts').addEventListener('click', e => {
    const b = e.target.closest('.opt'); if (!b) return;
    mode = b.dataset.mode;
    $('#dlgBody').querySelectorAll('.opt').forEach(x => x.classList.toggle('on', x === b));
    if (!typed) $('#shotName').value = nameFor(mode);
    draw();
  });
  const place = await p;
  if (!place) return;
  const name = ($('#shotName').value || base).trim();
  let folder = null;
  if (place === 'folder'){
    folder = await T?.dialog.open({ directory: true, title: 'Where should the shortcut go?' });
    if (!folder) return;
  }
  const args = t.kind === 'scene' ? (mode === 'toggle' ? ['--scene', t.id, '--off-group', t.gl] : ['--scene', t.id])
    : [t.kind === 'light' ? '--light' : '--room', t.id, mode];
  try {
    const path = await invoke('make_shortcut', { name, args, iconPng: iconPng(makeIcon(t.kind, t.colors, mode)), place, folder });
    toast(place === 'desktop' ? `“${name}” is on your Desktop` : place === 'start' ? `“${name}” is in the ${startMenu} (Hue Deck folder)` : `Made ${path}`, 4000);
  } catch (e){ toast("Couldn't make the shortcut: " + (e.message || e), 5000); }
}

/* ---------------- Theme (like Markpad): tap the moon for light/dark, hold it for the colors ---------------- */
const PALETTES = [['Plain', '', '#8a8d93'], ['Red', 'red', '#a4463f'], ['Blue', 'blue', '#3d6a9e'], ['Green', 'green', '#4a7a51'], ['Yellow', 'yellow', '#93700f']];
function applyTheme(){
  const t = store.get('theme') || '', p = store.get('palette') || '', d = document.documentElement;
  t ? d.dataset.theme = t : delete d.dataset.theme;
  p ? d.dataset.palette = p : delete d.dataset.palette;
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
function themeDialog(){
  const pal = store.get('palette') || '', mode = store.get('theme') || '';
  const sw = (k, v, n, c, on) => `<button class="${on ? 'on' : ''}" data-${k}="${v}" style="--c:${c}"><span></span>${n}</button>`;
  dialog('Theme', `<div class="sub">Color</div><div class="swatches">${PALETTES.map(([n, v, c]) => sw('palette', v, n, c, v === pal)).join('')}</div>
    <div class="sub">Light or dark</div><div class="swatches">${[['Light', 'light', '#f3f2ef'], ['Dark', 'dark', '#25262a'], ['Like the system', '', 'linear-gradient(90deg,#f3f2ef 50%,#25262a 50%)']].map(([n, v, c]) => sw('mode', v, n, c, v === mode)).join('')}</div>`);
  $('#dlgBody').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.palette != null) store.set('palette', b.dataset.palette); else store.set('theme', b.dataset.mode);
    applyTheme();
    b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  };
}
{ let timer = 0, held = false;
  const bt = $('#bTheme');
  bt.addEventListener('pointerdown', () => { held = false; timer = setTimeout(() => { held = true; themeDialog(); }, 500); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) bt.addEventListener(ev, () => clearTimeout(timer));
  bt.addEventListener('contextmenu', e => { e.preventDefault(); if (!held) themeDialog(); held = true; });
  bt.addEventListener('click', () => {
    if (held){ held = false; return; }
    const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
    store.set('theme', dark ? 'light' : 'dark'); applyTheme();
  });
}
$('#bMenu').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(r.right - 220, r.bottom + 4, [
    ['Refresh', () => start()],
    ['Theme…', themeDialog],
    ['Bridge…', bridgeDialog],
    '-', { ver: `Hue Deck ${VERSION}` },
  ]);
});

/* ---------------- Bridge: connect once (the address and key stay on this computer) ---------------- */
async function bridgeDialog(){
  const s = await invoke('get_setup');
  const go = await dialog('Bridge', s.paired ? `<p>Connected to the bridge at <b>${esc(s.ip)}</b>.</p><p>The key the bridge gave Hue Deck stays on this computer.</p>` : '<p>Not connected yet.</p>',
    [{ label: 'Close', value: null }, { label: 'Connect a different bridge…', value: 'setup', primary: !s.paired }]);
  if (go) setupScreen();
}
function setupScreen(){
  home = null; $('#homeBox').hidden = true;
  $('#main').innerHTML = `<div class="setup">
    <h1>Connect to your Hue Bridge</h1>
    <p>Hue Deck talks to the bridge on your home network. Find it, then press the round button on top of the bridge when asked.</p>
    <div class="row"><input class="field" id="ip" placeholder="Bridge address, like 192.168.1.20" spellcheck="false"><button class="btn" id="find">Find it</button></div>
    <div class="found" id="found"></div>
    <p id="msg"></p>
    <div class="btns"><button class="btn primary" id="connect">Connect</button></div></div>`;
  $('#find').onclick = async () => {
    $('#msg').textContent = 'Looking…';
    try {
      const list = JSON.parse(await invoke('discover'));
      $('#found').innerHTML = list.map(b => `<button class="opt" data-ip="${esc(b.internalipaddress)}">Bridge at ${esc(b.internalipaddress)}</button>`).join('');
      $('#msg').textContent = list.length ? 'Pick your bridge, then Connect.' : 'No bridge found. Type its address (the Hue app shows it under Settings, Bridges).';
      if (list.length === 1) $('#ip').value = list[0].internalipaddress;
    } catch (e){ $('#msg').textContent = "Couldn't look it up: " + (e.message || e) + '. Type the address instead.'; }
  };
  $('#found').onclick = e => { const b = e.target.closest('[data-ip]'); if (b) $('#ip').value = b.dataset.ip; };
  $('#connect').onclick = async () => {
    const ip = $('#ip').value.trim();
    if (!ip){ $('#msg').textContent = 'Type the bridge address or press Find it.'; return; }
    $('#connect').disabled = true;
    for (let i = 30; i > 0; i--){
      $('#msg').textContent = `Now press the round button on top of the bridge (${i})…`;
      try { if (await invoke('pair', { ip })){ toast('Connected'); start(); return; } }
      catch (e){ $('#msg').textContent = String(e.message || e); $('#connect').disabled = false; return; }
      await new Promise(r => setTimeout(r, 2000));
    }
    $('#msg').textContent = "The button wasn't pressed in time. Try again.";
    $('#connect').disabled = false;
  };
}

/* ---------------- Start and keep up to date ---------------- */
async function refresh(){
  if (!home || document.hidden || Date.now() < busyUntil || dlgDone || menuEl) return;
  try { await refreshState(api, home); render(); } catch (_){ /* the next one will try again */ }
}
async function start(){
  if (!invoke){ $('#main').innerHTML = '<div class="empty">Hue Deck runs as the Windows or Linux app.</div>'; return; }
  const s = await invoke('get_setup');
  if (!s.paired) return setupScreen();
  try { home = await loadHome(api); render(); }
  catch (e){
    $('#main').innerHTML = `<div class="empty">Can't reach the bridge.<br><small>${esc(e.message || e)}</small><br><br><button class="btn primary" id="again">Try again</button> <button class="btn" id="other">Connect a different bridge…</button></div>`;
    $('#again').onclick = start; $('#other').onclick = setupScreen;
  }
}
setInterval(refresh, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
start();
window.__huedeck = { get home(){ return home; }, render, refresh, shortcutDialog, targetOf, makeIcon };
