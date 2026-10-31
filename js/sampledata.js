/* BRASS — sample (fictional) bus network on Singapore's map, at Singapore's scale: 370 bus services
 * with about 6,000 buses and over 5,000 bus stops. Illustrative only — not a live feed.
 * Every service is a loop from a town interchange: round the east, round the west, or across the island
 * from east to west and back. Stops sit along each loop and are shared where loops run together. */
(function () {
  const B = window.B;

  B.abbr = (n) => n.replace(/\bRoad\b/g, 'Rd').replace(/\bAvenue\b/g, 'Ave').replace(/\bBoulevard\b/g, 'Blvd')
    .replace(/\bStreet\b/g, 'St').replace(/\bJalan\b/g, 'Jln').replace(/\bExpressway\b/g, 'Expwy').replace(/\bWay\b/g, 'Way');

  const SERVICES = 370;      // at least this many bus numbers
  const MIN_STOPS = 5000;    // and at least this many stops
  const MIN_FLEET = 6000;    // buses across all services

  // A colour of its own for every service: hues a golden angle apart, light and dark in turn
  const serviceColor = (i) => {
    const hue = (i * 137.508) % 360, sat = 0.62 + (i % 3) * 0.08, lig = 0.36 + (i % 4) * 0.045;
    const f = (n) => {
      const k = (n + hue / 30) % 12, a = sat * Math.min(lig, 1 - lig);
      return Math.round(255 * (lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  };

  B.buildSampleDoc = function (city, net) {
    const rnd = B.rng(4242);
    const { nodes, edges } = city;
    // map: which generated network the stops and roads belong to, so maps from another one are never loaded onto it
    const doc = { map: B.MAP_VERSION, stops: {}, routes: {}, accidents: {}, areas: {}, closures: {}, seq: 1 };

    const landmarks = {
      cbd: [
        'Raffles Pl Stn', 'The Sail', 'Lau Pa Sat', 'One Raffles Quay', 'Customs Hse', 'Marina Bay Stn', 'Downtown Stn',
        'Suntec Twr 3', 'Esplanade Dr', 'Marina Blvd', 'Shenton Way', 'Clifford Pier', 'Central Blvd', 'Marina Bay Sands',
        'Ocean Financial Ctr', 'OUE Bayfront', 'Asia Square', 'Bayfront Ave', 'Straits View', 'Marina View', 'Tanjong Pagar Stn',
        'Maxwell Food Ctr', 'Telok Ayer Stn', 'Capital Twr'
      ],
      mixed: [
        'Orchard Stn', 'Ngee Ann City', 'Plaza Singapura', 'Bugis Junction', 'Kallang Stadium', 'City Hall Stn', 'Clarke Quay',
        'Funan Mall', 'Newton Food Ctr', 'Lavender Stn', 'Somerset Stn', 'Dhoby Ghaut Stn', 'Bencoolen St', 'Bras Basah',
        'Fort Canning', 'National Museum', 'Victoria St', 'Albert Mall', 'Waterloo St', 'Stamford Rd', 'Novena Sq',
        'Paya Lebar Sq', 'Jem', 'Westgate', 'JCube', 'Leisure Park', 'Sports Hub'
      ],
      hdb: [
        'Blk', 'Opp Blk', 'Town Ctr', 'Market & Food Ctr', 'Community Club', 'Polyclinic', 'Sports Complex',
        'Neighbourhood Park', 'Library', 'Green', 'Shopping Ctr', 'Pr Sch', 'Sec Sch', 'Stn', 'Hub'
      ],
      landed: [
        'Opp Sec Sch', 'Aft Pri Sch', 'Opp CC', 'Bef Chapel', 'Community Park', 'Hillview Walk', 'Sunset Way',
        'Greenwood Ave', 'Bef Playground', 'Opp Botanic Gdns', 'Clubhouse', 'Hillcrest Ave', 'Opp Condo', 'Bef Temple'
      ],
      industrial: [
        'Opp Factory', 'Aft Logistics Hub', 'Bef Warehouse', 'Opp Depot', 'Cargo Complex', 'Aviation Park', 'Tech Park',
        'Innovation Hub', 'Freight Terminal', 'Coastal Depot', 'Shipyard Cres', 'Opp Wafer Fab', 'Bef Ind Pk', 'Opp Dormitory'
      ]
    };

    const used = new Set(), codeCount = {};
    const stopName = (pos) => {
      const e = edges[pos.edge];
      const p = B.pointAlong(e.pts, e.cum, pos.s);
      const d = city.districtAt(p);
      const node = nodes[pos.s < e.len / 2 ? e.a : e.b];
      const cross = node.edges.map((id) => edges[id]).find((x) => x && x.name !== e.name);
      let name;
      for (let k = 0; k < 12; k++) {
        const r = rnd();
        if (d.type === 'hdb' && r < 0.6) {
          const pick = rnd.pick(landmarks.hdb);
          name = (pick === 'Blk' || pick === 'Opp Blk') ? pick + ' ' + rnd.int(101, 899) : d.short.split(' ')[0] + ' ' + pick;
        } else if ((d.type === 'cbd' || d.type === 'mixed') && r < 0.55) {
          name = rnd.pick(landmarks[d.type]);
        } else if (r < 0.75 && cross) {
          name = (pos.s < e.len / 2 ? (pos.dir > 0 ? 'Aft ' : 'Bef ') : (pos.dir > 0 ? 'Bef ' : 'Aft ')) + B.abbr(cross.name);
        } else {
          const pick = rnd.pick(landmarks[d.type] || landmarks.mixed);
          name = (d.type === 'hdb' && (pick === 'Blk' || pick === 'Opp Blk')) ? pick + ' ' + rnd.int(101, 899) : pick;
        }
        if (!used.has(name)) break;
        if (k > 5) name = name + ' (' + (pos.dir > 0 ? 'Dir 1' : 'Dir 2') + ')';
      }
      used.add(name);
      codeCount[d.code] = (codeCount[d.code] || 0) + 1;
      const code = d.code + String(codeCount[d.code] % 1000).padStart(3, '0');
      return { name, code };
    };

    // ------------------------------------------------------------------ stops
    // One list of stops per lane (road + direction); a stop within 180 m on the same lane is shared
    const byLane = new Map();
    const stopsList = [];
    const addStop = (edge, s, dir, name) => {
      const key = edge + ':' + dir;
      const lane = byLane.get(key) || [];
      s = net.clampS(edge, s);
      const near = lane.find((st) => Math.abs(st.s - s) < 180);
      if (near) return near;
      const nm = name ? { name, code: stopName({ edge, s, dir }).code } : stopName({ edge, s, dir });
      const id = 'S' + (stopsList.length + 1);
      const st = { id, code: nm.code, name: nm.name, edge, s, dir, kind: 'existing' };
      doc.stops[id] = st;
      stopsList.push(st);
      lane.push(st);
      byLane.set(key, lane);
      return st;
    };

    // ------------------------------------------------------------------ interchanges
    // One per town, on the road nearest its centre
    const landOk = (p) => { const f = city.flagsAt(p); return (f & city.LAND) && !(f & (city.PARK | city.LAKE | city.RIVER)); };
    const posNear = (p, maxD = 900) => {
      const n = net.nearest(p, maxD);
      if (!n) return null;
      const e = edges[n.edge];
      return { edge: n.edge, s: net.clampS(n.edge, n.s), dir: rnd() < 0.5 ? 1 : -1, len: e.len };
    };
    const interchange = new Map();
    for (const d of city.districts) {
      const pos = posNear(d, 1500);
      if (!pos) continue;
      interchange.set(d.id, { town: d, stop: addStop(pos.edge, pos.s, pos.dir, `${d.short} Int`) });
    }
    const mid = B.lonLatToMap(103.835, 1.35).x; // east of this is "east"
    const ints = [...interchange.values()];
    const eastInts = ints.filter((t) => t.town.x > mid);
    const westInts = ints.filter((t) => t.town.x <= mid);

    // ------------------------------------------------------------------ loops
    const posOfStop = (st) => ({ edge: st.edge, s: st.s, dir: st.dir });
    // A point about r from c towards angle a that's on land with a road nearby (drawn in if not)
    const pointNear = (c, a, r) => {
      for (let k = 0; k < 6; k++) {
        const rr = r * (1 - k * 0.15);
        const p = { x: c.x + Math.cos(a) * rr, y: c.y + Math.sin(a) * rr };
        if (landOk(p)) { const pos = posNear(p, 600); if (pos) return pos; }
      }
      return null;
    };
    // The roads of a loop through these positions, back to the first; null if any stretch has no road
    const loopPath = (positions) => {
      const segs = [];
      let length = 0;
      for (let i = 0; i < positions.length; i++) {
        const a = positions[i], b = positions[(i + 1) % positions.length];
        const leg = net.route(a, b, { closed: null });
        if (!leg.ok) return null;
        segs.push(...leg.segs);
        length += leg.length;
      }
      return { segs, length };
    };
    // Stops along a loop's roads every 450-650 m, starting and ending at its interchange
    const stopsAlong = (path, terminal) => {
      const chain = [terminal];
      let acc = 0, next = rnd.range(450, 650);
      for (const sg of path.segs) {
        const span = Math.abs(sg.s1 - sg.s0);
        while (next <= acc + span) {
          const s = sg.s0 + Math.sign(sg.s1 - sg.s0 || 1) * (next - acc);
          const st = addStop(sg.edge, s, sg.dir);
          if (chain[chain.length - 1] !== st && st !== terminal) chain.push(st);
          next += rnd.range(450, 650);
        }
        acc += span;
      }
      chain.push(terminal);
      return chain;
    };

    // Town loop: round the town through 3-4 points; across-island loop: out one way to a far town, back another
    const townLoop = (t) => {
      const c = t.town, r = rnd.range(1200, 3000), rot = rnd() * Math.PI * 2, k = rnd() < 0.5 ? 3 : 4;
      const pts = [posOfStop(t.stop)];
      for (let i = 0; i < k; i++) {
        const p = pointNear(c, rot + (i / k) * Math.PI * 2 + rnd.range(-0.3, 0.3), r * rnd.range(0.75, 1.15));
        if (!p) return null;
        pts.push(p);
      }
      return pts;
    };
    const acrossLoop = (from, to) => {
      const a = from.town, b = to.town;
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
      const off = rnd.range(1500, 3500);
      const m1 = pointNear({ x: (a.x + b.x) / 2 + nx * off, y: (a.y + b.y) / 2 + ny * off }, 0, 0);
      const m2 = pointNear({ x: (a.x + b.x) / 2 - nx * off, y: (a.y + b.y) / 2 - ny * off }, 0, 0);
      if (!m1 || !m2) return null;
      return [posOfStop(from.stop), m1, posOfStop(to.stop), m2];
    };

    // Bus numbers 2-999 in a shuffled order, so every region gets a mix
    const numbers = [];
    for (let n = 2; n <= 999; n++) numbers.push(String(n));
    for (let i = numbers.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [numbers[i], numbers[j]] = [numbers[j], numbers[i]]; }

    const services = [];
    let tries = 0;
    while ((services.length < SERVICES || stopsList.length < MIN_STOPS) && services.length < numbers.length && tries < 4000) {
      tries++;
      // East, west, or across from east to west, picked at random
      const kind = rnd() < 0.2 ? 'across' : (rnd() < 0.5 ? 'east' : 'west');
      let terminal, positions;
      if (kind === 'across') {
        const goEast = rnd() < 0.5;
        const from = rnd.pick(goEast ? westInts : eastInts), to = rnd.pick(goEast ? eastInts : westInts);
        terminal = from; positions = acrossLoop(from, to);
      } else {
        terminal = rnd.pick(kind === 'east' ? eastInts : westInts);
        positions = townLoop(terminal);
      }
      if (!positions) continue;
      const path = loopPath(positions);
      if (!path || path.length < 3000) continue;
      const chain = stopsAlong(path, terminal.stop);
      if (chain.length < 6) continue;
      services.push({ kind, terminal, chain, length: path.length });
    }

    // ------------------------------------------------------------------ routes
    services.forEach((sv, i) => {
      const num = numbers[i];
      const id = 'R' + (i + 1);
      const first = sv.chain[0];
      // Enough buses for one every 6-14 minutes round the loop
      const loopMin = (sv.length / 5.3 + sv.chain.length * 25) / 60;
      const headway = sv.kind === 'across' ? rnd.range(8, 13) : rnd.range(6, 14);
      doc.routes[id] = {
        id,
        number: num,
        name: `Bus ${num} (${first.name} ➔ ${first.name})`,
        color: serviceColor(i),
        kind: 'existing',
        baseId: null,
        override: false,
        hours: B.defaultBusHours(num),
        fleet: Math.max(2, Math.ceil((loopMin + 6) / headway)),
        anchors: sv.chain.map((s) => ({ t: 'stop', id: s.id })),
      };
    });
    // At least 6,000 buses in all: scale every service up evenly when short
    const routes = Object.values(doc.routes);
    const total = routes.reduce((t, r) => t + r.fleet, 0);
    if (total < MIN_FLEET) routes.forEach((r) => { r.fleet = Math.ceil(r.fleet * (MIN_FLEET / total)); });

    doc.seq = stopsList.length + routes.length + 4;
    return doc;
  };

  /**
   * Adds count new bus routes (each a short chain of nearby stops), each with its own number and colour.
   */
  B.generateRandomRoutes = function (city, net, doc, count = 6, specificNumbers = null) {
    const stopsList = Object.values(doc.stops);
    if (!stopsList.length) return [];
    const usedNums = new Set(Object.values(doc.routes).map((r) => String(r.number).trim()));
    const chosen = specificNumbers ? specificNumbers.slice() : [];
    for (let n = 2; chosen.length < count && n < 1000; n++) if (!usedNums.has(String(n)) && !chosen.includes(String(n))) chosen.push(String(n));

    // Nearest stops by straight line first, then by road, up to 10 stops
    const findStopChain = (start, chainLen) => {
      const chain = [start];
      let cur = start;
      for (let step = 0; step < chainLen - 1; step++) {
        const a = net.posPoint(cur, 0.78);
        const near = stopsList
          .filter((c) => !chain.includes(c))
          .map((c) => { const b = net.posPoint(c, 0.78); return { c, d: Math.hypot(a.x - b.x, a.y - b.y) }; })
          .filter((x) => x.d >= 50 && x.d <= 750)
          .sort((x, y) => x.d - y.d)
          .slice(0, 8);
        let best = null;
        for (const { c } of near) {
          const leg = net.route(cur, c, { closed: null });
          if (leg.ok && (!best || leg.length < best.len)) best = { c, len: leg.length };
        }
        if (!best) break;
        chain.push(best.c);
        cur = best.c;
      }
      return chain;
    };

    const created = [];
    for (let i = 0; i < count; i++) {
      let chain = [];
      for (let attempt = 0; attempt < 8 && chain.length < 3; attempt++) {
        chain = findStopChain(stopsList[Math.floor(Math.random() * stopsList.length)], 10);
      }
      if (chain.length < 2) continue;
      const id = 'R' + (Object.keys(doc.routes).length + 1);
      const num = chosen[i] || String(Math.floor(Math.random() * 80 + 20));
      const r = {
        id,
        number: num,
        name: `Bus ${num} (${chain[0].name} ➔ ${chain[chain.length - 1].name})`,
        color: B.pickRouteColor(Object.values(doc.routes).map((x) => x.color)),
        kind: 'existing',
        baseId: null,
        override: false,
        hours: B.defaultBusHours(num),
        anchors: chain.map((s) => ({ t: 'stop', id: s.id })),
      };
      doc.routes[id] = r;
      created.push(r);
    }
    return created;
  };
})();
