/* BRASS — road network graph: snapping, lane geometry and direction-aware routing.
 * Traffic keeps LEFT (Singapore). A position on the network is {edge, s, dir}:
 *   s   = distance (m) along the edge centreline from node a
 *   dir = +1 travelling a→b (left lane of a→b), -1 travelling b→a
 */
(function () {
  const B = window.B;

  B.RoadNetwork = class {
    constructor(city) {
      this.city = city;
      this.nodes = city.nodes;
      this.edges = city.edges;
      this.segHash = city.segHash;
    }

    edge(id) { return this.edges[id]; }
    /** Clamp s so stops/waypoints never sit inside a junction box. */
    clampS(edgeId, s) {
      const e = this.edges[edgeId];
      const ca = this.nodes[e.a].edges.length >= 2 ? this.nodes[e.a].maxHw + 10 : 6;
      const cb = this.nodes[e.b].edges.length >= 2 ? this.nodes[e.b].maxHw + 10 : 6;
      if (e.len <= ca + cb) return e.len / 2;
      return B.clamp(s, ca, e.len - cb);
    }

    /** Point on the network, offset towards the kerb of the travel lane. frac: 0 = centre, 1 = kerb. */
    posPoint(pos, frac = 0.78) {
      const e = this.edges[pos.edge];
      const p = B.pointAlong(e.pts, e.cum, pos.s);
      const ang = pos.dir > 0 ? p.ang : p.ang + Math.PI;
      const o = e.hw * frac;
      return { x: p.x + Math.sin(ang) * o, y: p.y - Math.cos(ang) * o, ang };
    }

    /** Nearest road centreline to p within maxD (metres) using the segment spatial index. */
    nearest(p, maxD = 120) {
      let best = null, bd = maxD * maxD;
      for (const sg of this.segHash.query({ x0: p.x - maxD, y0: p.y - maxD, x1: p.x + maxD, y1: p.y + maxD })) {
        const pr = B.projSeg(p, sg.a, sg.b);
        // compare by distance to road EDGE so a wide road wins over a thin one at equal centre distance
        const d = Math.sqrt(pr.d2) - sg.hw;
        const key = d * Math.abs(d) ;
        if (best === null || key < best.key) {
          if (Math.sqrt(pr.d2) > maxD) continue;
          const e = this.edges[sg.e];
          const crs = (sg.b.x - sg.a.x) * (p.y - sg.a.y) - (sg.b.y - sg.a.y) * (p.x - sg.a.x);
          best = { key, edge: sg.e, s: e.cum[sg.i] + pr.t * (e.cum[sg.i + 1] - e.cum[sg.i]), d: Math.sqrt(pr.d2), x: pr.x, y: pr.y, side: crs < 0 ? 1 : -1, hw: e.hw };
        }
      }
      if (best) delete best.key;
      return best;
    }

    /**
     * Road-constrained placement test. Uses real road geometry + land-use mask, not screen pixels.
     * Returns {valid, reason, pos, point, edge}.
     */
    classify(p, tol) {
      const n = this.nearest(p, 160);
      const f = this.city.flagsAt(p);
      const F = B.FLAGS;
      const onRoad = n && n.d <= n.hw;
      if (!onRoad) {
        let reason = null;
        if (!(f & F.LAND)) reason = 'In the sea — bus infrastructure must be on a road';
        else if (f & (F.LAKE | F.RIVER)) reason = 'In water — not a drivable surface';
        else if (this.inBuilding(p)) reason = 'Inside a building — buildings are obstacles';
        else if (f & F.PARK) reason = 'Inside a park — not a drivable surface';
        else if (!n || n.d > n.hw + tol) reason = 'Too far from the road network';
        if (reason) return { valid: false, reason, near: n };
      }
      const s = this.clampS(n.edge, n.s);
      const pos = { edge: n.edge, s, dir: n.side };
      return { valid: true, pos, point: this.posPoint(pos, 0.78), edge: n.edge, near: n };
    }

    inBuilding(p) {
      for (const b of this.city.bHash.query({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }))
        if (B.pointInPoly(p, b.poly)) return b;
      return null;
    }

    turnCost(e1, d1, e2, d2) {
      const E = this.edges;
      const hin = d1 > 0 ? E[e1].angB : E[e1].angA + Math.PI;
      const hout = d2 > 0 ? E[e2].angA : E[e2].angB + Math.PI;
      const t = B.angNorm(hout - hin);
      const a = Math.abs(t);
      if (a < 0.4) return 0;
      if (a > 2.7) return 260; // U-turn
      return t > 0 ? 34 : 14;   // right turns cross traffic (keep-left)
    }

    /**
     * Shortest legal path between two network positions over a directed-edge graph:
     * no U-turns except at dead ends, turn penalties, optional closed-edge avoidance.
     * A* search: it heads for the target first (no road costs less than its straight-line length), and its
     * working arrays are kept between searches, a stamp telling which entries belong to this one.
     */
    route(A, Bp, opts = {}) {
      const E = this.edges, N = this.nodes;
      const closed = opts.closed || null;
      if (A.edge === Bp.edge && A.dir === Bp.dir && (A.dir > 0 ? Bp.s >= A.s - 0.5 : Bp.s <= A.s + 0.5))
        return this._build([{ edge: A.edge, dir: A.dir, s0: A.s, s1: Bp.s }], closed);

      const ns = E.length * 2;
      if (!this._dist || this._dist.length !== ns) {
        this._dist = new Float64Array(ns);
        this._prev = new Int32Array(ns);
        this._stamp = new Uint32Array(ns);
        this._gen = 0;
      }
      const dist = this._dist, prev = this._prev, stamp = this._stamp;
      const gen = ++this._gen;
      const g = (st) => (stamp[st] === gen ? dist[st] : Infinity);
      const sIdx = (e, d) => e * 2 + (d > 0 ? 0 : 1);
      const start = sIdx(A.edge, A.dir), target = sIdx(Bp.edge, Bp.dir);
      const eA = E[A.edge], eB = E[Bp.edge];
      const goal = N[Bp.dir > 0 ? eB.a : eB.b];
      const h = (node) => Math.hypot(N[node].x - goal.x, N[node].y - goal.y);
      const c0 = A.dir > 0 ? eA.len - A.s : A.s;
      const tail = Bp.dir > 0 ? Bp.s : eB.len - Bp.s;
      const heap = new B.Heap();
      stamp[start] = gen; dist[start] = c0; prev[start] = -1;
      heap.push(start, c0 + h(A.dir > 0 ? eA.b : eA.a));
      let best = Infinity, bestPrev = -1;
      while (heap.size) {
        const st = heap.pop();
        if (heap.lastKey >= best) break;
        const d = g(st);
        const e = st >> 1, dir = st & 1 ? -1 : 1;
        const node = dir > 0 ? E[e].b : E[e].a;
        if (heap.lastKey > d + h(node) + 1e-6) continue; // an older, longer entry
        const outs = N[node].edges;
        for (const e2 of outs) {
          const ed = E[e2];
          for (let k = 0; k < 2; k++) {
            const d2 = k === 0 ? 1 : -1;
            if ((d2 > 0 ? ed.a : ed.b) !== node) continue;
            if (e2 === e && outs.length > 1 && !opts.allowUturn) continue;
            const st2 = sIdx(e2, d2);
            const tc = this.turnCost(e, dir, e2, d2);
            if (st2 === target) {
              const tot = d + tc + tail;
              if (tot < best) { best = tot; bestPrev = st; }
            }
            if (closed && closed.has(e2)) continue;
            const nd = d + tc + ed.len * (ed.cls === 'major' ? 1 : 1.12);
            if (nd < g(st2)) {
              stamp[st2] = gen; dist[st2] = nd; prev[st2] = st;
              heap.push(st2, nd + h(d2 > 0 ? ed.b : ed.a));
            }
          }
        }
      }
      if (best === Infinity) {
        let reason = 'No connected road path between these points';
        if (closed && closed.size) {
          const alt = this.route(A, Bp, { allowUturn: opts.allowUturn });
          if (alt.ok) reason = 'Every connecting road is closed — no legal detour exists';
        }
        return { ok: false, reason, pts: [], length: 0, segs: [] };
      }
      const chain = [];
      let cur = bestPrev;
      while (cur !== -1 && cur !== start) { chain.push(cur); cur = prev[cur]; }
      chain.reverse();
      const segs = [{ edge: A.edge, dir: A.dir, s0: A.s, s1: A.dir > 0 ? eA.len : 0 }];
      for (const st of chain) { const e = st >> 1, d = st & 1 ? -1 : 1; segs.push({ edge: e, dir: d, s0: d > 0 ? 0 : E[e].len, s1: d > 0 ? E[e].len : 0 }); }
      segs.push({ edge: Bp.edge, dir: Bp.dir, s0: Bp.dir > 0 ? 0 : eB.len, s1: Bp.s });
      return this._build(segs, closed);
    }

    _build(segs, closed) {
      const pts = [];
      let length = 0;
      const out = [];

      for (let i = 0; i < segs.length; i++) {
        const sg = segs[i];
        const e = this.edges[sg.edge];
        const L = Math.abs(sg.s1 - sg.s0);
        if (L < 0.3) continue;
        out.push(sg);
        length += L;

        const hasNext = (i < segs.length - 1) && (segs[i + 1].edge !== sg.edge);
        const hasPrev = (i > 0) && (segs[i - 1].edge !== sg.edge);

        let sStart = sg.s0;
        let sEnd = sg.s1;

        if (hasPrev) {
          const prevSg = segs[i - 1];
          const prevE = this.edges[prevSg.edge];
          const node = sg.dir > 0 ? e.a : e.b;
          const maxHw = (this.nodes[node] && this.nodes[node].maxHw) || Math.max(e.hw, prevE.hw);
          const cut = Math.min(L * 0.45, Math.max(maxHw + 2.5, 8));
          sStart = sg.dir > 0 ? sg.s0 + cut : sg.s0 - cut;
          if (sg.dir > 0) {
            sStart = Math.min(sg.s1, Math.max(sg.s0, sStart));
          } else {
            sStart = Math.max(sg.s1, Math.min(sg.s0, sStart));
          }
        }

        if (hasNext) {
          const nextSg = segs[i + 1];
          const nextE = this.edges[nextSg.edge];
          const node = sg.dir > 0 ? e.b : e.a;
          const maxHw = (this.nodes[node] && this.nodes[node].maxHw) || Math.max(e.hw, nextE.hw);
          const cut = Math.min(L * 0.45, Math.max(maxHw + 2.5, 8));
          sEnd = sg.dir > 0 ? sg.s1 - cut : sg.s1 + cut;
          if (sg.dir > 0) {
            sEnd = Math.max(sStart, Math.min(sg.s1, sEnd));
          } else {
            sEnd = Math.min(sStart, Math.max(sg.s1, sEnd));
          }
        }

        // Slice road centerline and offset towards the travel lane (snapping directly on bus stop dots)
        const raw = B.slicePolyline(e.pts, e.cum, sStart, sEnd);
        const off = B.offsetPolyline(raw, e.hw * 0.78);
        for (const p of off) {
          p.dir = sg.dir;
          p.lane = `${sg.edge}:${sg.dir}`;
          pts.push(p);
        }

        // At corner intersection: generate smooth turning curve
        if (hasNext) {
          const nextSg = segs[i + 1];
          const nextE = this.edges[nextSg.edge];
          const nextL = Math.abs(nextSg.s1 - nextSg.s0);
          const node = sg.dir > 0 ? e.b : e.a;
          const maxHw = (this.nodes[node] && this.nodes[node].maxHw) || Math.max(e.hw, nextE.hw);
          const nextCut = Math.min(nextL * 0.45, Math.max(maxHw + 2.5, 8));
          let nextSStart = nextSg.dir > 0 ? nextSg.s0 + nextCut : nextSg.s0 - nextCut;
          if (nextSg.dir > 0) {
            nextSStart = Math.min(nextSg.s1, Math.max(nextSg.s0, nextSStart));
          } else {
            nextSStart = Math.max(nextSg.s1, Math.min(nextSg.s0, nextSStart));
          }

          const pIn = this.posPoint({ edge: e.id, s: sEnd, dir: sg.dir }, 0.78);
          const pOut = this.posPoint({ edge: nextE.id, s: nextSStart, dir: nextSg.dir }, 0.78);

          const dist = Math.hypot(pOut.x - pIn.x, pOut.y - pIn.y);
          const cLen = Math.min(dist * 0.45, 18);
          const c1 = { x: pIn.x + Math.cos(pIn.ang) * cLen, y: pIn.y + Math.sin(pIn.ang) * cLen };
          const c2 = { x: pOut.x - Math.cos(pOut.ang) * cLen, y: pOut.y - Math.sin(pOut.ang) * cLen };

          const steps = 8;
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const inv = 1 - t;
            pts.push({
              x: inv * inv * inv * pIn.x + 3 * inv * inv * t * c1.x + 3 * inv * t * t * c2.x + t * t * t * pOut.x,
              y: inv * inv * inv * pIn.y + 3 * inv * inv * t * c1.y + 3 * inv * t * t * c2.y + t * t * t * pOut.y,
              dir: t < 0.5 ? sg.dir : nextSg.dir,
            });
          }
        }
      }

      // Deduplicate consecutive identical/sub-pixel points
      const cleanPts = [];
      for (let i = 0; i < pts.length; i++) {
        if (cleanPts.length > 0) {
          const prev = cleanPts[cleanPts.length - 1];
          if (Math.hypot(pts[i].x - prev.x, pts[i].y - prev.y) < 0.05) continue;
        }
        cleanPts.push(pts[i]);
      }

      // Group into contiguous lane direction chunks (Lane -> vs Lane <-)
      const chunks = [];
      let curChunk = null;
      for (let i = 0; i < cleanPts.length; i++) {
        const pt = cleanPts[i];
        const dir = pt.dir !== undefined ? pt.dir : 1;
        if (!curChunk || curChunk.dir !== dir) {
          const prevPt = curChunk && curChunk.pts.length ? curChunk.pts[curChunk.pts.length - 1] : null;
          curChunk = { dir, pts: prevPt ? [prevPt, pt] : [pt] };
          chunks.push(curChunk);
        } else {
          curChunk.pts.push(pt);
        }
      }

      return { ok: true, pts: cleanPts, length, segs: out, chunks };
    }

    /** Edges whose centreline intersects a polygon (affected area). */
    edgesInPolygon(poly) {
      const bb = B.bbox(poly), out = [];
      for (const e of this.edges) {
        if (!B.bboxOverlap(bb, e.bb)) continue;
        if (B.polylineIntersectsPoly(e.pts, poly)) out.push(e.id);
      }
      return out;
    }

    edgeLabel(id) { const e = this.edges[id]; return e ? e.name : '—'; }

    /** Direction description for a lane: "towards <cross street>" */
    towards(edgeId, dir) {
      const e = this.edges[edgeId];
      const node = this.nodes[dir > 0 ? e.b : e.a];
      const other = node.edges.map((id) => this.edges[id]).find((x) => x.name !== e.name);
      return other ? 'towards ' + other.name : 'towards end of ' + e.name;
    }
  };
})();
