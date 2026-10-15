// Shortcut icons, drawn on a canvas: the colors of the room, light or scene in a glowing disc, with a
// white sign on top (house = room, bulb = light, sparkle = scene, power sign = an "off" shortcut).
const GLYPHS = {   // 24×24 drawings, stroked
  room: 'M4 11.5 12 5l8 6.5M6.5 10v8.5h11V10M10.5 18.5v-4.5h3v4.5',
  home: 'M3 11 12 4l9 7M5.5 9.5v9h13v-9M9 18.5v-5h6v5',
  light: 'M12 3.5a5.6 5.6 0 0 0-3.3 10.1c.5.4.8 1 .8 1.7V16.5h5v-1.2c0-.7.3-1.3.8-1.7A5.6 5.6 0 0 0 12 3.5zM10 19.5h4',
  scene: 'M12 4.5l1.6 4.4 4.4 1.6-4.4 1.6L12 16.5l-1.6-4.4L6 10.5l4.4-1.6zM17.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  off: 'M12 4v7M7.3 7.2a6.5 6.5 0 1 0 9.4 0',
};

// → a 256×256 canvas
export function makeIcon(kind, colors, mode){
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const off = mode === 'off';
  const cols = off ? ['#5b5e66', '#43464d'] : colors.length ? colors : ['#ffe2a8'];
  // rounded dark tile
  g.fillStyle = '#16171a';
  g.beginPath(); g.roundRect(8, 8, 240, 240, 54); g.fill();
  // the colors: a soft glow, then a disc (a color wheel of the scene, or one color shading out)
  const glow = g.createRadialGradient(128, 128, 30, 128, 128, 128);
  glow.addColorStop(0, cols[0] + '88'); glow.addColorStop(1, cols[0] + '00');
  g.fillStyle = glow; g.beginPath(); g.roundRect(8, 8, 240, 240, 54); g.fill();
  let fill;
  if (cols.length > 1 && g.createConicGradient){
    fill = g.createConicGradient(-Math.PI / 2, 128, 128);
    cols.forEach((col, i) => fill.addColorStop(i / cols.length, col));
    fill.addColorStop(1, cols[0]);
  } else {
    fill = g.createRadialGradient(110, 100, 10, 128, 128, 96);
    fill.addColorStop(0, '#ffffff'); fill.addColorStop(0.35, cols[0]); fill.addColorStop(1, cols[cols.length - 1]);
  }
  g.fillStyle = fill; g.beginPath(); g.arc(128, 128, 92, 0, Math.PI * 2); g.fill();
  // a dark center so the white sign reads on any color
  const mid = g.createRadialGradient(128, 128, 0, 128, 128, 92);
  mid.addColorStop(0, 'rgba(0,0,0,.42)'); mid.addColorStop(0.7, 'rgba(0,0,0,.12)'); mid.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = mid; g.beginPath(); g.arc(128, 128, 92, 0, Math.PI * 2); g.fill();
  // the sign
  g.save(); g.translate(128 - 12 * 5.2, 128 - 12 * 5.2); g.scale(5.2, 5.2);
  g.strokeStyle = '#fff'; g.lineWidth = 2; g.lineCap = 'round'; g.lineJoin = 'round';
  g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 1.5;
  const p = new Path2D(GLYPHS[off ? 'off' : kind] || GLYPHS.light);
  if (kind === 'scene' && !off){ g.fillStyle = '#fff'; g.fill(p); } else g.stroke(p);
  g.restore();
  return c;
}
export const iconPng = canvas => canvas.toDataURL('image/png').split(',')[1];
