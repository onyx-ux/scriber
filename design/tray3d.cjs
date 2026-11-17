// The dice tray, drawn from a small 3D model instead of by eye: a tray, six
// dice resting on real faces at their own angles, the desk over the far
// corner and a steel rule on it, all through one camera. Output is plain SVG
// line work, so the page ships a drawing and none of this.
const fs = require('fs');
const NIGHT = '#171C22', INK = '#F1EFE8';

// ── vectors ──────────────────────────────────────────────────────────────
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => mul(a, 1 / (len(a) || 1));
const mean = (ps) => mul(ps.reduce(add, [0, 0, 0]), 1 / ps.length);
const rotAxis = (v, k, t) => { // Rodrigues
  const c = Math.cos(t), s = Math.sin(t);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
};

// ── camera: looking down at the tray from in front and to one side ───────
const YAW = 33 * Math.PI / 180, ELEV = 56 * Math.PI / 180;
const cy = Math.cos(YAW), sy = Math.sin(YAW), se = Math.sin(ELEV), ce = Math.cos(ELEV);
const P = ([x, y, z]) => [x * cy - y * sy, -((x * sy + y * cy) * se + z * ce)];
const PV = P; // linear, so vectors project the same way
const depth = ([x, y, z]) => -(x * sy + y * cy) * ce + z * se;
const TOCAM = unit([-ce * sy, -ce * cy, se]);

// ── solids ────────────────────────────────────────────────────────────────
const PHI = (1 + Math.sqrt(5)) / 2;
const cyc = (v) => [v, [v[2], v[0], v[1]], [v[1], v[2], v[0]]];
const signs = (v) => { let out = [[]]; v.forEach((c) => { out = out.flatMap((p) => c === 0 ? [[...p, 0]] : [[...p, c], [...p, -c]]); }); return out; };
const SOLIDS = {
  d4: [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]],
  d6: signs([1, 1, 1]),
  d8: cyc([1, 0, 0]).flatMap(signs),
  d12: [...signs([1, 1, 1]), ...cyc([0, 1 / PHI, PHI]).flatMap(signs)],
  d20: cyc([0, 1, PHI]).flatMap(signs),
  d10: (() => { // pentagonal trapezohedron, with the apex height that keeps its kites flat
    const t = 0.105, c = Math.cos(Math.PI / 5), a = t * (1 + c) / (1 - c), v = [[0, 0, a], [0, 0, -a]];
    for (let k = 0; k < 10; k += 1) v.push([Math.cos(k * Math.PI / 5), Math.sin(k * Math.PI / 5), k % 2 ? -t : t]);
    return v;
  })(),
};
// Faces of a convex solid, found from its vertices: any plane through three
// of them with everything else on one side is a face.
function facesOf(vs) {
  const faces = [], seen = new Set();
  for (let i = 0; i < vs.length; i += 1) for (let j = i + 1; j < vs.length; j += 1) for (let k = j + 1; k < vs.length; k += 1) {
    let n = cross(sub(vs[j], vs[i]), sub(vs[k], vs[i]));
    if (len(n) < 1e-9) continue;
    n = unit(n);
    const d = vs.map((v) => dot(n, sub(v, vs[i])));
    if (d.some((x) => x > 1e-6) && d.some((x) => x < -1e-6)) continue;
    if (d.some((x) => x > 1e-6)) n = mul(n, -1);
    const on = d.map((x, q) => Math.abs(x) < 1e-6 ? q : -1).filter((q) => q >= 0);
    const key = on.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const c = mean(on.map((q) => vs[q])), u = unit(sub(vs[on[0]], c)), w = cross(n, u);
    on.sort((p, q) => Math.atan2(dot(sub(vs[p], c), w), dot(sub(vs[p], c), u)) - Math.atan2(dot(sub(vs[q], c), w), dot(sub(vs[q], c), u)));
    faces.push({ idx: on, n });
  }
  return faces;
}

// A seeded throw, so a good one can be kept: node tray3d.cjs <seed>
let seed = Number(process.argv[2] || 3) >>> 0;
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const f1 = (n) => (Math.round(n * 10) / 10).toString();
const poly = (pts, fill = NIGHT) => `<path d="M${pts.map((p) => P(p).map(f1).join(' ')).join('L')}Z" fill="${fill}"/>`;
const line = (a, b) => `<path d="M${P(a).map(f1).join(' ')}L${P(b).map(f1).join(' ')}"/>`;
const all = []; // every point that should be inside the frame

// A die resting on one of its faces at (x, y) on the tray floor, turned by `spin`.
function die(kind, size, x, y, spin, restOn = 0) {
  let vs = SOLIDS[kind].map((v) => mul(v, size / len(SOLIDS[kind][2])));
  const faces = facesOf(vs);
  // Lay the chosen face flat on the floor.
  const down = faces[restOn % faces.length].n, axis = cross(down, [0, 0, -1]);
  const ang = Math.acos(Math.max(-1, Math.min(1, dot(down, [0, 0, -1]))));
  if (len(axis) > 1e-6) vs = vs.map((v) => rotAxis(v, unit(axis), ang));
  vs = vs.map((v) => rotAxis(v, [0, 0, 1], spin));
  const lift = -Math.min(...vs.map((v) => v[2]));
  vs = vs.map((v) => add(v, [x, y, lift]));
  vs.forEach((v) => all.push(v));

  const placed = faces.map((f, i) => {
    const pts = f.idx.map((q) => vs[q]), c = mean(pts);
    const n = unit(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    const out = dot(n, sub(c, mean(vs))) < 0 ? mul(n, -1) : n;
    return { i, pts, c, n: out, facing: dot(out, TOCAM) };
  });
  // The d20 shows its 20 on top. Every other die came down however it came down.
  const top = placed.reduce((a, b) => (b.c[2] > a.c[2] ? b : a));
  const nums = placed.map((f) => f.i + 1);
  if (kind === 'd20') { const hi = placed.length, was = nums[top.i], at = nums.indexOf(hi); nums[top.i] = hi; nums[at] = was; }
  else for (let q = nums.length - 1; q > 0; q -= 1) { const r = Math.floor(rnd() * (q + 1)); [nums[q], nums[r]] = [nums[r], nums[q]]; }

  let out = '';
  for (const f of placed.filter((f) => f.facing > 0.02)) {
    out += poly(f.pts);
    if (f.facing < 0.3) continue; // too edge-on to read; a real one would be a smear
    const inr = Math.min(...f.pts.map((p, q) => { const b = f.pts[(q + 1) % f.pts.length]; return len(cross(sub(f.c, p), unit(sub(b, p)))); }));
    const label = String(kind === 'd10' ? nums[f.i] % 10 : nums[f.i]);
    const s = inr * (f.pts.length === 3 ? 1.0 : f.pts.length === 4 ? 1.15 : 1.05) * (label.length > 1 ? 0.8 : 1);
    const up = unit(sub(f.pts[0], f.c)), right = cross(up, f.n);
    const a = PV(right), d = PV(mul(up, -1)), e = P(f.c);
    out += `<text transform="matrix(${[a[0], a[1], d[0], d[1], e[0], e[1]].map((v) => (Math.round(v * 1000) / 1000)).join(' ')})" y="${f1(s * 0.36)}" font-size="${f1(s)}">${label}</text>`;
  }
  return { svg: out, depth: depth(mean(vs)) };
}

// ── the tray ──────────────────────────────────────────────────────────────
const W = 400, D = 250, T = 16, H = 46, B = -7; // outer size, wall, rim height, underside
const rect = (x0, y0, x1, y1, z) => [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
rect(0, 0, W, D, H).concat(rect(0, 0, W, D, B)).forEach((p) => all.push(p));
let svg = '';
svg += poly(rect(T, T, W - T, D - T, 0));                                                    // floor
svg += poly([[T, D - T, 0], [W - T, D - T, 0], [W - T, D - T, H], [T, D - T, H]]);          // far wall, inside
svg += poly([[W - T, T, 0], [W - T, D - T, 0], [W - T, D - T, H], [W - T, T, H]]);          // right wall, inside

// Thrown, not arranged: each die lands anywhere on the floor that is not
// already taken, up to a little way under the desk, at any turn, on any face.
const edgeX = (y) => (W - 195) + (D + 10 - y) * 60 / (D + 20); // the desk's edge, in plan
const thrown = [];
for (const [kind, size] of [['d20', 27], ['d6', 30], ['d10', 29], ['d12', 27], ['d8', 27], ['d4', 30]]) {
  for (let tries = 0; tries < 4000; tries += 1) {
    const y = T + size + rnd() * (D - 2 * T - 2 * size);
    const x = T + size + rnd() * (edgeX(y) + 14 - T - size);
    if (kind === 'd20' && x > edgeX(y) - size) continue; // the 20 stays in the open
    if (thrown.some((o) => Math.hypot(o.x - x, o.y - y) < o.size + size + 4)) continue;
    thrown.push({ kind, size, x, y, spin: rnd() * Math.PI * 2, rest: Math.floor(rnd() * 20) });
    break;
  }
}
if (thrown.length < 6) throw new Error('no room for all six');
const dice = thrown.map((d) => die(d.kind, d.size, d.x, d.y, d.spin, d.rest)).sort((a, b) => a.depth - b.depth);
svg += dice.map((d) => d.svg).join('');

// the rim as one frame, then the two walls facing us
const ring = (pts) => 'M' + pts.map((p) => P(p).map(f1).join(' ')).join('L') + 'Z';
svg += `<path d="${ring(rect(0, 0, W, D, H))}${ring(rect(T, T, W - T, D - T, H))}" fill="${NIGHT}" fill-rule="evenodd"/>`;
svg += poly([[0, 0, B], [W, 0, B], [W, 0, H], [0, 0, H]]);
svg += poly([[0, 0, B], [0, D, B], [0, D, H], [0, 0, H]]);
// the handle on the left wall
{
  const y0 = 92, y1 = 158, x0 = -24, z0 = 12, z1 = 28;
  [[x0, y0, z0], [x0, y1, z1]].forEach((p) => all.push(p));
  svg += poly([[x0, y0, z1], [0, y0, z1], [0, y1, z1], [x0, y1, z1]]);   // top
  svg += poly([[x0, y0, z0], [0, y0, z0], [0, y0, z1], [x0, y0, z1]]);   // end facing us
  svg += poly([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]]); // outer side
}

// ── the desk over the far corner, and the rule on it ─────────────────────
{
  const Z0 = 48, Z1 = 74;
  const p0 = [W - 195, D + 10], p1 = [W - 135, -10];          // where its edge crosses, in plan
  const dir = unit([p1[0] - p0[0], p1[1] - p0[1], 0]), back = [-dir[1], dir[0], 0]; // back = away from the tray
  const far = dot(back, sub([W, D, 0], [p0[0], p0[1], 0])) > 0 ? back : mul(back, -1);
  const a = add([p0[0], p0[1], 0], mul(dir, -420)), b = add([p1[0], p1[1], 0], mul(dir, 420));
  const at = (p, z) => [p[0], p[1], z];
  const a2 = add(a, mul(far, 700)), b2 = add(b, mul(far, 700));
  svg += poly([at(a, Z1), at(b, Z1), at(b2, Z1), at(a2, Z1)]);         // top
  svg += poly([at(a, Z0), at(b, Z0), at(b, Z1), at(a, Z1)]);           // the edge facing us
  [at(add([p0[0], p0[1], 0], mul(dir, -70)), Z1), at(add([p1[0], p1[1], 0], mul(dir, 40)), Z0)].forEach((p) => all.push(p));

  // the rule: a thin bar a little way in from the edge, not quite parallel to it
  const o = add(add([p0[0], p0[1], Z1], mul(dir, 70)), mul(far, 40)), rd = unit(rotAxis(dir, [0, 0, 1], -0.09)), rw = cross([0, 0, 1], rd);
  const L = 200, WD = 17, r = (u, v, z = 0) => add(add(add(o, mul(rd, u)), mul(rw, v)), [0, 0, z]);
  [r(0, 0, 2), r(L, WD, 2)].forEach((p) => all.push(p));
  svg += poly([r(0, 0, 2), r(L, 0, 2), r(L, WD, 2), r(0, WD, 2)]);
  svg += poly([r(0, 0, 0), r(L, 0, 0), r(L, 0, 2), r(0, 0, 2)]);
  for (let u = 20; u < L; u += 20) svg += line(r(u, 0, 2), r(u, u % 40 === 0 ? 9 : 6, 2));
}

// ── frame it ──────────────────────────────────────────────────────────────
const pts = all.map(P), xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
const pad = 10, x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad, w = Math.max(...xs) - x0 + pad, h = Math.max(...ys) - y0 + pad;
const out = `<svg class="inkmark desk" viewBox="${f1(x0)} ${f1(y0)} ${f1(w)} ${f1(h)}" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
    <!-- A dice tray pulled out from under a desk. Generated by a small 3D model
         (design/tray3d.cjs) so the dice sit on real faces at real angles. -->
    <g font-family="Spline Sans Mono, monospace" text-anchor="middle">
    ${svg.replace(/<text /g, `<text fill="${INK}" stroke="none" `)}
    </g>
  </svg>`;

const f = require('path').join(__dirname, '..', 'dashboard', 'html', 'quill-landing.html');
let s = fs.readFileSync(f, 'utf8');
const i = s.indexOf('<svg class="inkmark desk"'), j = s.indexOf('</svg>', i) + 6;
if (i < 0) throw new Error('no desk svg');
s = s.slice(0, i) + out + s.slice(j);
fs.writeFileSync(f, s);
console.log('ok', out.length, 'bytes', 'viewBox', f1(w), 'x', f1(h));
