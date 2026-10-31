/* BRASS — geometry & utility primitives (world units = metres) */
(function () {
  const B = (window.B = window.B || {});

  // Deterministic RNG (mulberry32) so the sample city is identical on every load.
  B.rng = function (seed) {
    let a = seed >>> 0;
    const f = function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.range = (lo, hi) => lo + (hi - lo) * f();
    f.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * f());
    f.pick = (arr) => arr[Math.floor(f() * arr.length)];
    return f;
  };

  B.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  B.dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  B.dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; };
  B.angNorm = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; };

  B.projSeg = function (p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const x = a.x + dx * t, y = a.y + dy * t, ex = p.x - x, ey = p.y - y;
    return { t, x, y, d2: ex * ex + ey * ey };
  };
  B.distSeg = (p, a, b) => Math.sqrt(B.projSeg(p, a, b).d2);

  B.distPolyline = function (p, pts, closed) {
    let m = Infinity; const n = pts.length;
    for (let i = 0; i < n - 1; i++) { const d = B.projSeg(p, pts[i], pts[i + 1]).d2; if (d < m) m = d; }
    if (closed && n > 2) { const d = B.projSeg(p, pts[n - 1], pts[0]).d2; if (d < m) m = d; }
    return Math.sqrt(m);
  };

  B.pointInPoly = function (p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };

  const orient = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  B.segsIntersect = function (a, b, c, d) {
    const d1 = orient(c, d, a), d2 = orient(c, d, b), d3 = orient(a, b, c), d4 = orient(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  B.segSegDist = function (a, b, c, d) {
    if (B.segsIntersect(a, b, c, d)) return 0;
    return Math.min(B.distSeg(a, c, d), B.distSeg(b, c, d), B.distSeg(c, a, b), B.distSeg(d, a, b));
  };
  B.segPolyDist = function (a, b, poly) {
    if (B.pointInPoly(a, poly)) return 0;
    let m = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const d = B.segSegDist(a, b, poly[j], poly[i]); if (d < m) m = d; if (m === 0) return 0;
    }
    return m;
  };
  B.polylineIntersectsPoly = function (pts, poly) {
    for (const p of pts) if (B.pointInPoly(p, poly)) return true;
    for (let k = 0; k < pts.length - 1; k++)
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
        if (B.segsIntersect(pts[k], pts[k + 1], poly[j], poly[i])) return true;
    return false;
  };

  B.bbox = function (pts, pad = 0) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
    return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  };
  B.bboxOverlap = (a, b) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;

  B.chaikin = function (pts, iters, closed) {
    let p = pts;
    for (let k = 0; k < iters; k++) {
      const out = []; const n = p.length;
      const lim = closed ? n : n - 1;
      if (!closed) out.push(p[0]);
      for (let i = 0; i < lim; i++) {
        const a = p[i], b = p[(i + 1) % n];
        out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
        out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
      }
      if (!closed) out.push(p[n - 1]);
      p = out;
    }
    return p;
  };

  B.rectPoly = function (cx, cy, w, h, ang) {
    const c = Math.cos(ang), s = Math.sin(ang), hw = w / 2, hh = h / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c }));
  };

  // Separating-axis test for convex polygons.
  B.convexOverlap = function (p1, p2) {
    for (const poly of [p1, p2]) {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const nx = b.y - a.y, ny = a.x - b.x;
        let min1 = Infinity, max1 = -Infinity, min2 = Infinity, max2 = -Infinity;
        for (const p of p1) { const d = p.x * nx + p.y * ny; if (d < min1) min1 = d; if (d > max1) max1 = d; }
        for (const p of p2) { const d = p.x * nx + p.y * ny; if (d < min2) min2 = d; if (d > max2) max2 = d; }
        if (max1 < min2 || max2 < min1) return false;
      }
    }
    return true;
  };

  B.cumLengths = function (pts) {
    const c = [0];
    for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + B.dist(pts[i - 1], pts[i]));
    return c;
  };
  B.pointAlong = function (pts, cum, s) {
    const L = cum[cum.length - 1];
    s = B.clamp(s, 0, L);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const a = pts[lo], b = pts[hi], seg = cum[hi] - cum[lo] || 1, t = (s - cum[lo]) / seg;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, ang: Math.atan2(b.y - a.y, b.x - a.x), i: lo };
  };
  B.slicePolyline = function (pts, cum, s0, s1) {
    const rev = s1 < s0; if (rev) { const t = s0; s0 = s1; s1 = t; }
    const out = [B.pointAlong(pts, cum, s0)];
    for (let i = 0; i < pts.length; i++) if (cum[i] > s0 + 0.01 && cum[i] < s1 - 0.01) out.push({ x: pts[i].x, y: pts[i].y });
    out.push(B.pointAlong(pts, cum, s1));
    const res = out.map((p) => ({ x: p.x, y: p.y }));
    return rev ? res.reverse() : res;
  };

  // Offset to the LEFT of travel direction (y-down screen coords). Singapore drives on the left.
  B.offsetPolyline = function (pts, d) {
    const n = pts.length; if (n < 2) return pts.slice();
    const normals = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y, l = Math.hypot(dx, dy) || 1;
      normals.push({ x: dy / l, y: -dx / l });
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      let nx, ny;
      if (i === 0) { nx = normals[0].x; ny = normals[0].y; }
      else if (i === n - 1) { nx = normals[n - 2].x; ny = normals[n - 2].y; }
      else {
        const a = normals[i - 1], b = normals[i];
        nx = a.x + b.x; ny = a.y + b.y; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
        const k = Math.max(0.4, nx * a.x + ny * a.y); nx /= k; ny /= k;
      }
      out.push({ x: pts[i].x + nx * d, y: pts[i].y + ny * d });
    }
    return out;
  };

  B.polyArea = function (poly) {
    let a = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
    return Math.abs(a / 2);
  };
  B.centroid = function (poly) {
    let x = 0, y = 0; for (const p of poly) { x += p.x; y += p.y; } return { x: x / poly.length, y: y / poly.length };
  };
  B.circlePoly = function (cx, cy, r, n = 48) {
    const out = []; for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); } return out;
  };
  B.blob = function (cx, cy, rx, ry, n, noise, rnd, rot = 0) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, k = 1 + (rnd() - 0.5) * noise;
      const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
      pts.push({ x: cx + x * Math.cos(rot) - y * Math.sin(rot), y: cy + x * Math.sin(rot) + y * Math.cos(rot) });
    }
    return B.chaikin(pts, 3, true);
  };

  B.SpatialHash = class {
    constructor(cell) { this.c = cell; this.m = new Map(); }
    _k(i, j) { return (i + 2000) * 10000 + (j + 2000); }
    insert(item, bb) {
      const c = this.c;
      for (let i = Math.floor(bb.x0 / c); i <= Math.floor(bb.x1 / c); i++)
        for (let j = Math.floor(bb.y0 / c); j <= Math.floor(bb.y1 / c); j++) {
          const k = this._k(i, j); let a = this.m.get(k); if (!a) { a = []; this.m.set(k, a); } a.push(item);
        }
    }
    query(bb) {
      const c = this.c, out = new Set();
      for (let i = Math.floor(bb.x0 / c); i <= Math.floor(bb.x1 / c); i++)
        for (let j = Math.floor(bb.y0 / c); j <= Math.floor(bb.y1 / c); j++) {
          const a = this.m.get(this._k(i, j)); if (a) for (const it of a) out.add(it);
        }
      return out;
    }
  };

  B.Heap = class {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(v, k) {
      const K = this.k, V = this.v; let i = K.length; K.push(k); V.push(v);
      while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= k) break; K[i] = K[p]; V[i] = V[p]; i = p; }
      K[i] = k; V[i] = v;
    }
    pop() {
      const K = this.k, V = this.v; const top = V[0], topk = K[0];
      const lk = K.pop(), lv = V.pop();
      if (K.length) {
        let i = 0; const n = K.length;
        while (true) {
          let l = 2 * i + 1, r = l + 1, m = i, mk = lk;
          if (l < n && K[l] < mk) { m = l; mk = K[l]; }
          if (r < n && K[r] < mk) { m = r; mk = K[r]; }
          if (m === i) break;
          K[i] = K[m]; V[i] = V[m]; i = m;
        }
        K[i] = lk; V[i] = lv;
      }
      this.lastKey = topk;
      return top;
    }
  };

  B.fmtKm = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m');
  B.fmtMin = (s) => Math.round(s / 60) + ' min';
  B.esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Curated distinct route color palettes (Base, Lane -> Intensive, Lane <- Lighter)
  B.ROUTE_PALETTE = [
    {
      name: 'Blue',
      dot: '🔵',
      base: '#2563eb',
      fwd: '#1d4ed8',     // Lane -> (Intensive Royal Blue)
      rev: '#60a5fa',     // Lane <- (Lighter Sky Blue)
      selFwd: '#1e3a8a',
      selRev: '#93c5fd',
      hovFwd: '#2563eb',
      hovRev: '#93c5fd',
    },
    {
      name: 'Red',
      dot: '🔴',
      base: '#dc2626',
      fwd: '#b91c1c',     // Lane -> (Intensive Crimson Red)
      rev: '#f87171',     // Lane <- (Lighter Coral Red)
      selFwd: '#991b1b',
      selRev: '#fca5a5',
      hovFwd: '#ef4444',
      hovRev: '#fca5a5',
    },
    {
      name: 'Purple',
      dot: '🟣',
      base: '#7c3aed',
      fwd: '#6d28d9',     // Lane -> (Intensive Royal Violet)
      rev: '#a78bfa',     // Lane <- (Lighter Soft Lavender)
      selFwd: '#5b21b6',
      selRev: '#c4b5fd',
      hovFwd: '#8b5cf6',
      hovRev: '#c4b5fd',
    },
    {
      name: 'Amber',
      dot: '🟠',
      base: '#d97706',
      fwd: '#b45309',
      rev: '#fbbf24',
      selFwd: '#92400e',
      selRev: '#fde68a',
      hovFwd: '#f59e0b',
      hovRev: '#fde68a',
    },
    {
      name: 'Teal',
      dot: '🟢',
      base: '#0d9488',
      fwd: '#0f766e',
      rev: '#2dd4bf',
      selFwd: '#115e59',
      selRev: '#5eead4',
      hovFwd: '#14b8a6',
      hovRev: '#5eead4',
    },
    {
      name: 'Emerald',
      dot: '🟢',
      base: '#059669',
      fwd: '#047857',     // Lane -> (Intensive Forest Emerald)
      rev: '#34d399',     // Lane <- (Lighter Mint Emerald)
      selFwd: '#065f46',
      selRev: '#6ee7b7',
      hovFwd: '#10b981',
      hovRev: '#6ee7b7',
    },
    {
      name: 'Pink',
      dot: '🩷',
      base: '#db2777',
      fwd: '#be185d',     // Lane -> (Intensive Magenta Rose)
      rev: '#f472b6',     // Lane <- (Lighter Soft Pink)
      selFwd: '#9d174d',
      selRev: '#fbcfe8',
      hovFwd: '#ec4899',
      hovRev: '#fbcfe8',
    },
    {
      name: 'Indigo',
      dot: '🔵',
      base: '#4f46e5',
      fwd: '#4338ca',     // Lane -> (Intensive Deep Indigo)
      rev: '#818cf8',     // Lane <- (Lighter Lavender Indigo)
      selFwd: '#3730a3',
      selRev: '#c7d2fe',
      hovFwd: '#6366f1',
      hovRev: '#c7d2fe',
    },
    {
      name: 'Lime',
      dot: '🟢',
      base: '#65a30d',
      fwd: '#4d7c0f',     // Lane -> (Intensive Olive Lime)
      rev: '#a3e635',     // Lane <- (Lighter Fresh Lime)
      selFwd: '#3f6212',
      selRev: '#d9f99d',
      hovFwd: '#84cc16',
      hovRev: '#d9f99d',
    },
    {
      name: 'Brown',
      dot: '🟤',
      base: '#92400e',
      fwd: '#78350f',     // Lane -> (Intensive Dark Brown)
      rev: '#d97757',     // Lane <- (Lighter Clay)
      selFwd: '#5c2a0c',
      selRev: '#fed7aa',
      hovFwd: '#b45309',
      hovRev: '#fed7aa',
    },
    {
      name: 'Cyan',
      dot: '🔵',
      base: '#0891b2',
      fwd: '#0e7490',     // Lane -> (Intensive Deep Cyan)
      rev: '#22d3ee',     // Lane <- (Lighter Sky Cyan)
      selFwd: '#155e75',
      selRev: '#a5f3fc',
      hovFwd: '#06b6d4',
      hovRev: '#a5f3fc',
    },
    {
      name: 'Charcoal',
      dot: '⚫',
      base: '#334155',
      fwd: '#1e293b',     // Lane -> (Intensive Slate)
      rev: '#64748b',     // Lane <- (Lighter Slate)
      selFwd: '#0f172a',
      selRev: '#cbd5e1',
      hovFwd: '#475569',
      hovRev: '#cbd5e1',
    },
    {
      name: 'Fuchsia',
      dot: '🟣',
      base: '#c026d3',
      fwd: '#a21caf',     // Lane -> (Intensive Magenta)
      rev: '#e879f9',     // Lane <- (Lighter Orchid)
      selFwd: '#86198f',
      selRev: '#f5d0fe',
      hovFwd: '#d946ef',
      hovRev: '#f5d0fe',
    },
    {
      name: 'Orange',
      dot: '🟠',
      base: '#ea580c',
      fwd: '#c2410c',     // Lane -> (Intensive Burnt Orange)
      rev: '#fb923c',     // Lane <- (Lighter Tangerine)
      selFwd: '#9a3412',
      selRev: '#fed7aa',
      hovFwd: '#f97316',
      hovRev: '#fed7aa',
    }
  ];

  // A colour no other bus is using: the first free palette colour, then evenly spread hues
  B.pickRouteColor = function (usedColors) {
    const used = new Set((usedColors || []).filter(Boolean).map((c) => String(c).toLowerCase()));
    const free = B.ROUTE_PALETTE.find((p) => !used.has(p.base.toLowerCase()));
    if (free) return free.base;
    for (let i = 0; i < 360; i++) {
      const color = `hsl(${Math.round((used.size + i) * 137.5) % 360}, 68%, 40%)`;
      if (!used.has(color)) return color;
    }
    return '#2563eb';
  };

  // A random palette colour no other bus uses (falls back to a fresh hue once the palette is used up)
  B.randomRouteColor = function (usedColors) {
    const used = new Set((usedColors || []).filter(Boolean).map((c) => String(c).toLowerCase()));
    const free = B.ROUTE_PALETTE.filter((p) => !used.has(p.base.toLowerCase()));
    if (free.length) return free[Math.floor(Math.random() * free.length)].base;
    return B.pickRouteColor(usedColors);
  };

  B.getRoutePalette = function (colorOrIndex) {
    if (typeof colorOrIndex === 'number') {
      return B.ROUTE_PALETTE[Math.abs(colorOrIndex) % B.ROUTE_PALETTE.length];
    }
    if (colorOrIndex && typeof colorOrIndex === 'object') {
      if (colorOrIndex.fwd && colorOrIndex.rev) return colorOrIndex;
      return B.getRoutePalette(colorOrIndex.color || colorOrIndex.base || '#2563eb');
    }
    const match = B.ROUTE_PALETTE.find(
      (p) => p.base === colorOrIndex || p.name.toLowerCase() === String(colorOrIndex).toLowerCase()
    );
    if (match) return match;
    return {
      name: '',
      dot: '🔵',
      base: colorOrIndex || '#2563eb',
      fwd: colorOrIndex || '#1d4ed8',
      rev: '#60a5fa',
      selFwd: colorOrIndex || '#1e3a8a',
      selRev: '#93c5fd',
      hovFwd: colorOrIndex || '#2563eb',
      hovRev: '#93c5fd',
    };
  };

  // tiny event bus
  B.events = {
    _h: {},
    on(n, f) { (this._h[n] = this._h[n] || []).push(f); },
    emit(n, d) { (this._h[n] || []).forEach((f) => f(d)); },
  };

  // ---------------------------------------------------------------- operating hours
  // Every bus number runs for one window a day ("HH:MM" – "HH:MM"); an end before the start runs past midnight.
  B.SERVICE_DAYS = [
    ['05:30', '23:30'], ['06:00', '23:00'], ['05:45', '00:30'],
    ['06:30', '22:00'], ['07:00', '20:00'], ['05:15', '01:00'],
  ];

  // A typical service day picked from the bus number, for routes saved before hours existed
  B.defaultBusHours = function (number) {
    let h = 0;
    for (const ch of String(number).trim()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const [start, end] = B.SERVICE_DAYS[h % B.SERVICE_DAYS.length];
    return { start, end };
  };

  // Hours are shared by every route piece with the same bus number
  B.busHours = function (doc, number) {
    const num = String(number).trim();
    for (const r of Object.values((doc && doc.routes) || {})) {
      if (String(r.number).trim() === num && r.hours && r.hours.start && r.hours.end) return r.hours;
    }
    return B.defaultBusHours(num);
  };

  B.timeToMin = function (t) {
    const [h, m] = String(t || '0:0').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };

  // Does a bus's service window overlap the window from–to (both may run past midnight; "to" is inclusive)?
  B.hoursOverlap = function (hours, from, to) {
    const spans = (a, b) => (b > a ? [[a, b]] : [[a, 1440], [0, b]]);
    const service = spans(B.timeToMin(hours.start), B.timeToMin(hours.end));
    const window = spans(B.timeToMin(from), B.timeToMin(to) + 1);
    return service.some(([a, b]) => window.some(([c, d]) => a < d && c < b));
  };

  // ---------------------------------------------------------------- bus models
  B.BUS_MODELS = ['Double-deck', 'Articulated', '3-door'];

  // A model picked from the bus number, for buses saved before models existed (looks random, stays the same)
  B.defaultBusModel = function (number) {
    // FNV-1a with a final mix, so neighbouring numbers spread across the models
    let h = 2166136261;
    for (const ch of String(number).trim()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
    return B.BUS_MODELS[(h >>> 0) % B.BUS_MODELS.length];
  };

  // The model is shared by every route piece with the same bus number
  B.busModel = function (doc, number) {
    const num = String(number).trim();
    for (const r of Object.values((doc && doc.routes) || {})) {
      if (String(r.number).trim() === num && B.BUS_MODELS.includes(r.model)) return r.model;
    }
    return B.defaultBusModel(num);
  };

  // ---------------------------------------------------------------- bus types a stop takes
  // Most stops take every type. About a quarter get one type they can't take (a low bridge or trees keep out
  // double-deckers, a tight bend keeps out articulated buses, a narrow kerb keeps out 3-door buses), unless a bus
  // of that type already stops there, which leaves fewer than one in ten restricted.
  B.defaultStopBlockedType = function (stopId) {
    let h = 2166136261;
    for (const ch of `stop:${stopId}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12;
    return (h % 100) < 75 ? null : B.BUS_MODELS[(h >>> 8) % B.BUS_MODELS.length];
  };

  // Types set on the stop, else the default. A type a bus already uses at the stop stays allowed,
  // so existing routes never break; servingRouteIds are the routes stopping there.
  B.stopBusTypes = function (doc, stopId, servingRouteIds = []) {
    const s = doc && doc.stops && doc.stops[stopId];
    if (s && Array.isArray(s.busTypes) && s.busTypes.length) return B.BUS_MODELS.filter((m) => s.busTypes.includes(m));
    const blocked = B.defaultStopBlockedType(stopId);
    if (!blocked) return B.BUS_MODELS.slice();
    const used = servingRouteIds.some((rid) => doc.routes[rid] && B.busModel(doc, doc.routes[rid].number) === blocked);
    return used ? B.BUS_MODELS.slice() : B.BUS_MODELS.filter((m) => m !== blocked);
  };

  // ---------------------------------------------------------------- operating days
  // Days a bus runs, Monday first (0 = Mon … 6 = Sun), shared by every route piece with the same number
  B.DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  B.DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  B.ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

  // Days picked from the bus number, for buses saved before days existed: most run every day,
  // some skip Sunday, some run on weekdays only, and a few only at weekends
  B.defaultBusDays = function (number) {
    let h = 5381;
    for (const ch of String(number).trim()) h = (Math.imul(h, 33) ^ ch.charCodeAt(0)) >>> 0;
    h ^= h >>> 11; h = Math.imul(h, 0x45d9f3b) >>> 0; h ^= h >>> 16;
    const r = h % 20;
    if (r < 12) return B.ALL_DAYS.slice();
    if (r < 16) return [0, 1, 2, 3, 4, 5];
    if (r < 19) return [0, 1, 2, 3, 4];
    return [5, 6];
  };

  B.busDays = function (doc, number) {
    const num = String(number).trim();
    for (const r of Object.values((doc && doc.routes) || {})) {
      if (String(r.number).trim() === num && Array.isArray(r.days) && r.days.length) {
        return [...new Set(r.days.filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
      }
    }
    return B.defaultBusDays(num);
  };

  // "Every day", "Mon–Fri", "Sat–Sun", or the days listed
  B.daysLabel = function (days) {
    const d = [...new Set(days || [])].sort((a, b) => a - b);
    const short = (i) => B.DAY_NAMES[i].slice(0, 3);
    if (d.length === 7) return 'Every day';
    if (!d.length) return 'No days';
    const run = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
    if (run && d.length > 2) return `${short(d[0])}–${short(d[d.length - 1])}`;
    return d.map(short).join(', ');
  };

  // How many buses run on a bus number, when it's been set (shared by every route piece with the number)
  B.busFleetSet = function (doc, number) {
    const num = String(number).trim();
    for (const r of Object.values((doc && doc.routes) || {})) {
      if (String(r.number).trim() === num && Number.isInteger(r.fleet) && r.fleet > 0) return r.fleet;
    }
    return null;
  };

  // Enough buses for one every 10 minutes: there and back, plus a few minutes' rest at the ends
  B.defaultBusFleet = function (oneWaySeconds) {
    const oneWayMin = (oneWaySeconds || 0) / 60;
    return Math.max(2, Math.ceil((2 * oneWayMin + 8) / 10));
  };

  // A bus can be set not active (suspended); every route piece with the number shares it
  B.busActive = function (doc, number) {
    const num = String(number).trim();
    return !Object.values((doc && doc.routes) || {}).some((r) => String(r.number).trim() === num && r.active === false);
  };

  // Bus numbers in a doc that run at some point between from and to (and on one of these days, if given);
  // a bus that's not active doesn't run at all
  B.runningBusNumbers = function (doc, from, to, days = null) {
    const running = new Set();
    const daySet = days ? new Set(days) : null;
    for (const r of Object.values((doc && doc.routes) || {})) {
      const num = String(r.number).trim();
      if (running.has(num) || !B.busActive(doc, num) || !B.hoursOverlap(B.busHours(doc, num), from, to)) continue;
      if (daySet && !B.busDays(doc, num).some((d) => daySet.has(d))) continue;
      running.add(num);
    }
    return running;
  };
})();
