// The bridge's lights, rooms, zones and scenes (Hue API v2), and the color math the screens need.
// `api` is the way to the bridge: the desktop app's `hue` command, or a pretend bridge in a browser.

/* ---------------- Colors ---------------- */
const gamma = v => v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
const ungamma = v => v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
const hex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');

// Hue's xy color (CIE 1931) → a screen color, at full brightness
export function xyToHex({ x, y }){
  if (!y) return '#ffffff';
  const Y = 1, X = Y / y * x, Z = Y / y * (1 - x - y);
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.011530;
  const m = Math.max(r, g, b, 1e-6);
  [r, g, b] = [r, g, b].map(v => Math.max(0, v / m));
  return hex(gamma(r), gamma(g), gamma(b));
}
// a screen color → Hue's xy
export function hexToXy(h){
  const n = parseInt(h.slice(1), 16), [r, g, b] = [n >> 16, n >> 8 & 255, n & 255].map(v => ungamma(v / 255));
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028, Y = r * 0.283881 + g * 0.668433 + b * 0.047685, Z = r * 0.000088 + g * 0.072310 + b * 0.986039;
  const s = X + Y + Z || 1;
  return { x: +(X / s).toFixed(4), y: +(Y / s).toFixed(4) };
}
// white light in mirek (153 cool … 500 warm) → a screen color (Tanner Helland's curve)
export function mirekToHex(mirek){
  const t = 1e6 / mirek / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return hex(r / 255, g / 255, b / 255);
}
// what a light looks like right now (null when it's off)
export function lightHex(l){
  if (!l.on?.on) return null;
  if (l.color_temperature?.mirek_valid && l.color_temperature.mirek && (!l.color || l.colorMode === 'ct')) return mirekToHex(l.color_temperature.mirek);
  if (l.color?.xy) return xyToHex(l.color.xy);
  if (l.color_temperature?.mirek) return mirekToHex(l.color_temperature.mirek);
  return '#ffe2a8';   // a plain dimmable bulb: warm white
}
// a scene's colors, for its tile and icon
export function sceneColors(s){
  const p = s.palette || {}, out = [];
  for (const c of p.color || []) out.push(xyToHex(c.color.xy));
  for (const c of p.color_temperature || []) out.push(mirekToHex(c.color_temperature.mirek));
  if (!out.length) for (const a of s.actions || []){
    const x = a.action;
    if (x.color?.xy) out.push(xyToHex(x.color.xy));
    else if (x.color_temperature?.mirek) out.push(mirekToHex(x.color_temperature.mirek));
  }
  return [...new Set(out)].slice(0, 5).concat(out.length ? [] : ['#ffe2a8']);
}

/* ---------------- The home ---------------- */
// rooms and zones with their lights, group switch and scenes; plus the whole-home switch
export async function loadHome(api){
  const kinds = ['room', 'zone', 'grouped_light', 'scene', 'light', 'device', 'bridge_home'];
  const [rooms, zones, groups, scenes, lights, devices, homes] = await Promise.all(kinds.map(k => api.get(k)));
  const byId = new Map([...groups, ...lights, ...devices].map(r => [r.id, r]));
  const service = (r, type) => r.services?.find(s => s.rtype === type)?.rid;
  const lightsOf = r => r.children.flatMap(c =>
    c.rtype === 'light' ? [c.rid] : c.rtype === 'device' ? (byId.get(c.rid)?.services || []).filter(s => s.rtype === 'light').map(s => s.rid) : []);
  const groupsOut = [...rooms.map(r => ({ r, kind: 'room' })), ...zones.map(r => ({ r, kind: 'zone' }))].map(({ r, kind }) => ({
    id: r.id, kind, name: r.metadata.name, archetype: r.metadata.archetype,
    gl: service(r, 'grouped_light'),
    lights: lightsOf(r).filter(id => byId.has(id)),
    scenes: scenes.filter(s => s.group?.rid === r.id).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)).map(s => s.id),
  })).filter(g => g.gl);
  groupsOut.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'room' ? -1 : 1));
  return {
    groups: groupsOut,
    home: homes[0] ? service(homes[0], 'grouped_light') : null,
    lights: new Map(lights.map(l => [l.id, l])),
    gls: new Map(groups.map(g => [g.id, g])),
    scenes: new Map(scenes.map(s => [s.id, s])),
  };
}
// the parts that change while the app is open (switches, brightness, colors, which scene is showing)
export async function refreshState(api, home){
  const [groups, lights, scenes] = await Promise.all(['grouped_light', 'light', 'scene'].map(k => api.get(k)));
  for (const g of groups) home.gls.set(g.id, g);
  for (const l of lights) home.lights.set(l.id, l);
  for (const s of scenes) if (home.scenes.has(s.id)) home.scenes.set(s.id, s);
}
