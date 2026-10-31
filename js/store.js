/* BRASS — editable document, history (undo/redo), save/reset and derived geometry.
 * Road geometry is immutable city data; the document only stores editable objects:
 * stops, routes (anchors), accidents, affected areas and road closures — each separately.
 */
(function () {
  const B = window.B;
  const SPEED_MS = 5.3;   // ≈19 km/h average bus running speed (illustrative)
  const DWELL_S = 25;     // per-stop dwell (illustrative)

  B.Store = class {
    constructor(city, net, sampleDoc) {
      this.city = city; this.net = net;
      this.KEY = 'brass.doc.' + B.MAP_VERSION;
      this.sample = JSON.stringify(sampleDoc);
      let saved = null;
      try { saved = localStorage.getItem(this.KEY); } catch (e) { /* storage unavailable */ }
      if (saved && !this._validDoc(saved)) saved = null;
      this.saved = saved || this.sample;
      this.doc = JSON.parse(this.saved);

      // Ensure 3 more active bus routes exist (total at least 6 active bus routes)
      const currentRouteCount = Object.keys(this.doc.routes).length;
      if (currentRouteCount < 6) {
        const existingNums = Object.values(this.doc.routes).map((r) => r.number);
        const pool = ['12', '33', '65', '14', '80', '190', '48', '77', '106'];
        const needed = 6 - currentRouteCount;
        const newNums = pool.filter((n) => !existingNums.includes(n)).slice(0, needed);
        B.generateRandomRoutes(city, net, this.doc, needed, newNums);
      }
      this.baseTemplate = JSON.stringify(this.doc);

      this.past = []; this.future = []; this.tx = null;
      this.legCache = new Map();
      this.derive();
    }

    _validDoc(str) {
      try {
        const d = JSON.parse(str);
        return d && d.map === B.MAP_VERSION && d.stops && d.routes && Object.values(d.stops).every((s) => this.net.edges[s.edge]);
      } catch (e) { return false; }
    }

    // ------------------------------------------------------------- history
    commit(label, fn) {
      const snap = JSON.stringify(this.doc);
      const res = fn(this.doc);
      if (JSON.stringify(this.doc) !== snap) {
        this.past.push({ doc: snap, label }); if (this.past.length > 120) this.past.shift();
        this.future = [];
      }
      this.changed(label);
      return res;
    }
    begin() { if (this.tx === null) this.tx = JSON.stringify(this.doc); }
    live() { this.changed(null, true); }
    end(label) {
      if (this.tx === null) return false;
      const changed = this.tx !== JSON.stringify(this.doc);
      if (changed) { this.past.push({ doc: this.tx, label }); if (this.past.length > 120) this.past.shift(); this.future = []; }
      this.tx = null; this.changed(changed ? label : null);
      return changed;
    }
    cancel() { if (this.tx !== null) { this.doc = JSON.parse(this.tx); this.tx = null; this.changed(null); } }
    undo() {
      if (!this.past.length) return null;
      const it = this.past.pop();
      this.future.push({ doc: JSON.stringify(this.doc), label: it.label });
      this.doc = JSON.parse(it.doc); this.changed('Undo'); return it.label;
    }
    redo() {
      if (!this.future.length) return null;
      const it = this.future.pop();
      this.past.push({ doc: JSON.stringify(this.doc), label: it.label });
      this.doc = JSON.parse(it.doc); this.changed('Redo'); return it.label;
    }
    loadDoc(docOrString, options = {}) {
      let parsed = null;
      if (typeof docOrString === 'string') {
        try { parsed = JSON.parse(docOrString); } catch (e) {}
      } else if (docOrString && typeof docOrString === 'object') {
        parsed = JSON.parse(JSON.stringify(docOrString));
      }
      if (!parsed || !this._validDoc(JSON.stringify(parsed))) {
        parsed = JSON.parse(this.baseTemplate || this.sample);
      }
      this.doc = parsed;
      this.past = [];
      this.future = [];
      this.tx = null;
      // The roads never change, so the legs worked out for one map still hold for the next
      this.saved = JSON.stringify(this.doc);
      this.derive();
      this.changed(options.label || 'Load Draft');
    }
    save(storageKey) {
      this.saved = JSON.stringify(this.doc);
      const key = storageKey || this.KEY;
      try { localStorage.setItem(key, this.saved); } catch (e) { /* ignore */ }
      this.changed('Saved');
    }
    newId(prefix) { return prefix + this.doc.seq++; }

    changed(label, live) {
      this.derive();
      B.events.emit('doc', { label, live: !!live });
    }

    // ------------------------------------------------------------- derived
    areaPoly(a) { return a.shape === 'circle' ? B.circlePoly(a.cx, a.cy, a.r, 48) : a.pts; }

    derive() {
      const d = this.doc;
      this.rev = (this.rev || 0) + 1; // bumps on every change; keys the detour options cache
      this.closedSet = new Set(Object.keys(d.closures).map(Number));
      this.closedKey = [...this.closedSet].sort((a, b) => a - b).join(',');
      this.areaEdges = {}; this.affected = new Map();
      for (const a of Object.values(d.areas)) {
        const ids = this.net.edgesInPolygon(this.areaPoly(a));
        this.areaEdges[a.id] = ids;
        for (const id of ids) { if (!this.affected.has(id)) this.affected.set(id, []); this.affected.get(id).push(a.id); }
      }
      this.geom = {}; this.stopRoutes = {}; this.stopLines = {};
      // Stops by lane (road + direction), so each stretch a route drives only looks at the stops on it
      const laneStops = new Map();
      for (const st of Object.values(d.stops)) {
        const key = st.edge * 2 + (st.dir > 0 ? 0 : 1);
        const arr = laneStops.get(key);
        if (arr) arr.push(st); else laneStops.set(key, [st]);
      }

      // For a normal route with no affected areas or road close, won't have detour applied
      const hasAnyClosures = this.closedSet && this.closedSet.size > 0;
      const hasAnyAreas = (d.areas && Object.keys(d.areas).length > 0) || (this.affected && this.affected.size > 0);

      for (const r of Object.values(d.routes)) {
        if (r.detourApplied) {
          if (!hasAnyClosures && !hasAnyAreas) {
            delete r.detourApplied;
            delete r.detourTitle;
            delete r.activeOptionIdx;
            delete r.viaName;
            if (r.originalAnchors) {
              r.anchors = JSON.parse(JSON.stringify(r.originalAnchors));
              delete r.originalAnchors;
              const firstStop = d.stops[r.anchors[0]?.id];
              const lastStop = d.stops[r.anchors[r.anchors.length - 1]?.id];
              r.name = `Bus ${r.number} (${firstStop ? firstStop.name : ''} ➔ ${lastStop ? lastStop.name : ''})`;
            }
          } else {
            const checkAnchors = r.originalAnchors || r.anchors;
            const gCheck = this.computeRoute({ anchors: checkAnchors, kind: 'existing' });
            const isAffected = (gCheck.conflicts && gCheck.conflicts.length > 0) ||
                               (gCheck.stopsOnClosed && gCheck.stopsOnClosed.length > 0) ||
                               (gCheck.legs && gCheck.legs.some(l => l.ok && l.segs && l.segs.some(sg => this.closedSet.has(sg.edge) || (this.affected && this.affected.has(sg.edge)))));
            if (!isAffected) {
              delete r.detourApplied;
              delete r.detourTitle;
              delete r.activeOptionIdx;
              delete r.viaName;
              if (r.originalAnchors) {
                r.anchors = JSON.parse(JSON.stringify(r.originalAnchors));
                delete r.originalAnchors;
                const firstStop = d.stops[r.anchors[0]?.id];
                const lastStop = d.stops[r.anchors[r.anchors.length - 1]?.id];
                r.name = `Bus ${r.number} (${firstStop ? firstStop.name : ''} ➔ ${lastStop ? lastStop.name : ''})`;
              }
            }
          }
        }
      }

      for (const r of Object.values(d.routes)) {
        const g = this.computeRoute(r);
        this.geom[r.id] = g;

        // 1. Explicit anchors
        for (const a of r.anchors) {
          if (a.t === 'stop') {
            const arr = (this.stopRoutes[a.id] = this.stopRoutes[a.id] || []);
            if (!arr.includes(r.id)) arr.push(r.id);
          }
        }

        // 2. Traversed road segments: only stops that this route ACTUALLY passes through
        if (g && g.legs) {
          for (const leg of g.legs) {
            if (!leg.ok || !leg.segs) continue;
            for (const seg of leg.segs) {
              const onLane = laneStops.get(seg.edge * 2 + (seg.dir > 0 ? 0 : 1));
              if (!onLane) continue;
              const sMin = Math.min(seg.s0, seg.s1) - 4;
              const sMax = Math.max(seg.s0, seg.s1) + 4;
              for (const st of onLane) {
                if (st.s >= sMin && st.s <= sMax) {
                  const arr = (this.stopRoutes[st.id] = this.stopRoutes[st.id] || []);
                  if (!arr.includes(r.id)) arr.push(r.id);
                }
              }
            }
          }
        }
      }

      // One route per bus number at each stop: pieces of the same bus count as a single line
      for (const [sid, rids] of Object.entries(this.stopRoutes)) {
        const seen = new Set();
        this.stopLines[sid] = rids.filter((rid) => {
          const num = String(d.routes[rid].number).trim();
          if (seen.has(num)) return false;
          seen.add(num);
          return true;
        });
      }
      // Thousands of buses' legs stay cached between changes; only a runaway cache is dropped
      if (this.legCache.size > 120000) this.legCache.clear();
    }

    resolveAnchor(a) {
      if (a.t === 'stop') { const s = this.doc.stops[a.id]; return s ? { edge: s.edge, s: s.s, dir: s.dir, stopId: s.id } : null; }
      return { edge: a.edge, s: a.s, dir: a.dir || 1, auto: !a.fixed };
    }

    // blocked: optional { set, key } of roads to avoid instead of just the closures (detour suggestions)
    leg(A, Bp, avoid, blocked = null) {
      const key = A.edge + ':' + A.s.toFixed(1) + ':' + A.dir + '|' + Bp.edge + ':' + Bp.s.toFixed(1) + ':' + Bp.dir + '|' + (avoid ? (blocked ? blocked.key : this.closedKey) : '-');
      let r = this.legCache.get(key);
      if (!r) {
        const opts = { closed: avoid ? (blocked ? blocked.set : this.closedSet) : null };
        r = this.net.route(A, Bp, opts);
        if (!r.ok) {
          const altB = { edge: Bp.edge, s: Bp.s, dir: -Bp.dir };
          const rAlt = this.net.route(A, altB, opts);
          if (rAlt.ok) r = rAlt;
          else {
            const rU = this.net.route(A, Bp, { ...opts, allowUturn: true });
            if (rU.ok) r = rU;
            else {
              const rAltU = this.net.route(A, altB, { ...opts, allowUturn: true });
              if (rAltU.ok) r = rAltU;
            }
          }
        }
        this.legCache.set(key, r);
      }
      return r;
    }

    computeRoute(r, blocked = null) {
      const avoid = r.kind === 'proposed' && !r.override;
      const res = []; const anchorIdx = [];
      r.anchors.forEach((a, i) => { const x = this.resolveAnchor(a); if (x) { res.push(x); anchorIdx.push(i); } });
      for (let i = 0; i < res.length; i++) {
        const x = res[i]; if (!x.auto) continue;
        let best = 1, bc = Infinity;
        for (const dir of [1, -1]) {
          const c = { ...x, dir }; let cost = 0;
          if (i > 0) { const l = this.leg(res[i - 1], c, avoid, blocked); cost += l.ok ? l.length : 1e7; }
          if (i < res.length - 1) { const l = this.leg(c, res[i + 1], avoid, blocked); cost += l.ok ? l.length : 1e7; }
          if (cost < bc) { bc = cost; best = dir; }
        }
        x.dir = best;
      }
      const legs = []; let length = 0; const conflicts = new Set(); const invalidLegs = [];
      for (let i = 0; i < res.length - 1; i++) {
        const l = this.leg(res[i], res[i + 1], avoid, blocked);
        legs.push(l);
        if (!l.ok) { invalidLegs.push(i); continue; }
        length += l.length;
        for (const sg of l.segs) if (this.closedSet.has(sg.edge)) conflicts.add(sg.edge);
      }
      const stops = res.filter((x) => x.stopId);
      const stopsOnClosed = stops.filter((x) => this.closedSet.has(x.edge)).map((x) => x.stopId);
      return {
        res, anchorIdx, legs, length, conflicts: [...conflicts], invalidLegs, stopsOnClosed,
        stopCount: stops.length, time: length / SPEED_MS + stops.length * DWELL_S, ok: invalidLegs.length === 0,
      };
    }

    disruptedRoutes() {
      return Object.values(this.doc.routes).filter((r) => {
        const g = this.geom[r.id];
        if (!g) return false;
        if (g.conflicts.length || g.stopsOnClosed.length) return true;
        if (this.affected && this.affected.size > 0 && g.legs) {
          if (g.legs.some((l) => l.ok && l.segs && l.segs.some((s) => this.affected.has(s.edge)))) return true;
        }
        return false;
      });
    }

    routesUsingEdge(edgeId) {
      const out = [];
      for (const r of Object.values(this.doc.routes)) {
        const g = this.geom[r.id];
        if (g && g.legs && g.legs.some((l) => l.ok && l.segs && l.segs.some((s) => s.edge === edgeId))) {
          out.push(r);
        }
      }
      return out;
    }

    // Detour options for a disrupted bus. Each one keeps the original route, its first and last stop and its
    // other stops, and changes only the stretch that runs on a closed road or through an affected area.
    // Shortest first, then a few small variations: other bypasses, one by an MRT station, and ones that pass
    // one extra stop near the blocked roads.
    generateDetourOptions(rid) {
      const r = this.doc.routes[rid];
      if (!r) return [];
      const baseRoute = (r.kind === 'proposed' && r.baseId && this.doc.routes[r.baseId]) ? this.doc.routes[r.baseId] : r;

      // Roads a detour must keep off: closures plus every road inside an affected area, and the same
      // from other projects applied at the same time (extraBlocked, set by the controller)
      const blockedSet = new Set(this.closedSet);
      if (this.affected) for (const e of this.affected.keys()) blockedSet.add(e);
      if (this.extraBlocked) for (const e of this.extraBlocked) blockedSet.add(e);
      if (!blockedSet.size) return [];
      const blocked = { set: blockedSet, key: 'blk:' + [...blockedSet].sort((a, b) => a - b).join(',') };
      const touches = (g, set) => g.legs.some((l) => l.ok && (l.segs || []).some((sg) => set.has(sg.edge)));
      const touchesBlocked = (g) => touches(g, blockedSet);
      const anchorEdge = (a) => (a.t === 'stop' ? (this.doc.stops[a.id] || {}).edge : a.edge);

      // Options come from the route as it was before any detour, so they stay the same once one is applied
      const srcAnchors = baseRoute.originalAnchors || baseRoute.anchors || [];
      const gOrig = this.computeRoute({ anchors: srcAnchors, kind: 'existing' });
      if (!touchesBlocked(gOrig) && !srcAnchors.some((a) => blockedSet.has(anchorEdge(a)))) return [];

      // A stop this bus can use: on an open road, active, and taking its bus model
      const model = B.busModel(this.doc, baseRoute.number);
      const takes = (st) => !!st && !blockedSet.has(st.edge) && st.active !== false &&
        B.stopBusTypes(this.doc, st.id, this.stopLines[st.id] || []).includes(model);
      const stopPt = (st) => this.net.posPoint(st, 0.78);
      const routeStopIds = new Set(srcAnchors.filter((a) => a.t === 'stop').map((a) => a.id));

      // The route still starts and ends where it did: a first or last stop on a blocked road hands over to a
      // stand-in, the nearest stops the bus can use first (when the nearest is a stop the route already has,
      // the blocked one just drops out)
      const stopIdx = srcAnchors.map((a, i) => (a.t === 'stop' ? i : -1)).filter((i) => i >= 0);
      const standIns = new Map(); // anchor index -> stand-in stop ids, nearest first
      for (const i of new Set([stopIdx[0], stopIdx[stopIdx.length - 1]])) {
        const end = i === undefined ? null : this.doc.stops[srcAnchors[i].id];
        if (!end || !blockedSet.has(end.edge)) continue;
        const at = stopPt(end);
        const near = Object.values(this.doc.stops)
          .filter((st) => st.id !== end.id && takes(st))
          .map((st) => ({ st, d: Math.hypot(stopPt(st).x - at.x, stopPt(st).y - at.y) }))
          .filter((x) => x.d <= 800)
          .sort((a, b) => a.d - b.d);
        const ids = [];
        for (const { st } of near) {
          if (routeStopIds.has(st.id)) break;
          ids.push(st.id);
          if (ids.length === 4) break;
        }
        if (ids.length) standIns.set(i, ids);
      }
      // Stops on blocked roads can't be served, so they drop out; every other stop stays, in order
      const withStandIns = (k) => srcAnchors
        .map((a, i) => (standIns.has(i) ? { t: 'stop', id: standIns.get(i)[Math.min(k, standIns.get(i).length - 1)] } : a))
        .filter((a) => !blockedSet.has(anchorEdge(a)));
      const droppedEnds = srcAnchors.filter((a) => !blockedSet.has(anchorEdge(a)));
      if (droppedEnds.length < 2 && !standIns.size) return [];

      // Working out detours is slow, so reuse them until the map changes
      const cacheKey = `${baseRoute.id}|${this.rev}|${this.extraBlockedKey || ''}`;
      if (this._detourCache && this._detourCache.key === cacheKey) return this._detourCache.options;

      // The map redraws a route avoiding closures only. Pin a detour with waypoints taken from its
      // clear path, leg by leg, until the redrawn route keeps out of the affected area as well.
      const pin = (anchors, avoid = blocked) => {
        let pins = anchors.map((a) => ({ ...a }));
        for (let tries = 0; tries < 8; tries++) {
          const g = this.computeRoute({ anchors: pins, kind: 'proposed' });
          if (!g.ok) return null;
          if (!touches(g, avoid.set)) return { anchors: pins, geom: g };
          const clear = this.computeRoute({ anchors: pins, kind: 'proposed' }, avoid);
          if (!clear.ok) return null;
          const next = [];
          pins.forEach((a, k) => {
            next.push(a);
            const i = g.anchorIdx.indexOf(k);
            const strays = i >= 0 && i < g.legs.length && (g.legs[i].segs || []).some((sg) => avoid.set.has(sg.edge));
            const segs = strays && clear.legs[i] ? clear.legs[i].segs || [] : [];
            // A quarter, half and three quarters along the clear leg, so it holds after a try or two
            const picks = [...new Set([0.25, 0.5, 0.75].map((f) => Math.floor(segs.length * f)))];
            for (const j of picks) {
              const sg = segs[j];
              if (sg) next.push({ t: 'waypoint', edge: sg.edge, s: (sg.s0 + sg.s1) / 2, dir: sg.dir, fixed: true });
            }
          });
          if (next.length === pins.length) return null;
          pins = next;
        }
        return null;
      };

      const options = [];
      const seenPaths = new Set();
      const edgesOf = (g) => new Set(g.legs.flatMap((l) => (l.segs || []).map((sg) => sg.edge)));
      const origEdges = edgesOf(gOrig);
      // How much of the route's own roads an option leaves: the smaller, the closer it stays to the route
      const leaves = (g) => {
        const own = edgesOf(g);
        let m = 0;
        for (const e of origEdges) if (!own.has(e)) m += (this.city.edges[e] && this.city.edges[e].len) || 0;
        return m;
      };
      // Two options are the same if they drive the same roads, wherever their stops split the legs
      const pathKey = (g) => g.legs
        .flatMap((l) => (l.segs || []).map((sg) => sg.edge))
        .filter((e, i, all) => i === 0 || e !== all[i - 1])
        .join('.');
      // "+1.2 km", "−300 m": the sign in front, the size formatted as usual (tiny changes read +0)
      const signed = (v, fmt, tiny) => (Math.abs(v) < tiny ? '+' + fmt(0) : (v > 0 ? '+' : '−') + fmt(Math.abs(v)));
      // keyExtra tells apart options on the same roads that stop somewhere different (the MRT stop)
      const addOption = (id, label, viaName, anchors, maxLength = Infinity, avoid = blocked, maxLeave = Infinity, keyExtra = '') => {
        const p = pin(anchors, avoid);
        if (!p || p.geom.length > maxLength || leaves(p.geom) > maxLeave) return null;
        const key = pathKey(p.geom) + keyExtra;
        if (seenPaths.has(key)) return null;
        seenPaths.add(key);
        options.push({
          id,
          label,
          title: label,
          viaName,
          anchors: p.anchors,
          geom: p.geom,
          length: p.geom.length,
          time: p.geom.time,
          stopCount: p.geom.stopCount,
          distDeltaKm: signed(p.geom.length - gOrig.length, B.fmtKm, 5),
          timeDeltaMin: signed(p.geom.time - gOrig.time, B.fmtMin, 30),
        });
        return options[options.length - 1];
      };

      // 1. Same stops, rerouted around the blocked roads only where it has to. With a blocked first or last stop,
      // the nearest stand-in that gives a clear route; failing that, the blocked end drops out as before.
      let baseAnchors = null;
      for (let k = 0; k < (standIns.size ? 4 : 1) && !options.length; k++) {
        baseAnchors = withStandIns(k);
        if (baseAnchors.length >= 2) addOption('opt_direct', 'Shortest bypass', 'Same stops, around the blocked roads', baseAnchors);
      }
      if (!options.length && standIns.size && droppedEnds.length >= 2) {
        baseAnchors = droppedEnds;
        addOption('opt_direct', 'Shortest bypass', 'Same stops, around the blocked roads', baseAnchors);
      }
      if (!baseAnchors || baseAnchors.length < 2) return [];

      // Every other option may add only a little to the shortest bypass, and leave only a little more of the route
      const direct = options[0];
      const maxLength = direct ? direct.length + Math.max(700, direct.length * 0.2) : gOrig.length * 1.25 + 700;
      const maxLeave = direct ? leaves(direct.geom) + 800 : Infinity;
      const MAX_OPTIONS = 12;
      const roadName = (e) => (this.city.edges[e] && this.city.edges[e].name) || null;

      // 2. Next-best bypasses: keep off one road the shortest bypass newly uses, and go around it
      if (direct) {
        const directEdges = edgesOf(direct.geom);
        for (const e of [...directEdges].filter((id) => !origEdges.has(id))) {
          if (options.length >= MAX_OPTIONS) break;
          const set = new Set(blockedSet);
          set.add(e);
          const opt = addOption('opt_alt_' + e, 'Alternative bypass', 'Alternative bypass', baseAnchors, maxLength, { set, key: blocked.key + '+' + e }, maxLeave);
          if (!opt) continue;
          // Name it after the first road it takes that neither the route nor the shortest bypass uses
          const own = [...edgesOf(opt.geom)].find((id) => !origEdges.has(id) && !directEdges.has(id) && roadName(id));
          if (own) opt.label = opt.title = opt.viaName = 'Via ' + roadName(own);
          // Two bypasses by the same road read as one option: keep the shorter
          const twin = options.find((o) => o !== opt && o.label === opt.label);
          if (twin) options.splice(options.indexOf(twin.length <= opt.length ? opt : twin), 1);
        }
      }

      // 3 & 4. Small variations: a stop by an MRT station, then one extra stop near the blocked roads.
      // "Near" is around the part of this route that's blocked, not every blocked road on the map.
      const routeBlocked = new Set([...origEdges].filter((e) => blockedSet.has(e)));
      for (const a of srcAnchors) if (blockedSet.has(anchorEdge(a))) routeBlocked.add(anchorEdge(a));
      let cx = 0, cy = 0, n = 0;
      const blockedPts = [];
      for (const id of (routeBlocked.size ? routeBlocked : blockedSet)) {
        const e = this.city.edges[id];
        if (!e) continue;
        for (const pt of e.pts) { cx += pt.x; cy += pt.y; n++; blockedPts.push(pt); }
      }
      if (n) { cx /= n; cy /= n; }
      const reach = blockedPts.reduce((m, pt) => Math.max(m, Math.hypot(pt.x - cx, pt.y - cy)), 0) + 500;

      const anchorPt = (a) => {
        if (a.t === 'stop') {
          const st = this.doc.stops[a.id];
          return st ? this.net.posPoint(st, 0.78) : null;
        }
        const e = this.city.edges[a.edge];
        return e ? B.pointAlong(e.pts, e.cum, a.s) : null;
      };
      const basePts = baseAnchors.map(anchorPt);
      // Each extra stop goes where it adds the least distance along the route
      const bestInsertAt = (p) => {
        let best = 1;
        let bestCost = Infinity;
        for (let i = 1; i < basePts.length; i++) {
          const a = basePts[i - 1];
          const b = basePts[i];
          if (!a || !b) continue;
          const cost = Math.hypot(p.x - a.x, p.y - a.y) + Math.hypot(p.x - b.x, p.y - b.y) - Math.hypot(a.x - b.x, a.y - b.y);
          if (cost < bestCost) { bestCost = cost; best = i; }
        }
        return best;
      };

      // 3. By an MRT station near the blocked roads that the route doesn't reach yet, stopping beside it so
      // riders can still change to the train. Of the nearest few stations, the one that adds the least;
      // it may run longer than the other variations
      const nearPt = (pts, p, d) => pts.some((q) => q && Math.hypot(q.x - p.x, q.y - p.y) <= d);
      const stations = (this.city.mrtStations || [])
        .filter((m) => !nearPt(basePts, m, 350))
        .map((m) => ({ m, d: Math.hypot(m.x - cx, m.y - cy) }))
        .filter((x) => x.d <= reach + 800)
        .sort((a, b) => a.d - b.d)
        .slice(0, 4);
      const mrtMaxLength = direct ? direct.length + Math.max(2000, direct.length * 0.6) : maxLength;
      let mrtPick = null;
      for (const { m } of stations) {
        let best = null;
        for (const st of Object.values(this.doc.stops)) {
          if (!takes(st) || baseAnchors.some((a) => a.id === st.id)) continue;
          const p = stopPt(st);
          const d = Math.hypot(p.x - m.x, p.y - m.y);
          if (d <= 300 && (!best || d < best.d)) best = { st, p, d };
        }
        if (!best) continue;
        const at = bestInsertAt(best.p);
        const anchors = [...baseAnchors.slice(0, at), { t: 'stop', id: best.st.id }, ...baseAnchors.slice(at)];
        const p = pin(anchors);
        if (!p || p.geom.length > mrtMaxLength || leaves(p.geom) > maxLeave + 1000) continue;
        if (!mrtPick || p.geom.length < mrtPick.length) mrtPick = { m, anchors, length: p.geom.length, stopId: best.st.id };
      }
      if (mrtPick && options.length < MAX_OPTIONS) {
        const name = `Via ${mrtPick.m.name} MRT`;
        const opt = addOption('opt_mrt_' + mrtPick.m.id, name, name, mrtPick.anchors, Infinity, blocked, Infinity, '|mrt:' + mrtPick.stopId);
        if (opt) opt.mrt = mrtPick.m.name;
      }

      // 4. One extra stop near the blocked roads
      const candidates = Object.values(this.doc.stops)
        .filter((st) => takes(st) && !baseAnchors.some((a) => a.id === st.id))
        .map((st) => ({ st, pt: this.net.posPoint(st, 0.78) }))
        .filter(({ pt }) => Math.hypot(pt.x - cx, pt.y - cy) <= reach)
        .sort((a, b) => Math.hypot(a.pt.x - cx, a.pt.y - cy) - Math.hypot(b.pt.x - cx, b.pt.y - cy));

      let tested = 0;
      for (const { st, pt } of candidates) {
        if (options.length >= MAX_OPTIONS || tested >= 60) break;
        tested++;
        const at = bestInsertAt(pt);
        const anchors = [...baseAnchors.slice(0, at), { t: 'stop', id: st.id }, ...baseAnchors.slice(at)];
        addOption('opt_' + st.id, 'Via ' + st.name, 'Via ' + st.name, anchors, maxLength, blocked, maxLeave);
      }

      // Shortest bypass first, then the rest from the least to the most extra distance
      const [first, ...rest] = options;
      const ordered = first && first.id === 'opt_direct'
        ? [first, ...rest.sort((a, b) => a.length - b.length)]
        : options.sort((a, b) => a.length - b.length);
      ordered.forEach((o, i) => {
        o.index = i;
        o.isRecommended = i === 0;
      });

      this._detourCache = { key: cacheKey, options: ordered };
      return ordered;
    }
  };

  // ------------------------------------------------------------------ domain operations
  // Pure functions on a doc (used inside store.commit / begin..end transactions).
  B.ops = {
    // Removing a stop drops it from every route that uses it; a route left without a line (fewer
    // than two stops) is removed too, so no empty bus pieces stay behind
    deleteStop(doc, sid) {
      const affected = [];
      for (const r of Object.values(doc.routes)) {
        if (!r.anchors.some((a) => a.t === 'stop' && a.id === sid)) continue;
        r.anchors = r.anchors
          .filter((a) => !(a.t === 'stop' && a.id === sid))
          // A → B → A with B gone would visit A twice in a row, which is not a line
          .filter((a, i, arr) => !(i > 0 && a.t === 'stop' && arr[i - 1].t === 'stop' && arr[i - 1].id === a.id));
        affected.push(r.number);
      }
      delete doc.stops[sid];
      return { affected, removed: B.ops.pruneEmptyRoutes(doc) };
    },
    // Routes with fewer than two anchors can't be drawn or selected; returns the bus numbers removed.
    // A planned bus (made from New Bus Number, no stops linked yet) stays until its route is drawn.
    pruneEmptyRoutes(doc) {
      const removed = [];
      for (const r of Object.values(doc.routes || {})) {
        if (r.planned && !(r.anchors || []).length) continue;
        if (!r.anchors || r.anchors.length < 2) {
          delete doc.routes[r.id];
          removed.push(r.number);
        }
      }
      return removed;
    },
    setClosed(doc, ids, closed, meta) {
      for (const id of ids) { if (closed) doc.closures[id] = meta || { reason: 'Road closure' }; else delete doc.closures[id]; }
    },
    // Deletes an affected area and the road closures it made (tagged with its id, or older ones
    // recorded as "Closed by <area name>"); returns how many closures went with it
    deleteArea(doc, areaId) {
      const area = doc.areas[areaId];
      if (!area) return 0;
      const madeBy = `Closed by ${area.name}`;
      let removed = 0;
      for (const [edge, c] of Object.entries(doc.closures || {})) {
        if (c && (c.areaId === areaId || c.reason === madeBy)) { delete doc.closures[edge]; removed++; }
      }
      delete doc.areas[areaId];
      return removed;
    },
  };
})();
