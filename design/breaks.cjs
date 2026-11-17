// Page breaks, inked: the ruler ticks go, and where each section's line begins
// its run the pen has blotted: one spot, a spray of smaller ones, and the
// stroke dragging away from it along the rule. Run again to re-roll: node p27.cjs <seed>
const fs=require('fs');
const f=require('path').join(__dirname, '..', 'dashboard', 'html', 'quill-landing.html');
let s=fs.readFileSync(f,'utf8');
let seed = Number(process.argv[2] || 5) >>> 0;
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const between = (a, b) => a + rnd() * (b - a);
const f1 = (n) => (Math.round(n * 10) / 10).toString();

// An ink spot: a circle whose edge wanders, closed with smooth curves.
function spot(cx, cy, r, wobble) {
  const n = r < 2 ? 6 : 11, pts = [];
  for (let k = 0; k < n; k += 1) {
    const a = (k / n) * Math.PI * 2 + between(-0.12, 0.12), rr = r * (1 + between(-wobble, wobble));
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.92]);
  }
  let d = '';
  for (let k = 0; k < n; k += 1) { // Catmull-Rom through the points, as beziers
    const p0 = pts[(k + n - 1) % n], p1 = pts[k], p2 = pts[(k + 1) % n], p3 = pts[(k + 2) % n];
    if (k === 0) d += `M${f1(p1[0])} ${f1(p1[1])}`;
    d += `C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return d + 'Z';
}

const W = 300, H = 70, MID = H / 2;
// A blot is where the pen came down: at the start of a stroke. `dirn` is the
// way the stroke then goes (1 right, -1 left). `kind` is how the pen got there:
//   'start'  back through the air from the end of the line before, so the
//            drops it shed come down to the spot from above, over the line;
//   'mid'    lifted off this same line a little way back, so they follow the
//            line across the gap.
function blot(dirn, kind) {
  const cx = dirn > 0 ? between(96, 110) : between(W - 110, W - 96), cy = MID + between(-1.5, 1.5), r = between(6.5, 8.5);
  let d = spot(cx, cy, r, 0.18);
  // a lobe run into it on the side the pen arrived from
  d += spot(cx - dirn * between(r * 0.7, r * 1.05), cy + between(-3, 3), r * between(0.4, 0.55), 0.22);
  // and a tongue the other way, where the nib dragged the pool out into the stroke
  const t = r * 0.5, L = between(13, 19);
  const tongue = `M${f1(cx)} ${f1(cy - t)}Q${f1(cx + dirn * L * 0.5)} ${f1(cy - t * 0.7)} ${f1(cx + dirn * (r + L))} ${f1(cy)}Q${f1(cx + dirn * L * 0.5)} ${f1(cy + t * 0.7)} ${f1(cx)} ${f1(cy + t)}Z`;
  // spatter thrown off as it landed: fine, close, and mostly back the way it came
  const count = 6 + Math.floor(rnd() * 4);
  for (let k = 0; k < count; k += 1) {
    const a = between(0, Math.PI * 2), back = Math.cos(a) * dirn < 0, dist = r + between(3, back ? 20 : 11);
    d += spot(cx + Math.cos(a) * dist, cy + Math.sin(a) * dist * 0.6, between(0.5, back ? 1.7 : 1.1), 0.25);
  }
  // the trail: drops shed on the way in, bigger and closer together as the pen slowed
  const far = kind === 'mid' ? [-dirn * between(50, 56), between(-1.5, 1.5)] : [dirn * between(64, 82), -between(21, 27)];
  const n = kind === 'mid' ? 4 : 5, reach = Math.hypot(far[0], far[1]), stop = (r + 6) / reach;
  for (let k = 0; k < n; k += 1) {
    const q = k / (n - 1), along = stop + (1 - stop) * Math.pow(q, 1.35);   // 1 at the far end, `stop` beside the spot
    const dip = kind === 'mid' ? 0 : -Math.sin(q * Math.PI) * 3;               // the pen swings down to the page
    d += spot(cx + far[0] * along + between(-1.2, 1.2), cy + far[1] * along * along + dip + between(-1, 1), 0.7 + (1 - q) * 1.5 + between(-0.15, 0.15), 0.22);
  }
  return { d, tongue, cx, cy };
}

// The line itself, in ink. It bows the way a line ruled freehand does, presses
// harder in places, and lifts to a point. `blotAt` is where along it (0 to 1,
// left to right) the pen came down in a blot; if that is part-way along, the
// line is two strokes: the first lifts off short of the spot, leaving bare
// paper, and the second starts from it.
const LH = 30, LMID = LH / 2, GAP = 0.11;
function inkline(dirn, blotAt) {
  const a1 = between(3.6, 5) * (rnd() < 0.5 ? -1 : 1), w1 = between(0.75, 1.15), p1 = between(0, 1);
  const a2 = between(1, 1.7), w2 = between(2.1, 3.2), p2 = between(0, 1);
  const bow = (u) => a1 * Math.sin(2 * Math.PI * (u * w1 + p1)) + a2 * Math.sin(2 * Math.PI * (u * w2 + p2));
  const r2 = (v) => Math.round(v * 100) / 100;
  // one stroke from where the pen starts to where it lifts, both as 0-to-1 across the page
  const stroke = (from, to, fromBlot, lift) => {
    const span = Math.abs(to - from), N = Math.max(12, Math.round(span * 130)), top = [], bot = [];
    let h = between(0.7, 1.1), jit = 0, press = fromBlot ? 0.7 : 0;
    for (let k = 0; k <= N; k += 1) {
      const x = from + (to - from) * (k / N), gone = span * (k / N), left = span - gone;
      if (rnd() < 0.05) press = between(0.4, 0.9);           // a moment of pressure
      press *= 0.82;
      h += between(-0.08, 0.08); h = Math.max(0.5, Math.min(1.15, h));
      jit += between(-0.1, 0.1); jit = Math.max(-0.5, Math.min(0.5, jit));
      const taper = Math.min(1, (fromBlot ? 0.6 : 0) + gone * 40) * Math.min(1, left * lift);
      const half = (h + press) * taper, y = LMID + bow(x) + jit;
      top.push(f1(x * 1000) + ' ' + r2(y - half)); bot.push(f1(x * 1000) + ' ' + r2(y + half));
    }
    return 'M' + top.join('L') + 'L' + bot.reverse().join('L') + 'Z';
  };
  const begin = dirn > 0 ? 0 : 1, end = 1 - begin;
  const d = Math.abs(blotAt - begin) < 0.02
    ? stroke(blotAt, end, true, 6)
    : stroke(begin, blotAt - dirn * GAP, false, 14) + stroke(blotAt, end, true, 6);
  return { d, bow };
}

// out with what an earlier run left, and the ruler before that
s = s.replace(/\s*<svg class="inkmark (blot|inkline)[^]*?<\/svg>/g, '');
const cut=(from,to)=>{ const i=s.indexOf(from); if(i<0) return false; const j=s.indexOf(to,i); if(j<0) throw new Error('cut end: '+to); s=s.slice(0,i)+s.slice(j+to.length); return true; };
cut(`/* That rule, marked off like the steel rule`, `repeating-linear-gradient(90deg,var(--rule) 0 1px,transparent 1px 12px) 0 0/100% 5px no-repeat}\n`);
cut(`/* Between sections the line starts as a rule's end too`, `mask-image:linear-gradient(90deg,#000 30%,transparent)}`);
cut(`/* Where a section's line starts, the pen has blotted.`, `@media (max-width:900px){.inkmark.blot{width:210px;height:49px;top:-24px}}\n\n`)
  || cut(`/* ink breaks */`, `/* end ink breaks */\n\n`);

const anchor = `/* Each of the four carries its number on a d4 face. */`;
if (s.split(anchor).length !== 2) throw new Error('anchor');
s = s.replace(anchor, () => `/* ink breaks */
/* A page break is a line ruled in ink, freehand, with a blot where the pen
   rested. Drawn once (design/breaks.cjs) and shipped as plain SVG.
   --line-l and --line-w are the content column, so the blot can be put a
   fraction of the way along the line and so sit on it at any width. */
.band{--line-l:max(var(--pad), calc((100% - var(--shell)) / 2 + var(--pad)));--line-w:min(calc(100% - 2 * var(--pad)), calc(var(--shell) - 2 * var(--pad)))}
.inkmark.inkline{position:absolute;top:-${LMID}px;height:${LH}px;left:var(--line-l);width:var(--line-w);color:var(--pen);pointer-events:none}
/* It stands in for the hairline, so that goes where there is one of these. */
.texture .band:has(> .inkline)::before{display:none}
.motion .inkmark.inkline{clip-path:inset(0 100% 0 0);transition:clip-path 1.2s cubic-bezier(.3,.6,.2,1) .1s}
.motion .inkmark.inkline.rtl{clip-path:inset(0 0 0 100%)}
.motion .band.in .inkmark.inkline{clip-path:inset(0)}
.inkmark.blot{--k:1;position:absolute;width:calc(${W}px * var(--k));height:calc(${H}px * var(--k));color:var(--pen);pointer-events:none;z-index:1;
  left:calc(var(--line-l) + var(--u) * var(--line-w) - var(--cx) * var(--k) * 1px);top:calc(var(--dy) * 1px - var(--cy) * var(--k) * 1px)}
.motion .inkmark.blot{opacity:0;transform:scale(.96);transition:opacity .5s ease .55s, transform .7s cubic-bezier(.2,.7,.2,1) .55s}
.motion .band.in .inkmark.blot{opacity:1;transform:none}
@media (max-width:900px){.inkmark.blot{--k:.7}}
/* A blot near the end of a line hangs past the column, and on a phone past
   the screen; clipped here so it cannot widen the page and make it pan. */
.band{overflow-x:clip}
/* end ink breaks */

` + anchor);

// one per break: [section, how far along the line the blot sits, which way the pen went]
const where = [['id="names"', 0.62, 1], ['id="consent"', 0, 1], ['id="start"', 1, -1]];
for (const [mark, u, dirn] of where) {
  const i = s.indexOf(mark); if (i < 0) throw new Error('no ' + mark);
  const j = s.indexOf('>', i) + 1, line = inkline(dirn, u), b = blot(dirn, u > 0.02 && u < 0.98 ? 'mid' : 'start');
  s = s.slice(0, j) + `\n  <svg class="inkmark inkline${dirn < 0 ? ' rtl' : ''}" viewBox="0 0 1000 ${LH}" preserveAspectRatio="none" fill="currentColor" aria-hidden="true"><path d="${line.d}"/></svg>`
    + `\n  <svg class="inkmark blot" style="--u:${u};--cx:${f1(b.cx)};--cy:${f1(b.cy)};--dy:${f1(line.bow(u))}" viewBox="0 0 ${W} ${H}" fill="currentColor" aria-hidden="true"><path d="${b.d}"/><path d="${b.tongue}"/></svg>` + s.slice(j);
}
fs.writeFileSync(f,s);
console.log('ok', (s.match(/inkmark blot"/g) || []).length, 'blots', (s.match(/inkmark inkline/g) || []).length - 0, 'line mentions');
