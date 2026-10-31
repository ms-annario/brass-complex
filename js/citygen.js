/* BRASS — procedural (deterministic) city on Singapore's map, at full scale (about 50 km × 30 km).
 * The coastline, reservoirs, nature reserves, rivers and towns follow Singapore; the streets are generated. */
(function () {
  const B = window.B;
  const LAND = 1, PARK = 2, LAKE = 4, RIVER = 8;
  B.FLAGS = { LAND, PARK, LAKE, RIVER };

  // Longitude / latitude → metres on the map (west edge 103.60°E, north edge 1.49°N)
  const LON0 = 103.6, LON1 = 104.05, LAT0 = 1.49, LAT1 = 1.22;
  const W = 50000, H = 30000;
  const at = (lon, lat) => ({ x: ((lon - LON0) / (LON1 - LON0)) * W, y: ((LAT0 - lat) / (LAT0 - LAT1)) * H });
  B.lonLatToMap = at;

  B.generateCity = function () {
    const rnd = B.rng(20261029);
    const city = { W, H };

    // ---------------------------------------------------------------- coastline (clockwise from Tuas)
    const ctrl = [
      [103.605, 1.315], [103.62, 1.335], [103.64, 1.35], [103.67, 1.375], [103.69, 1.41], [103.71, 1.435],
      [103.735, 1.445], [103.76, 1.445], [103.785, 1.455], [103.8, 1.46], [103.82, 1.468], [103.84, 1.465],
      [103.86, 1.45], [103.875, 1.435], [103.89, 1.42], [103.905, 1.413], [103.93, 1.398], [103.955, 1.388],
      [103.98, 1.392], [104.0, 1.397], [104.02, 1.383], [104.035, 1.36], [104.03, 1.335], [104.0, 1.32],
      [103.97, 1.31], [103.94, 1.302], [103.91, 1.298], [103.885, 1.293], [103.866, 1.281], [103.855, 1.272],
      [103.84, 1.268], [103.82, 1.265], [103.8, 1.272], [103.78, 1.285], [103.76, 1.293], [103.74, 1.3],
      [103.72, 1.305], [103.7, 1.3], [103.68, 1.295], [103.65, 1.29], [103.625, 1.295], [103.61, 1.3],
    ].map(([lon, lat]) => at(lon, lat));
    const jit = [];
    for (let i = 0; i < ctrl.length; i++) {
      const a = ctrl[i], b = ctrl[(i + 1) % ctrl.length];
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy), nx = dy / l, ny = -dx / l;
      jit.push(a);
      for (const t of [0.34, 0.67]) { const o = (rnd() - 0.5) * Math.min(l, 1600) * 0.12; jit.push({ x: a.x + dx * t + nx * o, y: a.y + dy * t + ny * o }); }
    }
    city.coast = B.chaikin(jit, 2, true);
    const blobAt = (lon, lat, rx, ry, n, noise, rot = 0) => { const p = at(lon, lat); return B.blob(p.x, p.y, rx, ry, n, noise, rnd, rot); };
    city.islets = [
      { name: 'Sentosa', poly: blobAt(103.83, 1.249, 2300, 750, 14, 0.25, -0.12) },
      { name: 'Jurong Island', poly: blobAt(103.69, 1.262, 3600, 1700, 16, 0.3, 0.15) },
      { name: 'Pulau Ubin', poly: blobAt(103.962, 1.414, 3400, 750, 14, 0.35, -0.08) },
      { name: 'Pulau Tekong', poly: blobAt(104.045, 1.418, 1500, 1300, 14, 0.3) },
    ];

    // --------------------------------------------------------------- green / blue
    const parks = [
      { name: 'Central Catchment Nature Reserve', kind: 'reserve', poly: blobAt(103.808, 1.378, 3300, 2700, 18, 0.25, 0.3) },
      { name: 'Bukit Timah Nature Reserve', kind: 'reserve', poly: blobAt(103.776, 1.352, 850, 750, 12, 0.3) },
      { name: 'Mandai Forest', kind: 'reserve', poly: blobAt(103.79, 1.408, 1000, 700, 12, 0.3) },
      { name: 'Sungei Buloh Wetland', kind: 'reserve', poly: blobAt(103.728, 1.442, 900, 450, 12, 0.3) },
      { name: 'Singapore Botanic Gardens', kind: 'garden', poly: blobAt(103.815, 1.315, 480, 700, 12, 0.25, 0.2) },
      { name: 'Gardens by the Bay', kind: 'garden', poly: blobAt(103.866, 1.283, 600, 330, 12, 0.25, 0.4) },
      { name: 'Jurong Lake Gardens', kind: 'garden', poly: blobAt(103.728, 1.338, 750, 520, 12, 0.25) },
      { name: 'Bedok Reservoir Park', kind: 'garden', poly: blobAt(103.93, 1.342, 700, 420, 12, 0.25, 0.2) },
      { name: 'Pasir Ris Park', kind: 'garden', poly: blobAt(103.952, 1.382, 900, 280, 12, 0.25, -0.2) },
      { name: 'East Coast Park', kind: 'garden', poly: blobAt(103.925, 1.301, 2600, 170, 14, 0.2, -0.08) },
      { name: 'West Coast Park', kind: 'garden', poly: blobAt(103.765, 1.293, 520, 240, 12, 0.25, -0.3) },
      { name: 'Punggol Waterway Park', kind: 'garden', poly: blobAt(103.905, 1.41, 1000, 230, 12, 0.25, -0.25) },
      { name: 'Bishan-Ang Mo Kio Park', kind: 'garden', poly: blobAt(103.843, 1.362, 700, 220, 12, 0.25, 0.5) },
    ];
    const lakes = [
      { name: 'MacRitchie Reservoir', poly: blobAt(103.828, 1.343, 900, 420, 14, 0.35, 0.2) },
      { name: 'Upper Peirce Reservoir', poly: blobAt(103.805, 1.372, 700, 480, 14, 0.35, 0.6) },
      { name: 'Lower Peirce Reservoir', poly: blobAt(103.826, 1.372, 300, 440, 12, 0.35) },
      { name: 'Upper Seletar Reservoir', poly: blobAt(103.8, 1.398, 1200, 480, 14, 0.35, -0.2) },
      { name: 'Lower Seletar Reservoir', poly: blobAt(103.842, 1.41, 650, 320, 12, 0.35, 0.3) },
      { name: 'Kranji Reservoir', poly: blobAt(103.735, 1.432, 1500, 480, 14, 0.35, -0.15) },
      { name: 'Jurong Lake', poly: blobAt(103.728, 1.338, 430, 240, 12, 0.35, 0.4) },
      { name: 'Bedok Reservoir', poly: blobAt(103.93, 1.342, 400, 220, 12, 0.35, 0.2) },
      { name: 'Pandan Reservoir', poly: blobAt(103.745, 1.312, 700, 300, 12, 0.35, 0.1) },
      { name: 'Tengeh Reservoir', poly: blobAt(103.66, 1.34, 900, 480, 14, 0.35, 0.5) },
      { name: 'Marina Reservoir', poly: blobAt(103.858, 1.285, 560, 280, 12, 0.3, 0.3) },
    ];
    const line = (pts) => B.chaikin(pts.map(([lon, lat]) => at(lon, lat)), 3, false);
    const rivers = [
      { name: 'Singapore River', hw: 30, pts: line([[103.834, 1.294], [103.84, 1.291], [103.846, 1.289], [103.853, 1.287]]) },
      { name: 'Kallang River', hw: 25, pts: line([[103.858, 1.342], [103.861, 1.328], [103.865, 1.313], [103.868, 1.299]]) },
      { name: 'Geylang River', hw: 18, pts: line([[103.896, 1.331], [103.887, 1.315], [103.876, 1.302]]) },
      { name: 'Jurong River', hw: 22, pts: line([[103.724, 1.352], [103.72, 1.332], [103.712, 1.31]]) },
    ];
    city.parks = parks; city.lakes = lakes; city.rivers = rivers;

    // ------------------------------------------------------------ raster mask (20 m)
    const C = 20, MW = Math.ceil(W / C), MH = Math.ceil(H / C);
    const mask = new Uint8Array(MW * MH);
    function raster(poly, flag) {
      const bb = B.bbox(poly);
      const r0 = Math.max(0, Math.floor(bb.y0 / C)), r1 = Math.min(MH - 1, Math.ceil(bb.y1 / C));
      for (let r = r0; r <= r1; r++) {
        const y = (r + 0.5) * C, xs = [];
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const a = poly[i], b = poly[j];
          if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const c0 = Math.max(0, Math.ceil(xs[k] / C - 0.5)), c1 = Math.min(MW - 1, Math.floor(xs[k + 1] / C - 0.5));
          for (let c = c0; c <= c1; c++) mask[r * MW + c] |= flag;
        }
      }
    }
    function rasterLine(pts, hw, flag) {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - hw) / C)), x1 = Math.min(MW - 1, Math.ceil((Math.max(a.x, b.x) + hw) / C));
        const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - hw) / C)), y1 = Math.min(MH - 1, Math.ceil((Math.max(a.y, b.y) + hw) / C));
        for (let r = y0; r <= y1; r++) for (let c = x0; c <= x1; c++)
          if (B.distSeg({ x: (c + 0.5) * C, y: (r + 0.5) * C }, a, b) <= hw) mask[r * MW + c] |= flag;
      }
    }
    raster(city.coast, LAND);
    parks.forEach((p) => raster(p.poly, PARK));
    lakes.forEach((l) => raster(l.poly, LAKE));
    rivers.forEach((r) => rasterLine(r.pts, r.hw, RIVER));
    const flagsAt = (p) => {
      const c = Math.floor(p.x / C), r = Math.floor(p.y / C);
      if (c < 0 || r < 0 || c >= MW || r >= MH) return 0;
      return mask[r * MW + c];
    };
    city.flagsAt = flagsAt;
    city.mask = { data: mask, C, MW, MH };

    // ------------------------------------------------------------------- towns (planning areas)
    // short: the name its streets carry; code: the first two digits of its bus stop codes
    const districts = [
      ['downtown', 'Downtown Core', 'Downtown', 103.853, 1.283, 'cbd', '01'],
      ['tpagar', 'Tanjong Pagar', 'Tanjong Pagar', 103.843, 1.276, 'cbd', '07'],
      ['orchard', 'Orchard', 'Orchard', 103.832, 1.304, 'mixed', '09'],
      ['novena', 'Novena', 'Novena', 103.843, 1.322, 'mixed', '30'],
      ['kallang', 'Kallang', 'Kallang', 103.868, 1.311, 'mixed', '80'],
      ['geylang', 'Geylang', 'Geylang', 103.887, 1.318, 'mixed', '81'],
      ['marine', 'Marine Parade', 'Marine Parade', 103.905, 1.302, 'hdb', '92'],
      ['bedok', 'Bedok', 'Bedok North', 103.93, 1.326, 'hdb', '84'],
      ['tampines', 'Tampines', 'Tampines', 103.945, 1.353, 'hdb', '75'],
      ['pasirris', 'Pasir Ris', 'Pasir Ris', 103.95, 1.373, 'hdb', '77'],
      ['changi', 'Changi', 'Changi', 103.99, 1.358, 'industrial', '96'],
      ['loyang', 'Loyang', 'Loyang', 103.975, 1.372, 'industrial', '97'],
      ['payalebar', 'Paya Lebar', 'Paya Lebar', 103.893, 1.341, 'mixed', '82'],
      ['hougang', 'Hougang', 'Hougang', 103.887, 1.371, 'hdb', '63'],
      ['sengkang', 'Sengkang', 'Sengkang', 103.895, 1.392, 'hdb', '67'],
      ['punggol', 'Punggol', 'Punggol', 103.905, 1.405, 'hdb', '65'],
      ['serangoon', 'Serangoon', 'Serangoon', 103.872, 1.352, 'hdb', '62'],
      ['amk', 'Ang Mo Kio', 'Ang Mo Kio', 103.847, 1.37, 'hdb', '54'],
      ['bishan', 'Bishan', 'Bishan', 103.849, 1.351, 'hdb', '53'],
      ['toapayoh', 'Toa Payoh', 'Toa Payoh', 103.85, 1.334, 'hdb', '52'],
      ['thomson', 'Thomson', 'Thomson', 103.828, 1.348, 'landed', '57'],
      ['yishun', 'Yishun', 'Yishun', 103.835, 1.429, 'hdb', '59'],
      ['sembawang', 'Sembawang', 'Sembawang', 103.82, 1.449, 'hdb', '58'],
      ['woodlands', 'Woodlands', 'Woodlands', 103.786, 1.437, 'hdb', '46'],
      ['seletar', 'Seletar', 'Seletar', 103.868, 1.414, 'industrial', '68'],
      ['kranji', 'Kranji', 'Kranji', 103.757, 1.425, 'industrial', '45'],
      ['limchukang', 'Lim Chu Kang', 'Lim Chu Kang', 103.71, 1.415, 'landed', '47'],
      ['bukitpanjang', 'Bukit Panjang', 'Bukit Panjang', 103.772, 1.378, 'hdb', '44'],
      ['cck', 'Choa Chu Kang', 'Choa Chu Kang', 103.745, 1.385, 'hdb', '43'],
      ['tengah', 'Tengah', 'Tengah', 103.727, 1.365, 'hdb', '42'],
      ['bukitbatok', 'Bukit Batok', 'Bukit Batok', 103.749, 1.356, 'hdb', '28'],
      ['bukittimah', 'Bukit Timah', 'Bukit Timah', 103.79, 1.33, 'landed', '41'],
      ['holland', 'Holland Village', 'Holland', 103.795, 1.312, 'landed', '11'],
      ['tanglin', 'Tanglin', 'Tanglin', 103.815, 1.31, 'landed', '13'],
      ['queenstown', 'Queenstown', 'Queenstown', 103.796, 1.295, 'hdb', '10'],
      ['bukitmerah', 'Bukit Merah', 'Bukit Merah', 103.821, 1.28, 'hdb', '14'],
      ['pasirpanjang', 'Pasir Panjang', 'Pasir Panjang', 103.777, 1.287, 'industrial', '15'],
      ['clementi', 'Clementi', 'Clementi', 103.765, 1.315, 'hdb', '17'],
      ['jurongeast', 'Jurong East', 'Jurong East', 103.742, 1.333, 'mixed', '27'],
      ['jurongwest', 'Jurong West', 'Jurong West', 103.705, 1.345, 'hdb', '22'],
      ['pioneer', 'Pioneer', 'Pioneer', 103.685, 1.318, 'industrial', '21'],
      ['tuas', 'Tuas', 'Tuas', 103.64, 1.32, 'industrial', '24'],
    ].map(([id, name, short, lon, lat, type, code]) => ({ id, name, short, type, code, ...at(lon, lat) }));
    const districtAt = (p) => {
      let best = null, bd = Infinity;
      for (const d of districts) { const dd = B.dist2(p, d); if (dd < bd) { bd = dd; best = d; } }
      return best;
    };
    city.districts = districts; city.districtAt = districtAt;

    // ---------------------------------------------------------------- road network
    // Roads are laid on a jittered grid in "base space", then passed through a smooth
    // warp so that every street bends gently while junctions stay connected.
    const warp = (x, y) => ({
      x: x + 70 * Math.sin(y / 690 + 1.3) + 38 * Math.sin((x + y) / 520 + 0.7) + 160 * Math.sin(y / 4100 + 0.2),
      y: y + 62 * Math.sin(x / 810 + 0.4) + 34 * Math.sin((x - y) / 430 + 2.1) + 140 * Math.sin(x / 5300 + 1.1),
    });
    const S = 300, X0 = 150, Y0 = 150, NX = Math.ceil((W - 300) / S), NY = Math.ceil((H - 300) / S);
    const isMajorRow = (j) => j % 5 === 2, isMajorCol = (i) => i % 5 === 2;
    // Arterials, north to south and west to east; streets in between take their town's name
    const rowNames = ['Admiralty Road', 'Woodlands Avenue 12', 'Sembawang Road', 'Yishun Avenue 2', 'Seletar Expressway',
      'Yio Chu Kang Road', 'Ang Mo Kio Avenue 3', 'Lorong Chuan', 'Braddell Road', 'Pan Island Expressway', 'Bukit Timah Road',
      'Lornie Road', 'Balestier Road', 'Orchard Road', 'Havelock Road', 'Commonwealth Avenue', 'Ayer Rajah Expressway',
      'East Coast Parkway', 'Keppel Road', 'Marina Coastal Drive'];
    const colNames = ['Tuas West Road', 'Tuas Avenue 1', 'Pioneer Road', 'Benoi Road', 'Jalan Ahmad Ibrahim', 'Boon Lay Way',
      'Jurong West Avenue 1', 'Jurong Town Hall Road', 'Bukit Batok Road', 'Jurong East Street 13', 'Choa Chu Kang Avenue 1',
      'Bukit Panjang Road', 'Upper Bukit Timah Road', 'Clementi Road', 'Dunearn Road', 'Holland Road', 'Upper Thomson Road',
      'Stevens Road', 'Bishan Road', 'Lorong 1 Toa Payoh', 'Serangoon Road', 'Upper Paya Lebar Road', 'Hougang Avenue 3',
      'Sengkang East Way', 'Punggol Road', 'Tampines Avenue 10', 'Bedok North Road', 'Tampines Road', 'Pasir Ris Drive 1',
      'Loyang Avenue', 'Changi Road', 'Upper Changi Road', 'Airport Boulevard', 'Changi Coast Road'];
    const streetName = (i, j, horizontal) => {
      const b = warp(X0 + i * S, Y0 + j * S);
      const d = districtAt(b);
      return horizontal ? `${d.short} Street ${11 + (j % 9) * 10 + (Math.floor(i / 9) % 9)}` : `${d.short} Avenue ${1 + (i % 9)}`;
    };
    const base = [];
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const jx = isMajorCol(i) ? 0 : (rnd() - 0.5) * 60, jy = isMajorRow(j) ? 0 : (rnd() - 0.5) * 60;
      base[j * NX + i] = { bx: X0 + i * S + jx, by: Y0 + j * S + jy };
    }
    const riverClear = (p, extra) => rivers.every((r) => B.distPolyline(p, r.pts) > r.hw + extra);
    const landClear = (p, r) => {
      for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; if (!(flagsAt({ x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r }) & LAND)) return false; }
      return true;
    };
    const gridNode = new Map();
    const nodes = [], edges = [];
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const b = base[j * NX + i], p = warp(b.bx, b.by), f = flagsAt(p);
      if (!(f & LAND) || f & (PARK | LAKE | RIVER)) continue;
      if (!landClear(p, 60) || !riverClear(p, 24)) continue;
      const parkNear = [0, 1, 2, 3].some((k) => { const a = k * Math.PI / 2; return flagsAt({ x: p.x + Math.cos(a) * 26, y: p.y + Math.sin(a) * 26 }) & (PARK | LAKE); });
      if (parkNear) continue;
      const n = { id: nodes.length, x: p.x, y: p.y, edges: [], gi: i, gj: j };
      nodes.push(n); gridNode.set(j * NX + i, n.id);
    }
    const diagCells = new Set();
    const cand = [];
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      if (i < NX - 1) cand.push({ i0: i, j0: j, i1: i + 1, j1: j, cls: isMajorRow(j) ? 'major' : 'minor', name: isMajorRow(j) ? rowNames[Math.floor(j / 5) % rowNames.length] : streetName(i, j, true) });
      if (j < NY - 1) cand.push({ i0: i, j0: j, i1: i, j1: j + 1, cls: isMajorCol(i) ? 'major' : 'minor', name: isMajorCol(i) ? colNames[Math.floor(i / 5) % colNames.length] : streetName(i, j, false) });
    }
    // Diagonal trunk roads across the grid
    const diagonal = (name, i0, j0, di, dj, n) => {
      for (let k = 0; k < n; k++) {
        const i = i0 + di * k, j = j0 + dj * k;
        cand.push({ i0: i, j0: j, i1: i + di, j1: j + dj, cls: 'major', name, diag: true });
        diagCells.add(Math.min(i, i + di) + ',' + Math.min(j, j + dj));
      }
    };
    const cell = (lon, lat) => { const p = at(lon, lat); return [Math.round((p.x - X0) / S), Math.round((p.y - Y0) / S)]; };
    { const [i, j] = cell(103.84, 1.302); diagonal('Bukit Timah Road', i, j, -1, -1, 24); }
    { const [i, j] = cell(103.875, 1.315); diagonal('Tampines Expressway', i, j, 1, -1, 30); }
    { const [i, j] = cell(103.755, 1.33); diagonal('Jurong Pier Road', i, j, -1, 1, 6); }

    const keepBridge = () => rnd() < 0.5;
    for (const c of cand) {
      const na = gridNode.get(c.j0 * NX + c.i0), nb = gridNode.get(c.j1 * NX + c.i1);
      if (na === undefined || nb === undefined) continue;
      const ba = base[c.j0 * NX + c.i0], bb = base[c.j1 * NX + c.i1];
      const L = Math.hypot(bb.bx - ba.bx, bb.by - ba.by), n = Math.max(4, Math.ceil(L / 18));
      const pts = []; let ok = true, bridge = false;
      for (let k = 0; k <= n; k++) {
        const t = k / n, p = warp(ba.bx + (bb.bx - ba.bx) * t, ba.by + (bb.by - ba.by) * t), f = flagsAt(p);
        if (!(f & LAND) || f & (PARK | LAKE)) { ok = false; break; }
        if (f & RIVER) bridge = true;
        if (k % 2 === 0 && !landClear(p, 32)) { ok = false; break; }
        pts.push(p);
      }
      if (!ok) continue;
      if (bridge && c.cls !== 'major' && !keepBridge()) continue;
      const e = { id: edges.length, a: na, b: nb, pts, cls: c.cls, name: c.name, bridge, diag: !!c.diag };
      edges.push(e); nodes[na].edges.push(e.id); nodes[nb].edges.push(e.id);
    }

    // Remove a few minor links for more organic block shapes, never disconnecting the graph.
    const alive = edges.map(() => true);
    const reach = (s, t) => {
      const seen = new Uint8Array(nodes.length), st = [s]; seen[s] = 1;
      while (st.length) { const n = st.shift(); if (n === t) return true; for (const eid of nodes[n].edges) { if (!alive[eid]) continue; const e = edges[eid]; const o = e.a === n ? e.b : e.a; if (!seen[o]) { seen[o] = 1; st.push(o); } } if (st.length > 400) return true; }
      return false;
    };
    const deg = (n) => nodes[n].edges.filter((id) => alive[id]).length;
    for (const e of edges) {
      if (e.cls !== 'minor' || e.diag || rnd() > 0.17) continue;
      if (deg(e.a) <= 2 || deg(e.b) <= 2) continue;
      alive[e.id] = false;
      if (!reach(e.a, e.b)) alive[e.id] = true;
    }
    nodes.forEach((n) => (n.edges = n.edges.filter((id) => alive[id])));
    // largest component
    const comp = new Int32Array(nodes.length).fill(-1); let bestC = -1, bestN = 0, cid = 0;
    for (const n of nodes) {
      if (comp[n.id] >= 0 || !n.edges.length) continue;
      let cnt = 0; const st = [n.id]; comp[n.id] = cid;
      while (st.length) { const x = st.pop(); cnt++; for (const eid of nodes[x].edges) { const e = edges[eid]; const o = e.a === x ? e.b : e.a; if (comp[o] < 0) { comp[o] = cid; st.push(o); } } }
      if (cnt > bestN) { bestN = cnt; bestC = cid; } cid++;
    }
    const nodeAlive = nodes.map((n) => comp[n.id] === bestC);
    edges.forEach((e) => { if (!nodeAlive[e.a]) alive[e.id] = false; });
    nodes.forEach((n) => { if (!nodeAlive[n.id]) n.edges = []; });

    // Merge pass-through nodes on the same named street → one segment per junction-to-junction.
    let merged = true;
    while (merged) {
      merged = false;
      for (const n of nodes) {
        if (!nodeAlive[n.id] || n.edges.length !== 2) continue;
        const e1 = edges[n.edges[0]], e2 = edges[n.edges[1]];
        if (e1 === e2 || e1.name !== e2.name || e1.cls !== e2.cls) continue;
        const p1 = e1.b === n.id ? e1.pts : e1.pts.slice().reverse(), s = e1.b === n.id ? e1.a : e1.b;
        const p2 = e2.a === n.id ? e2.pts : e2.pts.slice().reverse(), t = e2.a === n.id ? e2.b : e2.a;
        if (s === t) continue;
        e1.pts = p1.concat(p2.slice(1)); e1.a = s; e1.b = t; e1.bridge = e1.bridge || e2.bridge;
        nodes[t].edges = nodes[t].edges.map((x) => (x === e2.id ? e1.id : x));
        alive[e2.id] = false; nodeAlive[n.id] = false; n.edges = []; merged = true;
      }
    }
    // compact
    const nMap = new Map(), fNodes = [], fEdges = [];
    nodes.forEach((n) => { if (nodeAlive[n.id] && n.edges.length) { nMap.set(n.id, fNodes.length); fNodes.push({ id: fNodes.length, x: n.x, y: n.y, edges: [], gi: n.gi, gj: n.gj }); } });
    edges.forEach((e) => {
      if (!alive[e.id] || !nMap.has(e.a) || !nMap.has(e.b)) return;
      const ne = { id: fEdges.length, a: nMap.get(e.a), b: nMap.get(e.b), pts: e.pts, cls: e.cls, name: e.name, bridge: e.bridge, diag: e.diag };
      ne.hw = ne.cls === 'major' ? 9 : 6.5;
      ne.cum = B.cumLengths(ne.pts); ne.len = ne.cum[ne.cum.length - 1];
      ne.bb = B.bbox(ne.pts, ne.hw + 4);
      const p = ne.pts, n = p.length;
      ne.angA = Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x);
      ne.angB = Math.atan2(p[n - 1].y - p[n - 2].y, p[n - 1].x - p[n - 2].x);
      // A few points for drawing the whole island at once
      ne.lod = p.filter((q, k) => k === 0 || k === n - 1 || k % 6 === 0);
      fEdges.push(ne); fNodes[ne.a].edges.push(ne.id); fNodes[ne.b].edges.push(ne.id);
    });
    fNodes.forEach((n) => { n.maxHw = Math.max(...n.edges.map((id) => fEdges[id].hw)); });
    city.nodes = fNodes; city.edges = fEdges;

    // road segment hash
    const segHash = new B.SpatialHash(80);
    for (const e of fEdges) for (let i = 0; i < e.pts.length - 1; i++) {
      const a = e.pts[i], b = e.pts[i + 1];
      segHash.insert({ e: e.id, i, a, b, hw: e.hw }, B.bbox([a, b], e.hw));
    }
    city.segHash = segHash;

    // ----------------------------------------------------------- block parks
    const finalGrid = new Map(); fNodes.forEach((n) => finalGrid.set(n.gj * NX + n.gi, n));
    const parkNames = ['Kemuning Park', 'Melati Green', 'Cendana Park', 'Tembusu Green', 'Saga Park', 'Angsana Park', 'Pelangi Park', 'Rambutan Green', 'Merbau Park', 'Jati Park', 'Bunga Raya Park'];
    const picked = [];
    for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) {
      if (picked.length >= 60 || rnd() > 0.04 || diagCells.has(i + ',' + j)) continue;
      if (![[0, 0], [1, 0], [0, 1], [1, 1]].every(([a, b]) => finalGrid.has((j + b) * NX + i + a))) continue;
      const b00 = base[j * NX + i], b11 = base[(j + 1) * NX + i + 1];
      const cx = (b00.bx + b11.bx) / 2, cy = (b00.by + b11.by) / 2, wc = warp(cx, cy);
      const d = districtAt(wc); if (d.type === 'cbd' || d.type === 'industrial') continue;
      if (picked.some((q) => B.dist(q, wc) < 1800)) continue;
      const ins = 24, x0 = b00.bx + ins, x1 = b11.bx - ins, y0 = b00.by + ins, y1 = b11.by - ins, ring = [];
      for (let k = 0; k < 6; k++) ring.push(warp(x0 + (x1 - x0) * k / 6, y0));
      for (let k = 0; k < 6; k++) ring.push(warp(x1, y0 + (y1 - y0) * k / 6));
      for (let k = 0; k < 6; k++) ring.push(warp(x1 - (x1 - x0) * k / 6, y1));
      for (let k = 0; k < 6; k++) ring.push(warp(x0, y1 - (y1 - y0) * k / 6));
      if (!ring.every((p) => (flagsAt(p) & LAND) && !(flagsAt(p) & (PARK | LAKE | RIVER)))) continue;
      // ensure no road crosses
      const bb = B.bbox(ring);
      let crossed = false;
      for (const s of segHash.query(bb)) if (B.segPolyDist(s.a, s.b, ring) < s.hw + 4) { crossed = true; break; }
      if (crossed) continue;
      picked.push(wc);
      const pk = { name: `${d.short} ${parkNames[picked.length % parkNames.length]}`, kind: 'block', poly: ring };
      parks.push(pk); raster(ring, PARK);
    }

    // ----------------------------------------------------------------- trees (optimized for 60fps)
    const trees = [];
    for (const pk of parks) {
      const bb = B.bbox(pk.poly), step = pk.kind === 'reserve' ? 70 : 56;
      for (let y = bb.y0; y < bb.y1; y += step) for (let x = bb.x0; x < bb.x1; x += step) {
        const p = { x: x + (rnd() - 0.5) * step * 0.7, y: y + (rnd() - 0.5) * step * 0.7 };
        if (!B.pointInPoly(p, pk.poly)) continue;
        const f = flagsAt(p); if (f & (LAKE | RIVER)) continue;
        if (rnd() < 0.4) continue;
        trees.push({ x: p.x, y: p.y, r: pk.kind === 'reserve' ? 8 + rnd() * 4 : 6 + rnd() * 3, t: rnd() < 0.5 ? 0 : 1 });
      }
    }
    city.trees = trees;
    city.parkPaths = parks.filter((pk) => pk.kind !== 'block').map((pk) => {
      const bb = B.bbox(pk.poly);
      return B.blob((bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2, (bb.x1 - bb.x0) * 0.3, (bb.y1 - bb.y0) * 0.3, 10, 0.15, rnd);
    });

    // --------------------------------------------------------------- buildings (lightweight, stylized blocks)
    // Built only for the streets on screen once zoomed in (the whole island has too many to build at once);
    // each street's blocks come from its own seed, so they look the same whenever they're built.
    const BT = {
      cbd: { w: [32, 64], d: [28, 48], set: [5, 8], gap: [14, 24], rows: 1, h: [70, 230] },
      mixed: { w: [24, 44], d: [18, 34], set: [5, 9], gap: [12, 22], rows: 1, h: [15, 70] },
      hdb: { w: [48, 72], d: [16, 20], set: [10, 16], gap: [24, 38], rows: 1, h: [30, 55], perp: 0.35 },
      landed: { w: [14, 20], d: [16, 22], set: [5, 8], gap: [8, 14], rows: 1, h: [7, 10] },
      industrial: { w: [48, 92], d: [36, 64], set: [10, 16], gap: [16, 28], rows: 1, h: [10, 22] },
    };
    const bHash = new B.SpatialHash(60);
    const buildings = [];
    const buildingBatches = [[], [], [], []];
    const canPlace = (poly, cx, cy) => {
      const chk = poly.map((p) => ({ x: cx + (p.x - cx) * 1.25, y: cy + (p.y - cy) * 1.25 }));
      chk.push({ x: cx, y: cy });
      for (let i = 0; i < 4; i++) chk.push({ x: (poly[i].x + poly[(i + 1) % 4].x) / 2, y: (poly[i].y + poly[(i + 1) % 4].y) / 2 });
      for (const p of chk) { const f = flagsAt(p); if (!(f & LAND) || f & (PARK | LAKE | RIVER)) return false; }
      const bb = B.bbox(poly);
      for (const s of segHash.query({ x0: bb.x0 - 24, y0: bb.y0 - 24, x1: bb.x1 + 24, y1: bb.y1 + 24 }))
        if (B.segPolyDist(s.a, s.b, poly) < s.hw + 4) return false;
      for (const o of bHash.query({ x0: bb.x0 - 1.5, y0: bb.y0 - 1.5, x1: bb.x1 + 1.5, y1: bb.y1 + 1.5 }))
        if (B.bboxOverlap(o.bb, bb) && B.convexOverlap(poly, o.poly)) return false;
      return true;
    };
    const buildStreet = (e) => {
      e.built = true;
      const brnd = B.rng(900001 + e.id * 7919);
      const da = fNodes[e.a].edges.length, db = fNodes[e.b].edges.length;
      const c0 = da >= 3 ? 14 : 6, c1 = db >= 3 ? 14 : 6;
      for (const side of [1, -1]) {
        let s = c0;
        while (s < e.len - c1) {
          const m0 = B.pointAlong(e.pts, e.cum, s);
          const T = BT[districtAt(m0).type];
          const w = brnd.range(T.w[0], T.w[1]), d = brnd.range(T.d[0], T.d[1]);
          const perp = T.perp && brnd() < T.perp;
          const along = perp ? d : w, depth = perp ? w : d;
          if (s + along > e.len - c1) break;
          const m = B.pointAlong(e.pts, e.cum, s + along / 2);
          const nx = Math.sin(m.ang), ny = -Math.cos(m.ang);
          const off = e.hw + 3.5 + brnd.range(T.set[0], T.set[1]) + depth / 2;
          const cx = m.x + nx * side * off, cy = m.y + ny * side * off;
          const poly = B.rectPoly(cx, cy, along, depth, m.ang);
          if (canPlace(poly, cx, cy)) {
            const b = { poly, cx, cy, bb: B.bbox(poly), h: brnd.range(T.h[0], T.h[1]), shade: Math.floor(brnd() * 4), w: along, d: depth, ang: m.ang };
            buildings.push(b); bHash.insert(b, b.bb); buildingBatches[b.shade].push(b);
            s += along + brnd.range(T.gap[0], T.gap[1]);
          } else s += 7;
        }
      }
    };
    city.buildings = buildings; city.bHash = bHash; city.buildingBatches = buildingBatches;
    // Builds the blocks along every street in view not built yet; true when it added any
    city.ensureBuildings = (vp) => {
      let added = false;
      for (const e of fEdges) {
        if (e.built || !B.bboxOverlap(vp, e.bb)) continue;
        buildStreet(e);
        added = true;
      }
      return added;
    };

    // ------------------------------------------------- lane markings & crossings
    // Markings are worked out the first time a street is drawn close up
    city.markStreet = (e) => {
      if (e.marked) return;
      e.marked = true;
      const ta = fNodes[e.a].edges.length >= 3 ? fNodes[e.a].maxHw + 5 : 0;
      const tb = fNodes[e.b].edges.length >= 3 ? fNodes[e.b].maxHw + 5 : 0;
      if (e.len > ta + tb + 12) {
        e.markPts = B.slicePolyline(e.pts, e.cum, ta, e.len - tb);
        // Double continuous divider lines separating the 2 lanes
        e.markPtsA = B.offsetPolyline(e.markPts, 0.95);
        e.markPtsB = B.offsetPolyline(e.markPts, -0.95);
        // Directional flow arrows for each lane (keep-left traffic rule)
        e.laneArrows = [];
        for (let s = ta + 25; s <= e.len - tb - 25; s += 70) {
          const pt = B.pointAlong(e.pts, e.cum, s);
          const ox = Math.sin(pt.ang) * e.hw * 0.45, oy = Math.cos(pt.ang) * e.hw * 0.45;
          e.laneArrows.push({ x: pt.x + ox, y: pt.y - oy, ang: pt.ang, dir: 1 });
          e.laneArrows.push({ x: pt.x - ox, y: pt.y + oy, ang: pt.ang + Math.PI, dir: -1 });
        }
      } else {
        e.markPts = null;
        e.markPtsA = null;
        e.markPtsB = null;
        e.laneArrows = null;
      }
    };
    const crossings = [];
    for (const n of fNodes) {
      if (n.edges.length < 3) continue;
      const hasMajor = n.edges.some((id) => fEdges[id].cls === 'major');
      if (!hasMajor && rnd() > 0.4) continue;
      for (const id of n.edges) {
        const e = fEdges[id]; if (e.len < 50) continue;
        const d = n.maxHw + 1.2, s = e.a === n.id ? d : e.len - d;
        const p = B.pointAlong(e.pts, e.cum, s);
        crossings.push({ x: p.x, y: p.y, ang: p.ang, w: e.hw * 2 });
      }
    }
    city.crossings = crossings;

    // ----------------------------------------------------------------- labels
    city.placeLabels = districts.map((d) => ({ name: d.name, x: d.x, y: d.y }));
    city.waterLabels = [];

    // City boundary (planning limit) – coast offset inland.
    const ring = city.coast.concat([city.coast[0]]);
    const o1 = B.offsetPolyline(ring, 45), o2 = B.offsetPolyline(ring, -45);
    city.boundary = B.polyArea(o1) < B.polyArea(o2) ? o1 : o2;
    city.bounds = B.bbox(city.coast);

    city.LAND = LAND; city.PARK = PARK; city.LAKE = LAKE; city.RIVER = RIVER;
    return city;
  };
})();
