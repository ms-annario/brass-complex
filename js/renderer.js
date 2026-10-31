/* BRASS — Ultra-Fast, Low-Latency Canvas Map Renderer
 * Optimized for 60-120 FPS: On-demand dirty rendering, batched paths,
 * zero-cost flat 2.5D shadows (no shadowBlur lag), and LOD culling.
 */
(function () {
  const B = window.B;

  // Helper to compute parallel perpendicular offset polyline for overlapping bus routes.
  // `offset` is one distance for every point, or an array with a distance per point.
  function offsetPolyline(pts, offset) {
    const perPoint = Array.isArray(offset);
    if ((!perPoint && !offset) || !pts || pts.length < 2) return pts;
    const res = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      let nx = 0, ny = 0, count = 0;
      if (i > 0) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        const l = Math.hypot(dx, dy);
        if (l > 0.0001) {
          nx += -dy / l;
          ny += dx / l;
          count++;
        }
      }
      if (i < n - 1) {
        const dx = pts[i + 1].x - pts[i].x;
        const dy = pts[i + 1].y - pts[i].y;
        const l = Math.hypot(dx, dy);
        if (l > 0.0001) {
          nx += -dy / l;
          ny += dx / l;
          count++;
        }
      }
      if (count > 0) {
        nx /= count;
        ny /= count;
        const len = Math.hypot(nx, ny);
        if (len > 0.0001) {
          nx /= len;
          ny /= len;
        }
        const d = perPoint ? offset[i] : offset;
        res.push({ x: pts[i].x + nx * d, y: pts[i].y + ny * d });
      } else {
        res.push(pts[i]);
      }
    }
    return res;
  }

  class MapRenderer {
    constructor(canvas, city, net, store) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.city = city;
      this.net = net;
      this.store = store;

      // Camera state (world units in metres)
      this.camera = {
        x: city.W * 0.52,
        y: city.H * 0.52,
        zoom: 0.48,
        minZoom: 0.012,
        maxZoom: 3.5,
      };

      // Layer visibility flags
      this.layers = {
        coast: true,
        parks: true,
        waterways: true,
        buildings: true,
        roads: true,
        crossings: true,
        closures: true,
        affectedAreas: true,
        existingRoutes: true,
        proposedRoutes: true,
        stops: true,
        stopPoints: true,
        stopNames: true,
        mrtStations: true,
        labels: true,
        roadNames: false,
      };
      this.namesAlways = false; // place names at every zoom (the drawing-link page)

      // MRT logo for station markers
      this.mrtImg = new Image();
      this.mrtImg.onload = () => this.requestRender();
      this.mrtImg.src = 'assets/mrt.png';

      // Interactive transient render state
      this.hovered = null;
      this.selected = null;
      this.invalidPlacement = null;
      this.snapTarget = null;
      this.visibleRouteIds = null;
      this.timeWindow = null; // { from, to, days }: only buses running in this window (and on one of these days) are drawn
      this.drawingArea = null;
      this.drawingAreaPreview = null; // cursor point while an Affected Area is drawn
      this.drawingRoute = null;
      this.connectingPreview = null;
      this.activeConnectStopId = null; // bus stop ID actively connecting from
      this.lastActiveRouteId = null; // route ID actively being drawn/connected
      this.activeConnectRouteId = null; // route being extended in the current connecting chain (null once confirmed)
      this.connectBusNumber = null; // bus number chosen in the stop pill for the current connect chain
      this.routePreviewId = null; // route ID actively being previewed / hovered
      this.previewDetourOption = null; // detour option actively being previewed on map { opt, routeNumber, color }
      this.detourOptions = null; // all detour options currently available { options: [], activeIndex: 0 }
      this.justCreatedStopId = null; // bus stop ID most recently created

      // Snap-back animation state
      this.snapBackAnim = null;

      // View mode polygon area filter state
      this.areaFilterPolygon = null;
      this.drawingAreaFilter = null;
      this.drawingAreaFilterPreview = null;
      this.areaFilterPassingIds = null;
      this.areaFilterSelectedRouteIds = null;
      this.filterMapToArea = true;
      this.areaFilterPassingCount = 0;
      this.hideAreaFilterOutline = false; // a map click hides the drawn area; its filter stays

      // Map base opacity (affects terrain, roads, buildings, labels, but NOT items on map like bus stops or routes)
      this.mode = 'view'; // 'view' | 'edit'
      this.mapOpacity = 1.0;
      if (typeof document !== 'undefined' && document.createElement) {
        this.mapCanvas = document.createElement('canvas');
        this.mapCtx = this.mapCanvas.getContext ? this.mapCanvas.getContext('2d') : null;
      }

      // Performance: On-demand dirty render flag
      this.needsRender = true;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2); // Cap at 2x to prevent 4k/retina choke
      this.resize();

      // Animation frame driver
      this._boundRender = this._renderLoop.bind(this);
      requestAnimationFrame(this._boundRender);
    }

    setMapOpacity(opacity) {
      const clamped = Math.max(0, Math.min(1, Number(opacity)));
      if (this.mapOpacity !== clamped) {
        this.mapOpacity = clamped;
        this.requestRender();
      }
    }

    requestRender() {
      this.needsRender = true;
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.width = rect.width;
      this.height = rect.height;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.floor(this.width * this.dpr);
      this.canvas.height = Math.floor(this.height * this.dpr);
      if (this.mapCanvas) {
        this.mapCanvas.width = this.canvas.width;
        this.mapCanvas.height = this.canvas.height;
      }
      this._baseKey = null; // resizing a canvas clears it
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.requestRender();
    }

    worldToScreen(wx, wy) {
      return {
        x: (wx - this.camera.x) * this.camera.zoom + this.width / 2,
        y: (wy - this.camera.y) * this.camera.zoom + this.height / 2,
      };
    }

    screenToWorld(sx, sy) {
      return {
        x: (sx - this.width / 2) / this.camera.zoom + this.camera.x,
        y: (sy - this.height / 2) / this.camera.zoom + this.camera.y,
      };
    }

    getViewportBBox() {
      const p0 = this.screenToWorld(0, 0);
      const p1 = this.screenToWorld(this.width, this.height);
      return {
        x0: Math.min(p0.x, p1.x) - 60,
        y0: Math.min(p0.y, p1.y) - 60,
        x1: Math.max(p0.x, p1.x) + 60,
        y1: Math.max(p0.y, p1.y) + 60,
      };
    }

    fitToBoundary(padPercent = 0.08) {
      this.cameraAnim = null;
      const bounds = this.city.bounds;
      const bw = bounds.x1 - bounds.x0;
      const bh = bounds.y1 - bounds.y0;
      const zx = (this.width * (1 - padPercent * 2)) / bw;
      const zy = (this.height * (1 - padPercent * 2)) / bh;
      this.camera.zoom = B.clamp(Math.min(zx, zy), this.camera.minZoom, this.camera.maxZoom);
      this.camera.x = (bounds.x0 + bounds.x1) / 2;
      this.camera.y = (bounds.y0 + bounds.y1) / 2;
      this.requestRender();
    }

    zoomAt(screenX, screenY, factor) {
      this.cameraAnim = null;
      const wBefore = this.screenToWorld(screenX, screenY);
      const newZoom = B.clamp(this.camera.zoom * factor, this.camera.minZoom, this.camera.maxZoom);
      if (newZoom === this.camera.zoom) return;
      this.camera.zoom = newZoom;
      const wAfter = this.screenToWorld(screenX, screenY);
      this.camera.x += (wBefore.x - wAfter.x);
      this.camera.y += (wBefore.y - wAfter.y);
      this.requestRender();
    }

    // Glides the camera so a world box fits the screen, inside insets (px) left clear for the panels
    fitToBounds(b, insets = {}, opts = {}) {
      const ins = { left: 0, right: 0, top: 0, bottom: 0, ...insets };
      const minSize = opts.minSize || 500;
      const bw = Math.max(minSize, b.x1 - b.x0);
      const bh = Math.max(minSize, b.y1 - b.y0);
      const availW = Math.max(160, this.width - ins.left - ins.right);
      const availH = Math.max(160, this.height - ins.top - ins.bottom);
      const pad = 28;
      const zoom = B.clamp(Math.min((availW - pad * 2) / bw, (availH - pad * 2) / bh), this.camera.minZoom, opts.maxZoom || 1.6);
      // The box's centre lands in the middle of the clear area, not the middle of the window
      const sx = ins.left + availW / 2;
      const sy = ins.top + availH / 2;
      const to = {
        x: (b.x0 + b.x1) / 2 - (sx - this.width / 2) / zoom,
        y: (b.y0 + b.y1) / 2 - (sy - this.height / 2) / zoom,
        zoom,
      };
      this.cameraAnim = { from: { x: this.camera.x, y: this.camera.y, zoom: this.camera.zoom }, to, start: performance.now(), duration: 450 };
      this.requestRender();
    }

    _stepCameraAnim() {
      const a = this.cameraAnim;
      if (!a) return;
      const t = Math.min(1, (performance.now() - a.start) / a.duration);
      const k = 1 - Math.pow(1 - t, 3);
      // Zoom eases on a log scale so zooming in and out feel the same speed
      this.camera.zoom = Math.exp(Math.log(a.from.zoom) + (Math.log(a.to.zoom) - Math.log(a.from.zoom)) * k);
      this.camera.x = a.from.x + (a.to.x - a.from.x) * k;
      this.camera.y = a.from.y + (a.to.y - a.from.y) * k;
      if (t >= 1) this.cameraAnim = null;
      this.needsRender = true;
    }

    triggerSnapBack(fromX, fromY, toX, toY, onComplete) {
      this.snapBackAnim = {
        fromX, fromY, toX, toY,
        startTime: performance.now(),
        duration: 260,
        onComplete,
      };
      this.requestRender();
    }

    _renderLoop(timestamp) {
      this._stepCameraAnim();

      // Check if continuous animation is currently active (route preview, moving dashes, snapback, area filter)
      const isRouteActive = (this.selected && (this.selected.type === 'route' || this.selected.type === 'route-leg')) ||
        (this.hovered && (this.hovered.type === 'route' || this.hovered.type === 'route-leg')) ||
        (this.routePreviewId !== null) ||
        (this.previewDetourOption !== null) ||
        (this.connectingPreview !== null) ||
        (this.activeConnectStopId !== null) ||
        (this.drawingRoute !== null) ||
        (this.drawingAreaFilter !== null) ||
        (this.drawingArea !== null && this.drawingArea.length > 0) ||
        (this.areaFilterPolygon !== null && !this.hideAreaFilterOutline);

      const hasProposedStops = (this.layers.stopPoints !== false || this.layers.stops !== false) &&
        (!!(this.justCreatedStopId != null && this.store.doc.stops[this.justCreatedStopId]) || this._hasCreatedStops());

      const isAnimating = this.snapBackAnim !== null ||
        (this.invalidPlacement !== null && (performance.now() - this.invalidPlacement.time < 2200)) ||
        (this.snapTarget !== null) ||
        hasProposedStops ||
        isRouteActive;

      if (this.needsRender || isAnimating) {
        this.render();
        this.needsRender = false;
      }

      requestAnimationFrame(this._boundRender);
    }

    // Created bus stops pulse, so the map keeps animating while there are any (checked once per change, not every frame)
    _hasCreatedStops() {
      const st = this.store;
      if (this._createdStopsStore !== st || this._createdStopsRev !== st.rev) {
        this._createdStopsStore = st;
        this._createdStopsRev = st.rev;
        this._createdStops = Object.values(st.doc.stops).some((s) => s.kind === 'proposed' || s.userCreated || s.isNew);
      }
      return this._createdStops;
    }

    // Calls onViewChange shortly after the visible area or what's drawn on it stops changing
    _notifyViewChange() {
      if (!this.onViewChange) return;
      const cam = this.camera;
      const key = [
        Math.round(cam.x), Math.round(cam.y), cam.zoom.toFixed(4), this.width, this.height,
        this.store.rev, this.visibleRouteIds ? this.visibleRouteIds.size : 'all',
        this.timeWindow ? this.timeWindow.from + this.timeWindow.to + (this.timeWindow.days || []).join('') : '',
        this.layers.existingRoutes, this.layers.proposedRoutes,
      ].join('|');
      if (key === this._viewKey) return;
      this._viewKey = key;
      clearTimeout(this._viewTimer);
      this._viewTimer = setTimeout(() => this.onViewChange(), 120);
    }

    _renderBaseMap(targetMapCtx) {
      const dpr = this.dpr;
      // 1. Fast sea & base physical map rendered to targetMapCtx
      targetMapCtx.save();
      targetMapCtx.scale(dpr, dpr);

      // Sea background fill
      targetMapCtx.fillStyle = '#94bdd3';
      targetMapCtx.fillRect(0, 0, this.width, this.height);

      // World matrix transformation for base map
      targetMapCtx.save();
      targetMapCtx.translate(this.width / 2, this.height / 2);
      targetMapCtx.scale(this.camera.zoom, this.camera.zoom);
      targetMapCtx.translate(-this.camera.x, -this.camera.y);

      const vp = this.getViewportBBox();

      // 2. Island terrain & coastline
      if (this.layers.coast) {
        this._renderLandmass(targetMapCtx);
      }

      // 3. Parks & nature reserves
      if (this.layers.parks) {
        this._renderParks(targetMapCtx, vp);
      }

      // 4. Waterways
      if (this.layers.waterways) {
        this._renderWaterways(targetMapCtx, vp);
      }

      // 6. Roads (Ultra-fast batched strokes)
      if (this.layers.roads) {
        this._renderRoads(targetMapCtx, vp);
      }

      // 7. Pedestrian zebra crossings (only at close zoom)
      if (this.layers.crossings && this.camera.zoom > 0.6) {
        this._renderCrossings(targetMapCtx, vp);
      }

      // 8. Buildings (Deprioritized grey, flat 2.5D batch render, ZERO shadowBlur)
      if (this.layers.buildings) {
        this._renderBuildings(targetMapCtx, vp);
      }

      // 15. Road names (the drawing-link page)
      if (this.layers.roadNames) {
        this._renderRoadNames(targetMapCtx, vp);
      }

      // 16. Labels (water & place labels)
      if (this.layers.labels) {
        this._renderLabels(targetMapCtx);
      }

      targetMapCtx.restore(); // end world space on targetMapCtx
      targetMapCtx.restore(); // end dpr scale on targetMapCtx
    }

    render() {
      this._notifyViewChange();
      const ctx = this.ctx;
      const dpr = this.dpr;
      const L = this.layers;
      const cam = this.camera;

      // The base map (land, roads, buildings, labels) only changes with the camera, its layers or the road closures,
      // so it is drawn once into its own canvas and reused by frames that only animate what's on top
      const baseCtx = this.mapCtx;
      const baseKey = baseCtx ? [
        cam.x, cam.y, cam.zoom, this.canvas.width, this.canvas.height, dpr,
        L.coast, L.parks, L.waterways, L.roads, L.crossings, L.buildings, L.roadNames, L.labels,
        this.namesAlways ? 1 : 0, this.store.closedKey,
      ].join('|') : null;
      if (!baseCtx || baseKey !== this._baseKey) {
        this._baseKey = baseKey;
        const targetMapCtx = baseCtx || ctx;
        if (baseCtx) {
          if (this.mapCanvas.width !== this.canvas.width || this.mapCanvas.height !== this.canvas.height) {
            this.mapCanvas.width = this.canvas.width;
            this.mapCanvas.height = this.canvas.height;
          }
          baseCtx.setTransform(1, 0, 0, 1, 0, 0);
        }
        this._renderBaseMap(targetMapCtx);
      }

      const vp = this.getViewportBBox();
      ctx.save();
      ctx.scale(dpr, dpr);

      if (baseCtx) {
        if (this.mapOpacity < 0.999) {
          // Crisp clean light background for subdued map
          ctx.fillStyle = '#f8fafc';
          ctx.fillRect(0, 0, this.width, this.height);
        }
        // Composite the base map at its configured opacity
        if (this.mapOpacity > 0.001) {
          ctx.save();
          ctx.globalAlpha = this.mapOpacity;
          ctx.drawImage(this.mapCanvas, 0, 0, this.width, this.height);
          ctx.restore();
        }
      }

      // 3. World matrix transformation for ITEMS ON MAP (Always 100% full opacity!)
      ctx.save();
      ctx.translate(this.width / 2, this.height / 2);
      ctx.scale(this.camera.zoom, this.camera.zoom);
      ctx.translate(-this.camera.x, -this.camera.y);

      // 8b. Other projects' areas and closures at the same time (under this project's own)
      if (this.foreignObstacles) {
        this._renderForeignObstacles(ctx);
      }

      // 9. Road Closures
      if (this.layers.closures) {
        this._renderRoadClosures(ctx);
      }

      // 10. Affected Areas
      if (this.layers.affectedAreas) {
        this._renderAffectedAreas(ctx);
      }

      // 10b. Timeline: drafts planned for the moment shown, in muted grey
      if (this.timeline) {
        this._renderTimelineDrafts(ctx);
      }

      // 11. Bus Routes (Full opacity)
      if (this.layers.existingRoutes || this.layers.proposedRoutes) {
        this._renderBusRoutes(ctx);
      }

      // 12. Bus Stops (Full opacity)
      if (this.layers.stopPoints !== false || this.layers.stopNames !== false || this.layers.stops) {
        this._renderBusStops(ctx, vp);
      }

      // 12b. MRT stations (on top of the bus stops)
      if (this.layers.mrtStations) {
        this._renderMrtStations(ctx, vp);
      }

      // 12c. Timeline: a tag on each project, red implemented or grey drafting
      if (this.timeline) {
        this._renderTimelineSigns(ctx);
      }

      // 12d. Current Map: a tag with the project behind each affected area (not while previewing the timeline)
      if (this.mapAreaTags && !this.timeline && this.layers.affectedAreas) {
        this._renderNameTags(ctx, this.mapAreaTags);
      }

      // 12e. Other projects in the same time: a tag with each one's name
      if (this.foreignObstacles && this.foreignObstacles.signs && (this.layers.affectedAreas || this.layers.closures)) {
        this._renderNameTags(ctx, this.foreignObstacles.signs);
      }

      // 13. Transient overlays (drafting previews)
      this._renderDraftingOverlays(ctx);

      // 13b. View mode polygon area filter
      this._renderAreaFilter(ctx);

      // 14. Snap-back animation
      this._renderSnapBack(ctx);

      // 15. Invalid placement warning indicator
      this._renderInvalidPlacement(ctx);

      ctx.restore(); // end world space for items

      // Screen-space UI overlays
      this._renderScreenOverlays(ctx);

      ctx.restore(); // end main dpr

      if (typeof this.onRender === 'function') {
        this.onRender();
      }
    }

    _renderLandmass(ctx) {
      const coast = this.city.coast;
      if (!coast || !coast.length) return;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(coast[0].x, coast[0].y);
      for (let i = 1; i < coast.length; i++) ctx.lineTo(coast[i].x, coast[i].y);
      ctx.closePath();

      // Shoreline rim
      ctx.lineWidth = 22;
      ctx.strokeStyle = '#e5dcbe';
      ctx.stroke();

      // Island ground
      ctx.fillStyle = '#edf2ea';
      ctx.fill();

      // Islets
      if (this.city.islets) {
        for (const isl of this.city.islets) {
          ctx.beginPath();
          ctx.moveTo(isl.poly[0].x, isl.poly[0].y);
          for (let i = 1; i < isl.poly.length; i++) ctx.lineTo(isl.poly[i].x, isl.poly[i].y);
          ctx.closePath();
          ctx.lineWidth = 12;
          ctx.strokeStyle = '#e5dcbe';
          ctx.stroke();
          ctx.fillStyle = '#edf2ea';
          ctx.fill();
        }
      }

      // Subtle dashed planning boundary
      if (this.city.boundary) {
        ctx.beginPath();
        ctx.moveTo(this.city.boundary[0].x, this.city.boundary[0].y);
        for (let i = 1; i < this.city.boundary.length; i++) ctx.lineTo(this.city.boundary[i].x, this.city.boundary[i].y);
        ctx.closePath();
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.3)';
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 8]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    _renderParks(ctx, vp) {
      if (!this.city.parks) return;
      ctx.save();

      // Batch parks
      ctx.beginPath();
      for (const pk of this.city.parks) {
        const poly = pk.poly;
        if (!poly || !poly.length) continue;
        ctx.moveTo(poly[0].x, poly[0].y);
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
        ctx.closePath();
      }
      ctx.fillStyle = '#d4e9cf';
      ctx.fill();
      ctx.strokeStyle = '#b7ddb0';
      ctx.lineWidth = 1.8;
      ctx.stroke();

      // Simplified Park paths
      if (this.city.parkPaths) {
        ctx.beginPath();
        for (const path of this.city.parkPaths) {
          ctx.moveTo(path[0].x, path[0].y);
          for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
        }
        ctx.strokeStyle = 'rgba(215, 204, 175, 0.75)';
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      // Sparse trees (only at close zoom, batched)
      if (this.camera.zoom > 0.55 && this.city.trees) {
        ctx.beginPath();
        for (const t of this.city.trees) {
          if (t.x < vp.x0 || t.x > vp.x1 || t.y < vp.y0 || t.y > vp.y1) continue;
          ctx.moveTo(t.x + t.r, t.y);
          ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
        }
        ctx.fillStyle = '#5a9b54';
        ctx.fill();
      }
      ctx.restore();
    }

    _renderWaterways(ctx, vp) {
      ctx.save();
      // Reservoirs
      if (this.city.lakes) {
        ctx.beginPath();
        for (const lk of this.city.lakes) {
          ctx.moveTo(lk.poly[0].x, lk.poly[0].y);
          for (let i = 1; i < lk.poly.length; i++) ctx.lineTo(lk.poly[i].x, lk.poly[i].y);
          ctx.closePath();
        }
        ctx.fillStyle = '#8ec3dc';
        ctx.fill();
        ctx.strokeStyle = '#6ea9c4';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Rivers / Canals
      if (this.city.rivers) {
        for (const riv of this.city.rivers) {
          ctx.beginPath();
          ctx.moveTo(riv.pts[0].x, riv.pts[0].y);
          for (let i = 1; i < riv.pts.length; i++) ctx.lineTo(riv.pts[i].x, riv.pts[i].y);
          ctx.strokeStyle = '#8ec3dc';
          ctx.lineWidth = riv.hw * 2;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke();
        }
      }
      ctx.restore();
    }



    _renderRoads(ctx, vp) {
      const edges = this.city.edges;
      const closures = this.store.doc.closures;
      const zoom = this.camera.zoom;
      ctx.save();

      // Zoomed out over the island: each road one simple stroke, kept a pixel or two wide on screen
      if (zoom < 0.16) {
        const stroke = (major, width, color) => {
          ctx.beginPath();
          for (const e of edges) {
            if ((e.cls === 'major') !== major || !B.bboxOverlap(vp, e.bb)) continue;
            const p = e.lod;
            ctx.moveTo(p[0].x, p[0].y);
            for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
          }
          ctx.lineWidth = width;
          ctx.strokeStyle = color;
          ctx.stroke();
        };
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (zoom > 0.03) stroke(false, Math.max(13, 0.9 / zoom), '#ffffff');
        stroke(true, Math.max(21.6, 2.6 / zoom), '#cbd5e1');
        stroke(true, Math.max(18, 1.8 / zoom), '#ffffff');
        ctx.restore();
        return;
      }
      // Lane markings are worked out for a street the first time it's drawn close up
      const close = zoom >= 0.35;
      if (close) for (const e of edges) if (!e.marked && B.bboxOverlap(vp, e.bb)) this.city.markStreet(e);

      // Pass 1: Curbs (Split into Major and Minor for exact half-width rendering)
      // Major road curbs
      ctx.beginPath();
      for (const e of edges) {
        if (e.cls !== 'major' || !B.bboxOverlap(vp, e.bb)) continue;
        ctx.moveTo(e.pts[0].x, e.pts[0].y);
        for (let i = 1; i < e.pts.length; i++) ctx.lineTo(e.pts[i].x, e.pts[i].y);
      }
      ctx.lineWidth = 21.6;
      ctx.strokeStyle = '#94a3b8'; // Slate curb
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();

      // Minor road curbs
      ctx.beginPath();
      for (const e of edges) {
        if (e.cls === 'major' || !B.bboxOverlap(vp, e.bb)) continue;
        ctx.moveTo(e.pts[0].x, e.pts[0].y);
        for (let i = 1; i < e.pts.length; i++) ctx.lineTo(e.pts[i].x, e.pts[i].y);
      }
      ctx.lineWidth = 16.6;
      ctx.strokeStyle = '#94a3b8';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();

      // Pass 2: Road Surface (Major: 18m width, Minor: 13m width)
      ctx.beginPath();
      for (const e of edges) {
        if (e.cls !== 'major' || !B.bboxOverlap(vp, e.bb) || closures[e.id]) continue;
        ctx.moveTo(e.pts[0].x, e.pts[0].y);
        for (let i = 1; i < e.pts.length; i++) ctx.lineTo(e.pts[i].x, e.pts[i].y);
      }
      ctx.lineWidth = 18;
      ctx.strokeStyle = '#ffffff'; // Clean concrete surface
      ctx.stroke();

      ctx.beginPath();
      for (const e of edges) {
        if (e.cls === 'major' || !B.bboxOverlap(vp, e.bb) || closures[e.id]) continue;
        ctx.moveTo(e.pts[0].x, e.pts[0].y);
        for (let i = 1; i < e.pts.length; i++) ctx.lineTo(e.pts[i].x, e.pts[i].y);
      }
      ctx.lineWidth = 13;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      // Pass 3: Intersections
      ctx.beginPath();
      for (const n of this.city.nodes) {
        if (n.edges.length < 2) continue;
        if (n.x < vp.x0 || n.x > vp.x1 || n.y < vp.y0 || n.y > vp.y1) continue;
        ctx.moveTo(n.x + n.maxHw + 1, n.y);
        ctx.arc(n.x, n.y, n.maxHw + 1, 0, Math.PI * 2);
      }
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      if (!close) {
        ctx.restore();
        return;
      }

      // Pass 4: Center Divider Between 2 Lanes (Crisp Double Continuous Center Lines)
      ctx.beginPath();
      for (const e of edges) {
        if (!B.bboxOverlap(vp, e.bb)) continue;
        if (e.markPtsA && e.markPtsA.length > 1) {
          ctx.moveTo(e.markPtsA[0].x, e.markPtsA[0].y);
          for (let i = 1; i < e.markPtsA.length; i++) ctx.lineTo(e.markPtsA[i].x, e.markPtsA[i].y);
        }
        if (e.markPtsB && e.markPtsB.length > 1) {
          ctx.moveTo(e.markPtsB[0].x, e.markPtsB[0].y);
          for (let i = 1; i < e.markPtsB.length; i++) ctx.lineTo(e.markPtsB[i].x, e.markPtsB[i].y);
        }
      }
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = '#475569'; // Crisp Slate-600 double divider
      ctx.setLineDash([]);
      ctx.stroke();

      // Subtle solid centerline between the double lines to ensure crisp separation at all zooms
      ctx.beginPath();
      for (const e of edges) {
        if (!B.bboxOverlap(vp, e.bb) || !e.markPts) continue;
        ctx.moveTo(e.markPts[0].x, e.markPts[0].y);
        for (let i = 1; i < e.markPts.length; i++) ctx.lineTo(e.markPts[i].x, e.markPts[i].y);
      }
      ctx.lineWidth = 0.9;
      ctx.strokeStyle = 'rgba(71, 85, 105, 0.4)';
      ctx.stroke();

      // Pass 5: Directional Lane Flow Arrows (shows direction: Lane -> intensive / Lane <- lighter)
      if (this.camera.zoom > 0.55) {
        for (const e of edges) {
          if (!B.bboxOverlap(vp, e.bb) || !e.laneArrows) continue;
          for (const arr of e.laneArrows) {
            if (arr.x < vp.x0 || arr.x > vp.x1 || arr.y < vp.y0 || arr.y > vp.y1) continue;
            ctx.save();
            ctx.translate(arr.x, arr.y);
            ctx.rotate(arr.ang);
            ctx.fillStyle = arr.dir > 0 ? 'rgba(30, 58, 138, 0.55)' : 'rgba(96, 165, 250, 0.7)';
            ctx.beginPath();
            ctx.moveTo(4.5, 0);
            ctx.lineTo(-1, -3);
            ctx.lineTo(-1, -1);
            ctx.lineTo(-5, -1);
            ctx.lineTo(-5, 1);
            ctx.lineTo(-1, 1);
            ctx.lineTo(-1, 3);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
        }
      }

      ctx.restore();
    }

    _renderCrossings(ctx, vp) {
      if (!this.city.crossings) return;
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      for (const cr of this.city.crossings) {
        if (cr.x < vp.x0 || cr.x > vp.x1 || cr.y < vp.y0 || cr.y > vp.y1) continue;
        ctx.save();
        ctx.translate(cr.x, cr.y);
        ctx.rotate(cr.ang + Math.PI / 2);
        ctx.fillRect(-6, -3, 12, 6);
        ctx.restore();
      }
      ctx.restore();
    }

    _renderBuildings(ctx, vp) {
      // Blocks are too small to see further out; close up, the streets on screen get theirs built first
      if (this.camera.zoom < 0.22 || !this.city.buildingBatches) return;
      this.city.ensureBuildings(vp);
      const batches = this.city.buildingBatches;
      ctx.save();

      // Pass 1: Crisp stylized flat 2.5D drop shadow (0% blur overhead, 100x faster!)
      ctx.fillStyle = 'rgba(15, 23, 42, 0.09)';
      ctx.beginPath();
      const ox = 3.5, oy = 4.5;
      for (let s = 0; s < 4; s++) {
        const batch = batches[s];
        for (const b of batch) {
          if (!B.bboxOverlap(vp, b.bb)) continue;
          const p = b.poly;
          ctx.moveTo(p[0].x + ox, p[0].y + oy);
          ctx.lineTo(p[1].x + ox, p[1].y + oy);
          ctx.lineTo(p[2].x + ox, p[2].y + oy);
          ctx.lineTo(p[3].x + ox, p[3].y + oy);
          ctx.closePath();
        }
      }
      ctx.fill();

      // Pass 2: Building bodies batched by shade (Only 4 fill calls total!)
      const shades = ['#e2e8f0', '#cbd5e1', '#f1f5f9', '#d8e1ea'];
      for (let s = 0; s < 4; s++) {
        const batch = batches[s];
        ctx.beginPath();
        for (const b of batch) {
          if (!B.bboxOverlap(vp, b.bb)) continue;
          const p = b.poly;
          ctx.moveTo(p[0].x, p[0].y);
          ctx.lineTo(p[1].x, p[1].y);
          ctx.lineTo(p[2].x, p[2].y);
          ctx.lineTo(p[3].x, p[3].y);
          ctx.closePath();
        }
        ctx.fillStyle = shades[s];
        ctx.fill();
      }

      ctx.restore();
    }

    _renderRoadClosures(ctx) {
      const closures = this.store.doc.closures;
      const closedIds = Object.keys(closures);
      if (!closedIds.length) return;

      ctx.save();
      for (const idStr of closedIds) {
        const e = this.net.edge(Number(idStr));
        if (!e) continue;

        ctx.beginPath();
        ctx.moveTo(e.pts[0].x, e.pts[0].y);
        for (let i = 1; i < e.pts.length; i++) ctx.lineTo(e.pts[i].x, e.pts[i].y);

        const isSel = this.selected && this.selected.type === 'closure' && String(this.selected.id) === idStr;
        ctx.lineWidth = e.hw * 2 + (isSel ? 6 : 2);
        ctx.strokeStyle = isSel ? '#b91c1c' : '#ef4444';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();

        ctx.lineWidth = e.hw * 2 - 3;
        ctx.strokeStyle = '#fee2e2';
        ctx.setLineDash([8, 8]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    _renderTimelineDrafts(ctx) {
      const { drafts } = this.timeline;
      const zoom = this.camera.zoom;
      ctx.save();
      if (this.layers.closures) {
        for (const c of drafts.closures) {
          const e = this.net.edge(c.edge);
          if (!e) continue;
          ctx.beginPath();
          ctx.moveTo(e.pts[0].x, e.pts[0].y);
          for (let i = 1; i < e.pts.length; i++) ctx.lineTo(e.pts[i].x, e.pts[i].y);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.lineWidth = e.hw * 2 + 2;
          ctx.strokeStyle = '#94a3b8';
          ctx.stroke();
          ctx.lineWidth = e.hw * 2 - 3;
          ctx.strokeStyle = '#e2e8f0';
          ctx.stroke();
        }
      }
      if (this.layers.affectedAreas) {
        for (const a of drafts.areas) {
          if (!a.poly || a.poly.length < 3) continue;
          ctx.beginPath();
          ctx.moveTo(a.poly[0].x, a.poly[0].y);
          for (let i = 1; i < a.poly.length; i++) ctx.lineTo(a.poly[i].x, a.poly[i].y);
          ctx.closePath();
          ctx.fillStyle = 'rgba(148, 163, 184, 0.22)';
          ctx.fill();
          ctx.lineWidth = 1.5 / zoom;
          ctx.strokeStyle = 'rgba(100, 116, 139, 0.8)';
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    _renderTimelineSigns(ctx) {
      this._renderNameTags(ctx, this.timeline.signs);
    }

    // A pill with the project's name: red when implemented, light grey when drafting
    _renderNameTags(ctx, signs) {
      const zoom = this.camera.zoom;
      ctx.save();
      ctx.font = `700 ${11 / zoom}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const sg of signs) {
        const live = sg.kind === 'live';
        const text = sg.name;
        const w = ctx.measureText(text).width + 14 / zoom;
        const h = 20 / zoom;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.18)';
        this._roundRectPath(ctx, sg.x - w / 2 + 1 / zoom, sg.y - h / 2 + 2 / zoom, w, h, h / 2);
        ctx.fill();
        ctx.fillStyle = live ? '#dc2626' : '#f1f5f9';
        this._roundRectPath(ctx, sg.x - w / 2, sg.y - h / 2, w, h, h / 2);
        ctx.fill();
        if (!live) {
          ctx.lineWidth = 1 / zoom;
          ctx.strokeStyle = '#cbd5e1';
          ctx.stroke();
        }
        ctx.fillStyle = live ? '#ffffff' : '#64748b';
        ctx.fillText(text, sg.x, sg.y + 0.5 / zoom);
      }
      ctx.restore();
    }

    // Other projects' areas and closures in the same time: implemented ones red like this project's own,
    // ones not implemented yet in grey (a click, or the tag, names them)
    _renderForeignObstacles(ctx) {
      const fo = this.foreignObstacles;
      const zoom = this.camera.zoom;
      ctx.save();
      if (this.layers.closures) {
        for (const c of fo.closures) {
          const e = this.net.edge(c.edge);
          if (!e) continue;
          const picked = this.hoveredForeign === c;
          const draft = c.kind === 'draft';
          ctx.beginPath();
          ctx.moveTo(e.pts[0].x, e.pts[0].y);
          for (let i = 1; i < e.pts.length; i++) ctx.lineTo(e.pts[i].x, e.pts[i].y);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.lineWidth = e.hw * 2 + (picked ? 6 : 2);
          ctx.strokeStyle = draft ? (picked ? '#475569' : '#94a3b8') : (picked ? '#b91c1c' : '#ef4444');
          ctx.stroke();
          ctx.lineWidth = e.hw * 2 - 3;
          ctx.strokeStyle = draft ? '#e2e8f0' : '#fee2e2';
          if (!draft) ctx.setLineDash([8, 8]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      if (this.layers.affectedAreas) {
        for (const a of fo.areas) {
          if (!a.poly || a.poly.length < 3) continue;
          const picked = this.hoveredForeign === a;
          ctx.beginPath();
          ctx.moveTo(a.poly[0].x, a.poly[0].y);
          for (let i = 1; i < a.poly.length; i++) ctx.lineTo(a.poly[i].x, a.poly[i].y);
          ctx.closePath();
          if (a.kind === 'draft') {
            ctx.fillStyle = picked ? 'rgba(100, 116, 139, 0.3)' : 'rgba(148, 163, 184, 0.22)';
            ctx.fill();
            ctx.lineWidth = (picked ? 2.2 : 1.5) / zoom;
            ctx.strokeStyle = 'rgba(100, 116, 139, 0.8)';
            ctx.stroke();
          } else {
            ctx.fillStyle = picked ? 'rgba(239, 68, 68, 0.32)' : 'rgba(239, 68, 68, 0.2)';
            ctx.fill();
            ctx.lineWidth = picked ? 3 : 2;
            ctx.strokeStyle = '#dc2626';
            ctx.setLineDash([8, 6]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }
      ctx.restore();
    }

    _renderAffectedAreas(ctx) {
      const areas = Object.values(this.store.doc.areas);
      if (!areas.length) return;

      ctx.save();
      for (const a of areas) {
        const poly = this.store.areaPoly(a);
        const isSel = this.selected && this.selected.type === 'area' && this.selected.id === a.id;

        ctx.beginPath();
        ctx.moveTo(poly[0].x, poly[0].y);
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
        ctx.closePath();

        ctx.fillStyle = isSel ? 'rgba(239, 68, 68, 0.32)' : 'rgba(239, 68, 68, 0.2)';
        ctx.fill();

        ctx.lineWidth = isSel ? 3 : 2;
        ctx.strokeStyle = '#dc2626';
        ctx.setLineDash([8, 6]);
        ctx.stroke();
        ctx.setLineDash([]);



        if (isSel) {
          this._renderAreaHandles(ctx, a, poly);
        }
      }
      ctx.restore();
    }

    _renderAreaHandles(ctx, a, poly) {
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 2.5;

      if (a.shape === 'circle') {
        const rx = a.cx + a.r, ry = a.cy;
        ctx.beginPath();
        ctx.arc(rx, ry, 6 / this.camera.zoom, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();

        ctx.beginPath();
        ctx.arc(a.cx, a.cy, 7 / this.camera.zoom, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      } else {
        poly.forEach((pt) => {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 6 / this.camera.zoom, 0, Math.PI * 2);
          ctx.fill(); ctx.stroke();
        });

        const c = B.centroid(poly);
        ctx.beginPath();
        ctx.arc(c.x, c.y, 7 / this.camera.zoom, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }

    _renderBusRoutes(ctx) {
      const routes = Object.values(this.store.doc.routes);
      ctx.save();

      // Every route record with the same bus number is one line: shared lane, highlight and style
      const lineOf = (r) => String(r.number).trim();
      const runningLines = this.timeWindow ? B.runningBusNumbers(this.store.doc, this.timeWindow.from, this.timeWindow.to, this.timeWindow.days) : null;
      const lineOfId = (rid) => {
        const rr = rid ? this.store.doc.routes[rid] : null;
        return rr ? lineOf(rr) : null;
      };
      const selectedLine = this.selected && (this.selected.type === 'route' || this.selected.type === 'route-leg')
        ? lineOfId(this.selected.type === 'route' ? this.selected.id : this.selected.routeId) : null;
      const hoveredLine = this.hovered && (this.hovered.type === 'route' || this.hovered.type === 'route-leg')
        ? lineOfId(this.hovered.type === 'route' ? this.hovered.id : this.hovered.routeId) : null;
      const previewLine = lineOfId(this.routePreviewId);
      const linkingLine = this.activeConnectStopId ? lineOfId(this.activeConnectRouteId) : null;
      const proposedLines = new Set(routes.filter((r) => r.kind === 'proposed').map(lineOf));

      const sorted = routes.slice().sort((a, b) => {
        const aActive = [selectedLine, hoveredLine, previewLine].includes(lineOf(a));
        const bActive = [selectedLine, hoveredLine, previewLine].includes(lineOf(b));
        if (aActive !== bActive) return aActive ? 1 : -1;
        if ((a.kind === 'proposed') !== (b.kind === 'proposed')) return a.kind === 'proposed' ? 1 : -1;
        return 0;
      });
      const now = performance.now();
      const dashPeriod = 24;
      const dashOffset = -((now * 0.05) % dashPeriod);

      const hasActiveRouteSel = Boolean(
        (this.selected && (this.selected.type === 'route' || this.selected.type === 'route-leg')) ||
        (this.hovered && (this.hovered.type === 'route' || this.hovered.type === 'route-leg')) ||
        this.routePreviewId
      );

      // Lanes only change with the map or the buses shown, so they're kept between frames. Each bus line is
      // shifted onto its lanes only once it's drawn close up (further out the shift is under a pixel), and kept.
      const tw = this.timeWindow;
      const laneKey = [this.store.rev, this.layers.existingRoutes, this.layers.proposedRoutes,
        tw ? tw.from + tw.to + (tw.days || []).join('') : ''].join('|');
      let lanes = this._laneCache;
      if (!lanes || lanes.key !== laneKey || lanes.store !== this.store || lanes.visible !== this.visibleRouteIds) {
        lanes = this._laneCache = { key: laneKey, store: this.store, visible: this.visibleRouteIds, laneSlot: null, laid: new Map() };
      }
      // Each line's slot on every lane it shares, worked out the first time a bus is drawn close up
      const slotsOn = () => {
        if (lanes.laneSlot) return lanes.laneSlot;
        // Bus lines on each road lane (edge + travel direction), so lines sharing any stretch of road sit side by side
        const laneUsage = new Map();
        for (const r of routes) {
          if (r.kind === 'proposed' ? !this.layers.proposedRoutes : !this.layers.existingRoutes) continue;
          if (this.visibleRouteIds && !this.visibleRouteIds.has(r.id)) continue;
          if (runningLines && !runningLines.has(lineOf(r))) continue;
          const g = this.store.geom[r.id];
          if (!g || !g.legs) continue;
          for (const leg of g.legs) {
            if (!leg.ok || !leg.segs) continue;
            for (const sg of leg.segs) {
              const key = `${sg.edge}:${sg.dir}`;
              let set = laneUsage.get(key);
              if (!set) laneUsage.set(key, (set = new Set()));
              set.add(lineOf(r));
            }
          }
        }
        // Bus-number order, a full line-width apart, so the same lines always line up the same way
        const LANE_SEP = 6.5;
        const laneSlot = new Map();
        for (const [key, set] of laneUsage) {
          const ordered = [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          const slots = new Map();
          ordered.forEach((line, i) => slots.set(line, (i - (ordered.length - 1) / 2) * LANE_SEP));
          laneSlot.set(key, slots);
        }
        return (lanes.laneSlot = laneSlot);
      };
      // A route's legs, shifted onto its lanes when close up, with a box round them
      const layOut = (r, shift) => {
        const cacheKey = r.id + (shift ? '|s' : '');
        let laid = lanes.laid.get(cacheKey);
        if (laid) return laid;
        const line = lineOf(r);
        const legs = this.store.geom[r.id].legs.map((leg) => {
          if (!shift || !leg.ok || !leg.pts || leg.pts.length < 2) return leg;
          const laneSlot = slotsOn();
          const offsets = leg.pts.map((p) => {
            if (!p.lane) return null;
            const slots = laneSlot.get(p.lane);
            return (slots && slots.get(line)) || 0;
          });
          if (offsets.every((o) => !o)) return leg;
          // Corner points (between two lanes) blend from the slot before to the slot after
          for (let i = 0; i < offsets.length; i++) {
            if (offsets[i] !== null) continue;
            let next = i;
            while (next < offsets.length && offsets[next] === null) next++;
            const from = i > 0 ? offsets[i - 1] : (next < offsets.length ? offsets[next] : 0);
            const to = next < offsets.length ? offsets[next] : from;
            for (let j = i; j < next; j++) offsets[j] = from + (to - from) * ((j - i + 1) / (next - i + 1));
            i = next - 1;
          }
          return { ...leg, pts: offsetPolyline(leg.pts, offsets) };
        });
        // Far out, every 4th point is plenty
        const drawn = shift ? legs : legs.map((leg) => (leg.ok && leg.pts && leg.pts.length > 6
          ? { ...leg, pts: leg.pts.filter((p, i) => i % 4 === 0 || i === leg.pts.length - 1) } : leg));
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const l of drawn) {
          if (!l.ok || !l.pts) continue;
          for (const p of l.pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
        }
        laid = { legs: drawn, bb: x0 <= x1 ? { x0: x0 - 12, y0: y0 - 12, x1: x1 + 12, y1: y1 + 12 } : null };
        lanes.laid.set(cacheKey, laid);
        return laid;
      };
      const shiftLanes = this.camera.zoom >= 0.1;
      const vp = this.getViewportBBox();
      const px = 1 / this.camera.zoom;

      for (const r of sorted) {
        const isProposed = r.kind === 'proposed';
        if (isProposed && !this.layers.proposedRoutes) continue;
        if (!isProposed && !this.layers.existingRoutes) continue;
        if (this.visibleRouteIds && !this.visibleRouteIds.has(r.id)) continue;
        if (runningLines && !runningLines.has(lineOf(r))) continue;

        const g = this.store.geom[r.id];
        if (!g || !g.legs) continue;

        const isSel = selectedLine !== null && selectedLine === lineOf(r);
        const isHov = hoveredLine !== null && hoveredLine === lineOf(r);
        const isPreview = isSel || isHov || (previewLine !== null && previewLine === lineOf(r));
        // Draw every piece of a bus in the same style, so a partly proposed bus reads as one line
        const lineProposed = proposedLines.has(lineOf(r));

        // If area filter is active on map, dim or filter routes that do not pass through the area
        const isAreaFilterActive = this.areaFilterPolygon && this.areaFilterPassingIds;
        const passesArea = isAreaFilterActive ? this.areaFilterPassingIds.has(r.id) : true;
        const isSelectedInAreaFilter = isAreaFilterActive && this.areaFilterSelectedRouteIds ? this.areaFilterSelectedRouteIds.has(r.id) : passesArea;

        if (isAreaFilterActive && this.filterMapToArea && !isSelectedInAreaFilter) {
          ctx.globalAlpha = 0.08;
        } else {
          // In view mode: dim other routes when a bus route is selected or hovered so the clicked bus line clearly stands out across the whole island
          const shouldDim = (this.mode === 'view' || !this.mode) && hasActiveRouteSel && !isPreview;
          ctx.globalAlpha = shouldDim ? 0.32 : 1.0;
        }

        // Never thinner than a pixel or two on screen, however far out
        const lineWidth = Math.max(isSel ? 10.5 : (isHov ? 8.5 : (lineProposed ? 7 : 6)), (isSel ? 4 : (isHov ? 3.2 : 1.6)) * px);

        const laid = layOut(r, shiftLanes);
        if (!laid.bb || !B.bboxOverlap(vp, laid.bb)) continue;
        const processedLegs = laid.legs;

        const tracePath = () => {
          ctx.beginPath();
          for (const leg of processedLegs) {
            if (!leg.ok || !leg.pts || leg.pts.length < 2) continue;
            ctx.moveTo(leg.pts[0].x, leg.pts[0].y);
            for (let i = 1; i < leg.pts.length; i++) ctx.lineTo(leg.pts[i].x, leg.pts[i].y);
          }
        };

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([]);

        // Thin white outline keeps neighbouring and crossing bus lines visibly apart (close up, or the bus picked out)
        if (shiftLanes || isPreview) {
          ctx.lineWidth = lineWidth + Math.max(2, 0.8 * px);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
          tracePath();
          ctx.stroke();
        }

        // 1b. Draw base road route line: preserve each route's distinct color
        ctx.lineWidth = lineWidth;
        const routeColor = r.color || (isProposed ? '#059669' : '#2563eb');
        ctx.strokeStyle = routeColor;
        tracePath();
        ctx.stroke();

        // 2. Moving animated dash track while the bus is hovered or being linked; otherwise it draws solid
        const isBeingLinked = linkingLine !== null && linkingLine === lineOf(r);
        const isHoverPreview = isHov || (previewLine !== null && previewLine === lineOf(r));
        if (isPreview || isBeingLinked) {
          if (isBeingLinked || isHoverPreview) {
            ctx.save();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(2.6, lineWidth * 0.44);
            ctx.lineCap = 'round';
            ctx.setLineDash([14, 10]);
            ctx.lineDashOffset = dashOffset;

            ctx.beginPath();
            for (const leg of processedLegs) {
              if (!leg.ok || !leg.pts || !leg.pts.length) continue;
              ctx.moveTo(leg.pts[0].x, leg.pts[0].y);
              for (let i = 1; i < leg.pts.length; i++) ctx.lineTo(leg.pts[i].x, leg.pts[i].y);
            }
            ctx.stroke();
            ctx.restore();
          }

          // Highlight specific selected route leg / line segment (only in edit mode, NEVER in view mode)
          if (this.mode !== 'view' && this.selected && this.selected.type === 'route-leg' && this.selected.routeId === r.id) {
            const selLeg = processedLegs[this.selected.legIndex];
            if (selLeg && selLeg.ok && selLeg.pts && selLeg.pts.length > 1) {
              ctx.save();
              ctx.strokeStyle = '#ef4444';
              ctx.lineWidth = lineWidth + 5;
              ctx.lineCap = 'round';
              ctx.lineJoin = 'round';
              ctx.setLineDash([8, 6]);
              ctx.lineDashOffset = -dashOffset * 1.5;
              ctx.beginPath();
              ctx.moveTo(selLeg.pts[0].x, selLeg.pts[0].y);
              for (let i = 1; i < selLeg.pts.length; i++) ctx.lineTo(selLeg.pts[i].x, selLeg.pts[i].y);
              ctx.stroke();

              ctx.strokeStyle = '#ffffff';
              ctx.lineWidth = Math.max(3, lineWidth * 0.5);
              ctx.setLineDash([]);
              ctx.stroke();
              ctx.restore();
            }
          }

          // 3. Directional forward chevrons along the route
          ctx.save();
          for (const leg of processedLegs) {
            if (!leg.ok || !leg.pts) continue;
            let cumDist = 0;
            for (let i = 1; i < leg.pts.length; i++) {
              const pA = leg.pts[i - 1], pB = leg.pts[i];
              const d = Math.hypot(pB.x - pA.x, pB.y - pA.y);
              cumDist += d;
              if (cumDist > 75) {
                cumDist = 0;
                const ang = Math.atan2(pB.y - pA.y, pB.x - pA.x);
                ctx.save();
                ctx.translate(pB.x, pB.y);
                ctx.rotate(ang);
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.moveTo(4.5, 0);
                ctx.lineTo(-4, -3.5);
                ctx.lineTo(-2, 0);
                ctx.lineTo(-4, 3.5);
                ctx.closePath();
                ctx.fill();
                ctx.restore();
              }
            }
          }
          ctx.restore();
        }

        // Route badge: close up, or for the bus picked out (hundreds of badges would bury the map further out)
        if ((this.camera.zoom >= 0.3 || isPreview) && processedLegs[0] && processedLegs[0].pts && processedLegs[0].pts.length) {
          const midLeg = processedLegs[Math.floor(processedLegs.length / 2)];
          if (midLeg && midLeg.pts && midLeg.pts.length) {
            const pt = midLeg.pts[Math.floor(midLeg.pts.length / 2)];
            const badgeColor = routeColor;
            this._renderRouteBadge(ctx, pt, r.number, badgeColor, isProposed, isSel, r);
          }
        }
      }
      ctx.restore();
    }

    _renderRouteBadge(ctx, pt, number, color, isProposed, isSel, routeObj = null) {
      ctx.save();
      ctx.font = 'bold 12px sans-serif';
      const text = (isProposed && routeObj && routeObj.isDetour) ? ('DETOUR ' + number) : (number ? ('Bus ' + number) : 'Bus');
      const tw = ctx.measureText(text).width;
      const pad = 7;
      const bx = pt.x - tw / 2 - pad;
      const by = pt.y - 10;
      const bw = tw + pad * 2;
      const bh = 20;

      ctx.fillStyle = color;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 6);
        ctx.fill();
        if (isSel) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
      } else {
        ctx.fillRect(bx, by, bw, bh);
        if (isSel) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2.5;
          ctx.strokeRect(bx, by, bw, bh);
        }
      }

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, pt.x, pt.y);
      ctx.restore();
    }

    _renderBusStops(ctx, vp) {
      const showPoints = (this.layers.stopPoints !== false && this.layers.stops !== false);
      const showNames = (this.layers.stopNames !== false);

      if (!showPoints && !showNames) return;

      const isAreaFilterActive = (this.areaFilterPolygon && this.areaFilterPassingIds && this.filterMapToArea);
      // Once the drawn area is hidden, the filtered buses' stops stay bright instead of the stops inside it
      let filteredStopIds = null;
      if (isAreaFilterActive && this.hideAreaFilterOutline) {
        filteredStopIds = new Set();
        for (const rid of (this.areaFilterSelectedRouteIds || this.areaFilterPassingIds)) {
          const r = this.store.doc.routes[rid];
          for (const a of (r && r.anchors) || []) {
            if (a.t === 'stop') filteredStopIds.add(a.id);
          }
        }
      }
      const zoom = this.camera.zoom;
      const stops = this.visibleStops();
      // While linking a bus: the stops it can't use
      const blocked = this.getBlockedStops ? this.getBlockedStops() : null;
      ctx.save();

      for (const st of stops) {
        const pt = this.stopPoint(st);
        if (pt.x < vp.x0 || pt.x > vp.x1 || pt.y < vp.y0 || pt.y > vp.y1) continue;

        const isInsideFilter = !isAreaFilterActive ? true
          : (filteredStopIds ? filteredStopIds.has(st.id) : window.B.pointInPoly(pt, this.areaFilterPolygon));
        if (isAreaFilterActive && !isInsideFilter) {
          ctx.globalAlpha = 0.22;
        } else {
          ctx.globalAlpha = 1.0;
        }

        const isSel = this.selected && this.selected.type === 'stop' && this.selected.id === st.id;
        const isHov = this.hovered && this.hovered.type === 'stop' && this.hovered.id === st.id;
        const isConnectingOrigin = this.activeConnectStopId === st.id;
        const isCreated = st.kind === 'proposed' || st.userCreated || st.isNew || (this.justCreatedStopId === st.id);
        // Latest-move pulse: connecting origin, or the bus stop just created (when no connection is in progress)
        const isLatestMove = isConnectingOrigin || (!this.activeConnectStopId && this.justCreatedStopId === st.id);

        if (showPoints || isSel || isHov || isConnectingOrigin || isCreated) {
          // Scale marker to maintain a crisp, punchy, high-visibility screen presence at ANY zoom
          const baseScreenR = isCreated ? 7.5 : 6.5;
          const screenR = isSel ? 9.5 : (isHov ? 8.5 : (isConnectingOrigin ? 9.5 : baseScreenR));
          const radius = screenR / zoom;
          const strokeW = (isSel ? 2.6 : (isCreated ? 2.2 : 2.0)) / zoom;

          // Animated indicator: every proposed bus stop pulses; the latest move (just created / connecting origin) pulses strongest
          if (isLatestMove || isCreated) {
            const strong = isLatestMove;
            const now = performance.now();
            const pulse = (Math.sin(now / 220) + 1) * 0.5; // 0 to 1 smooth breathing wave
            const rInner = radius + ((strong ? 4.0 : 2.5) + pulse * (strong ? 3.5 : 2.5)) / zoom;
            const rOuter = radius + ((strong ? 7.5 : 5.0) + pulse * (strong ? 5.0 : 4.0)) / zoom;

            // Inner pulsing halo (emerald green, matches created bus stop)
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, rInner, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(16, 185, 129, ${strong ? 0.16 + pulse * 0.16 : 0.1 + pulse * 0.1})`;
            ctx.fill();
            ctx.strokeStyle = strong ? '#059669' : 'rgba(5, 150, 105, 0.55)';
            ctx.lineWidth = (strong ? 2.2 + pulse * 0.5 : 1.4) / zoom;
            ctx.stroke();

            // Expanding radar beacon wave ring
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, rOuter, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(16, 185, 129, ${(strong ? 0.5 : 0.35) * (1 - pulse)})`;
            ctx.lineWidth = 1.6 / zoom;
            ctx.stroke();
          }

          // Soft drop shadow around the standalone bus stop marker
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, radius + 1.2 / zoom, 0, Math.PI * 2);
          ctx.fillStyle = isCreated ? 'rgba(6, 78, 59, 0.35)' : 'rgba(15, 23, 42, 0.3)';
          ctx.fill();

          // Main bus stop circle:
          // Check bus lines serving this stop (one per bus number)
          const servedRouteIds = (this.store.stopLines && this.store.stopLines[st.id]) || [];
          const servedRoutes = servedRouteIds.map((rid) => this.store.doc.routes[rid]).filter(Boolean);

          if (st.active === false) {
            // Not active: a plain grey dot
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = '#94a3b8';
            ctx.fill();
            ctx.lineWidth = strokeW;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, radius * 0.38, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
          } else if (servedRoutes.length > 1) {
            // MULTI-ROUTE TRANSIT HUB DOT:
            // One bus stop serving more than 1 bus number!
            // Segmented multi-color circle showing each bus route color
            const slice = (Math.PI * 2) / servedRoutes.length;
            for (let i = 0; i < servedRoutes.length; i++) {
              const startAng = -Math.PI / 2 + i * slice;
              const endAng = startAng + slice;
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, radius, startAng, endAng);
              ctx.lineTo(pt.x, pt.y);
              ctx.fillStyle = servedRoutes[i].color || '#2563eb';
              ctx.fill();
            }
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
            ctx.lineWidth = strokeW;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();

            // Transit stop central bullseye dot
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, radius * 0.42, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
          } else {
            const stopColor = servedRoutes[0]?.color || (isCreated ? '#10b981' : '#2563eb');
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = stopColor;
            ctx.fill();
            ctx.lineWidth = strokeW;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();

            // Transit stop central bullseye dot
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, radius * (isCreated ? 0.45 : 0.38), 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();

            if (isCreated) {
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, radius * 0.22, 0, Math.PI * 2);
              ctx.fillStyle = '#065f46';
              ctx.fill();
            }
          }

          // The bus being linked can't use this stop: a red dot with a white ×
          if (blocked && blocked.has(st.id)) {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, radius + 0.5 / zoom, 0, Math.PI * 2);
            ctx.fillStyle = '#dc2626';
            ctx.fill();
            ctx.lineWidth = strokeW;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
            const k = radius * 0.45;
            ctx.beginPath();
            ctx.moveTo(pt.x - k, pt.y - k);
            ctx.lineTo(pt.x + k, pt.y + k);
            ctx.moveTo(pt.x + k, pt.y - k);
            ctx.lineTo(pt.x - k, pt.y + k);
            ctx.lineWidth = 2.2 / zoom;
            ctx.lineCap = 'round';
            ctx.stroke();
          }
        }

        if (showNames && (isSel || isHov || zoom > 0.42 || isConnectingOrigin || isCreated)) {
          this._renderStopLabel(ctx, pt, st, isSel || isHov || isConnectingOrigin);
        }
        ctx.globalAlpha = 1.0;
      }
      ctx.restore();
    }


    // The MRT logo at a fixed screen size, with the station name under it once zoomed in
    // The stops drawn at this zoom: all of them close up; zoomed out, thousands would be a carpet of dots,
    // so only the ones picked out or just made
    visibleStops() {
      if (!this._allStops || this._allStops.doc !== this.store.doc || this._allStops.rev !== this.store.rev) {
        this._allStops = { doc: this.store.doc, rev: this.store.rev, list: Object.values(this.store.doc.stops) };
      }
      const all = this._allStops.list;
      if (this.camera.zoom >= 0.18) return all;
      const sel = this.selected, hov = this.hovered;
      return all.filter((st) => st.kind === 'proposed' || st.userCreated || st.isNew || st.id === this.justCreatedStopId ||
        st.id === this.activeConnectStopId || (sel && sel.type === 'stop' && sel.id === st.id) || (hov && hov.type === 'stop' && hov.id === st.id));
    }

    // A stop's point by the kerb, worked out once and kept until the stop moves
    stopPoint(st) {
      const cache = this._stopPts || (this._stopPts = new WeakMap());
      let pt = cache.get(st);
      if (!pt || pt.edge !== st.edge || pt.s !== st.s || pt.dir !== st.dir) {
        pt = { ...this.net.posPoint(st, 0.78), edge: st.edge, s: st.s, dir: st.dir };
        cache.set(st, pt);
      }
      return pt;
    }

    _renderMrtStations(ctx, vp) {
      const stations = this.city.mrtStations || [];
      const img = this.mrtImg;
      if (!stations.length || !img || !img.complete || !img.naturalWidth) return;
      const zoom = this.camera.zoom;
      const ratio = img.naturalHeight / img.naturalWidth;
      ctx.save();
      for (const m of stations) {
        if (m.x < vp.x0 - 200 || m.x > vp.x1 + 200 || m.y < vp.y0 - 200 || m.y > vp.y1 + 200) continue;
        const isSel = this.selected && this.selected.type === 'mrt' && this.selected.id === m.id;
        const isHov = this.hovered && this.hovered.type === 'mrt' && this.hovered.id === m.id;
        const w = (isSel || isHov ? 46 : (zoom < 0.08 ? 24 : 38)) / zoom;
        const h = w * ratio;

        // Soft shadow, then a white outline when picked so it stands off the bus lines
        ctx.fillStyle = 'rgba(15, 23, 42, 0.22)';
        this._roundRectPath(ctx, m.x - w / 2 + 1 / zoom, m.y - h / 2 + 2 / zoom, w, h, h / 2);
        ctx.fill();
        if (isSel || isHov) {
          ctx.fillStyle = '#ffffff';
          const o = 3 / zoom;
          this._roundRectPath(ctx, m.x - w / 2 - o, m.y - h / 2 - o, w + o * 2, h + o * 2, h / 2 + o);
          ctx.fill();
        }
        ctx.drawImage(img, m.x - w / 2, m.y - h / 2, w, h);

        if (zoom > 0.3 || isSel || isHov) {
          const fs = 11 / zoom;
          ctx.font = `800 ${fs}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          const ty = m.y + h / 2 + 3 / zoom;
          ctx.lineWidth = 3 / zoom;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
          ctx.lineJoin = 'round';
          ctx.strokeText(m.name, m.x, ty);
          ctx.fillStyle = '#00413f';
          ctx.fillText(m.name, m.x, ty);
        }
      }
      ctx.restore();
    }

    _roundRectPath(ctx, x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }

    _renderStopLabel(ctx, pt, st, active) {
      const zoom = this.camera.zoom;
      ctx.save();
      const fontSize = Math.max(10, 11 / zoom);
      ctx.font = `bold ${fontSize}px sans-serif`;
      const isCreated = st.kind === 'proposed' || st.userCreated || st.isNew || (this.justCreatedStopId === st.id);

      const servedRouteIds = (this.store.stopLines && this.store.stopLines[st.id]) || [];
      const servedRoutes = servedRouteIds.map((rid) => this.store.doc.routes[rid]).filter(Boolean);
      const busNums = servedRoutes.map((r) => r.number).filter(Boolean);
      const busText = busNums.length > 0 ? ` • Bus ${busNums.join(', ')}` : '';

      const text = `${st.name} [${st.code || st.id}]${busText}`;
      const tw = ctx.measureText(text).width;
      const h = 18 / zoom;
      const pad = 6 / zoom;
      const yOffset = 24 / zoom;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.fillRect(pt.x - tw / 2 - pad + 1 / zoom, pt.y - yOffset + 1 / zoom, tw + pad * 2, h);

      ctx.fillStyle = active
        ? 'rgba(15, 23, 42, 0.95)'
        : (isCreated ? 'rgba(236, 253, 245, 0.98)' : 'rgba(255, 255, 255, 0.95)');
      ctx.fillRect(pt.x - tw / 2 - pad, pt.y - yOffset, tw + pad * 2, h);

      ctx.strokeStyle = active
        ? '#38bdf8'
        : (isCreated ? '#10b981' : '#cbd5e1');
      ctx.lineWidth = (isCreated ? 1.8 : 1.2) / zoom;
      ctx.strokeRect(pt.x - tw / 2 - pad, pt.y - yOffset, tw + pad * 2, h);

      ctx.fillStyle = active
        ? '#ffffff'
        : (isCreated ? '#065f46' : '#0f172a');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, pt.x, pt.y - yOffset + h / 2);
      ctx.restore();
    }

    _renderDraftingOverlays(ctx) {
      if (this.snapTarget) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(this.snapTarget.x, this.snapTarget.y, 7 / this.camera.zoom, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.6)';
        ctx.fill();
        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }


      // Affected Area in progress: drawn like the area filter, in red
      if (this.drawingArea && this.drawingArea.length) {
        const pts = this.drawingArea;
        const zoom = this.camera.zoom;
        const preview = this.drawingAreaPreview;
        const trace = (close) => {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          if (preview) ctx.lineTo(preview.x, preview.y);
          if (close) ctx.closePath();
        };
        ctx.save();

        // Light red fill once there is a shape
        if (pts.length >= 2) {
          trace(true);
          ctx.fillStyle = 'rgba(239, 68, 68, 0.10)';
          ctx.fill();
        }

        // Moving dashed outline up to the cursor
        trace(false);
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = Math.max(2, 2.5 / zoom);
        ctx.setLineDash([8 / zoom, 6 / zoom]);
        ctx.lineDashOffset = -((performance.now() * 0.04) % (14 / zoom));
        ctx.stroke();
        ctx.setLineDash([]);

        // Corner dots; the first one is ringed once clicking it would close the shape
        for (let i = 0; i < pts.length; i++) {
          const closable = i === 0 && pts.length >= 3;
          ctx.beginPath();
          ctx.arc(pts[i].x, pts[i].y, (closable ? 7 : 5) / zoom, 0, Math.PI * 2);
          ctx.fillStyle = closable ? '#ffffff' : '#ef4444';
          ctx.fill();
          ctx.strokeStyle = closable ? '#ef4444' : '#ffffff';
          ctx.lineWidth = (closable ? 2.5 : 1.5) / zoom;
          ctx.stroke();
        }
        ctx.restore();
      }

      if (this.drawingRoute && this.drawingRoute.length) {
        ctx.save();
        const now = performance.now();
        const dashOffset = -((now / 22) % 24);

        // 1. Base route tube casing
        ctx.strokeStyle = '#047857';
        ctx.lineWidth = 8.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([]);
        for (let i = 0; i < this.drawingRoute.length - 1; i++) {
          const fromA = this.drawingRoute[i];
          const toA = this.drawingRoute[i + 1];
          const fromP = fromA.t === 'stop' ? (this.store.doc.stops[fromA.id] || fromA) : fromA;
          const toP = toA.t === 'stop' ? (this.store.doc.stops[toA.id] || toA) : toA;
          const l = this.net.route(fromP, toP);
          if (l.ok && l.pts.length) {
            ctx.beginPath();
            ctx.moveTo(l.pts[0].x, l.pts[0].y);
            for (let k = 1; k < l.pts.length; k++) ctx.lineTo(l.pts[k].x, l.pts[k].y);
            ctx.stroke();
          }
        }

        // 2. Animated moving dashes
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.8;
        ctx.setLineDash([12, 10]);
        ctx.lineDashOffset = dashOffset;
        for (let i = 0; i < this.drawingRoute.length - 1; i++) {
          const fromA = this.drawingRoute[i];
          const toA = this.drawingRoute[i + 1];
          const fromP = fromA.t === 'stop' ? (this.store.doc.stops[fromA.id] || fromA) : fromA;
          const toP = toA.t === 'stop' ? (this.store.doc.stops[toA.id] || toA) : toA;
          const l = this.net.route(fromP, toP);
          if (l.ok && l.pts.length) {
            ctx.beginPath();
            ctx.moveTo(l.pts[0].x, l.pts[0].y);
            for (let k = 1; k < l.pts.length; k++) ctx.lineTo(l.pts[k].x, l.pts[k].y);
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      // Connecting bus stop live flexible travel line preview
      if (this.connectingPreview) {
        const { fromStop, toStop, leg, valid, reason, worldCursor } = this.connectingPreview;
        ctx.save();

        // 1. Origin stop highlight already rendered crisply via isConnectingOrigin on latest move
        // 2. Road path between origin stop and target bus stop dot only
        if (valid && toStop && leg && leg.pts && leg.pts.length > 1) {
          const now = performance.now();
          const dashOffset = -((now / 22) % 24);

          // Outer tube casing along roads with uniform proposed color
          ctx.lineWidth = 9;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(leg.pts[0].x, leg.pts[0].y);
          for (let i = 1; i < leg.pts.length; i++) ctx.lineTo(leg.pts[i].x, leg.pts[i].y);
          ctx.strokeStyle = '#0284c7';
          ctx.stroke();

          // Active bright white moving dashed travel line
          ctx.beginPath();
          ctx.moveTo(leg.pts[0].x, leg.pts[0].y);
          for (let i = 1; i < leg.pts.length; i++) ctx.lineTo(leg.pts[i].x, leg.pts[i].y);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.setLineDash([13, 10]);
          ctx.lineDashOffset = dashOffset;
          ctx.stroke();
          ctx.setLineDash([]);

          // Target bus stop highlight target ring (preserves stop's multi-route colors)
          const endPt = this.net.posPoint(toStop, 0.78);
          ctx.beginPath();
          ctx.arc(endPt.x, endPt.y, 9.5 / this.camera.zoom, 0, Math.PI * 2);
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 2.8 / this.camera.zoom;
          ctx.stroke();

          // Directional flow pulse / arrow indicators every ~80m
          let cumDist = 0;
          for (let i = 1; i < leg.pts.length; i++) {
            const pA = leg.pts[i - 1], pB = leg.pts[i];
            const d = Math.hypot(pB.x - pA.x, pB.y - pA.y);
            cumDist += d;
            if (cumDist > 75) {
              cumDist = 0;
              const ang = Math.atan2(pB.y - pA.y, pB.x - pA.x);
              ctx.save();
              ctx.translate(pB.x, pB.y);
              ctx.rotate(ang);
              ctx.fillStyle = '#ffffff';
              ctx.beginPath();
              ctx.moveTo(4, 0);
              ctx.lineTo(-4, -3);
              ctx.lineTo(-2, 0);
              ctx.lineTo(-4, 3);
              ctx.closePath();
              ctx.fill();
              ctx.restore();
            }
          }

          // HUD Pill near target
          const toR = (this.store.stopLines && this.store.stopLines[toStop.id] || [])
            .map((rid) => this.store.doc.routes[rid]?.number).filter(Boolean);
          const toBuses = toR.length ? ` (Bus ${toR.join(', ')})` : '';
          const badgeText = this.connectBusNumber
            ? `🔗 Bus ${this.connectBusNumber} ➔ ${toStop.name} (${Math.round(leg.length)}m)`
            : `🔗 Connect to ${toStop.name}${toBuses} (${Math.round(leg.length)}m)`;
          ctx.font = 'bold 12px sans-serif';
          const tw = ctx.measureText(badgeText).width;
          const bx = endPt.x + 14;
          const by = endPt.y - 18;

          ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
          ctx.fillRect(bx - 6, by - 14, tw + 12, 22);
          ctx.strokeStyle = '#0284c7';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(bx - 6, by - 14, tw + 12, 22);

          ctx.fillStyle = '#38bdf8';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(badgeText, bx, by - 3);
        }
        ctx.restore();
      }

      // 14. Detour Option Live Interactive Preview on Map
      if (this.previewDetourOption) {
        this._renderDetourPreview(ctx);
      }
    }

    _renderDetourPreview(ctx) {
      const p = this.previewDetourOption;
      if (!p || !p.opt) return;

      const activeOpt = p.opt;
      const now = performance.now();
      const dashOffset = -((now / 20) % 24);

      // 1. Render all alternative detour routes in distinct dashed lines so user sees all options on the map
      if (this.detourOptions && this.detourOptions.length > 1) {
        for (const opt of this.detourOptions) {
          if (opt.index === activeOpt.index) continue;
          const geom = opt.geom || (opt.anchors ? this.store.computeRoute({ anchors: opt.anchors, kind: 'proposed' }) : null);
          if (!geom || !geom.legs || !geom.legs.length) continue;

          ctx.save();
          ctx.lineWidth = 4.5;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          const altColor = opt.index === 0 ? 'rgba(5, 150, 105, 0.75)' : (opt.index === 1 ? 'rgba(37, 99, 235, 0.75)' : 'rgba(217, 119, 6, 0.75)');
          ctx.strokeStyle = altColor;
          ctx.setLineDash([8, 8]);

          ctx.beginPath();
          for (const leg of geom.legs) {
            if (!leg.ok || !leg.pts || leg.pts.length < 2) continue;
            ctx.moveTo(leg.pts[0].x, leg.pts[0].y);
            for (let i = 1; i < leg.pts.length; i++) ctx.lineTo(leg.pts[i].x, leg.pts[i].y);
          }
          ctx.stroke();
          ctx.setLineDash([]);

          // Waypoint dots along alternative route
          if (opt.anchors) {
            for (const a of opt.anchors) {
              let pt = null;
              if (a.t === 'stop') {
                const s = this.store.doc.stops[a.id];
                if (s) pt = this.net.posPoint(s, 0.78);
              } else if (this.city && this.city.edges && this.city.edges[a.edge]) {
                const e = this.city.edges[a.edge];
                pt = B.pointAlong(e.pts, e.cum, a.s);
              }
              if (pt) {
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, 4 / this.camera.zoom, 0, Math.PI * 2);
                ctx.fillStyle = '#2563eb';
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5 / this.camera.zoom;
                ctx.stroke();
              }
            }
          }

          // Subtle alternative badge near midpoint on map
          const allPts = [];
          for (const leg of geom.legs) if (leg.ok && leg.pts) allPts.push(...leg.pts);
          if (allPts.length) {
            const frac = 0.32 + (opt.index * 0.18);
            const mp = allPts[Math.floor(allPts.length * Math.min(0.85, frac))];
            if (mp) {
              const lbl = `Option ${opt.index + 1}: ${opt.title} (${opt.timeDeltaMin})`;
              ctx.font = 'bold 10.5px sans-serif';
              const w = ctx.measureText(lbl).width;
              ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
              ctx.fillRect(mp.x - w / 2 - 6, mp.y - 11, w + 12, 20);
              ctx.strokeStyle = altColor;
              ctx.lineWidth = 1.4;
              ctx.strokeRect(mp.x - w / 2 - 6, mp.y - 11, w + 12, 20);
              ctx.fillStyle = '#0f172a';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(lbl, mp.x, mp.y);
            }
          }
          ctx.restore();
        }
      }

      // 2. Render ACTIVE selected detour route with glowing flowing stream
      const geom = activeOpt.geom || (activeOpt.anchors ? this.store.computeRoute({ anchors: activeOpt.anchors, kind: 'proposed' }) : null);
      if (!geom || !geom.legs || !geom.legs.length) return;

      const isRec = (activeOpt.index === 0);
      ctx.save();

      // Outer glow
      ctx.lineWidth = 13;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = isRec ? 'rgba(16, 185, 129, 0.5)' : 'rgba(37, 99, 235, 0.5)';
      ctx.shadowColor = isRec ? '#10b981' : '#2563eb';
      ctx.shadowBlur = 14;

      ctx.beginPath();
      for (const leg of geom.legs) {
        if (!leg.ok || !leg.pts || leg.pts.length < 2) continue;
        ctx.moveTo(leg.pts[0].x, leg.pts[0].y);
        for (let i = 1; i < leg.pts.length; i++) ctx.lineTo(leg.pts[i].x, leg.pts[i].y);
      }
      ctx.stroke();

      // Solid contrasting base
      ctx.shadowBlur = 0;
      ctx.lineWidth = 6.5;
      ctx.strokeStyle = isRec ? '#059669' : '#1d4ed8';
      ctx.stroke();

      // Animated white dash stream
      ctx.beginPath();
      for (const leg of geom.legs) {
        if (!leg.ok || !leg.pts || leg.pts.length < 2) continue;
        ctx.moveTo(leg.pts[0].x, leg.pts[0].y);
        for (let i = 1; i < leg.pts.length; i++) ctx.lineTo(leg.pts[i].x, leg.pts[i].y);
      }
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3.5;
      ctx.setLineDash([14, 10]);
      ctx.lineDashOffset = dashOffset;
      ctx.stroke();
      ctx.setLineDash([]);

      // Waypoint anchors along active route
      if (activeOpt.anchors) {
        for (let ai = 0; ai < activeOpt.anchors.length; ai++) {
          const a = activeOpt.anchors[ai];
          let pt = null;
          if (a.t === 'stop') {
            const s = this.store.doc.stops[a.id];
            if (s) pt = this.net.posPoint(s, 0.78);
          } else if (this.city && this.city.edges && this.city.edges[a.edge]) {
            const e = this.city.edges[a.edge];
            pt = B.pointAlong(e.pts, e.cum, a.s);
          }
          if (pt) {
            // Points between the two ends of the detour are drawn a little larger
            const isMid = ai > 0 && ai < activeOpt.anchors.length - 1;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, (isMid ? 7 : 5) / this.camera.zoom, 0, Math.PI * 2);
            ctx.fillStyle = '#2563eb';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2.2 / this.camera.zoom;
            ctx.stroke();
          }
        }
      }

      // Midpoint badge on map
      let midPt = null;
      const allPts = [];
      for (const leg of geom.legs) {
        if (leg.ok && leg.pts) allPts.push(...leg.pts);
      }
      if (allPts.length > 0) {
        midPt = allPts[Math.floor(allPts.length / 2)];
      }

      if (midPt) {
        const titleText = `⭐ Active Preview: Option ${activeOpt.index + 1} (${activeOpt.title}) • ${activeOpt.distDeltaKm}, ${activeOpt.timeDeltaMin}`;
        ctx.font = 'bold 12px sans-serif';
        const tw = ctx.measureText(titleText).width;
        const bx = midPt.x - tw / 2 - 10;
        const by = midPt.y - 30;

        ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
        ctx.fillRect(bx, by, tw + 20, 26);
        ctx.strokeStyle = isRec ? '#10b981' : '#3b82f6';
        ctx.lineWidth = 2;
        ctx.strokeRect(bx, by, tw + 20, 26);

        ctx.fillStyle = isRec ? '#34d399' : '#93c5fd';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(titleText, bx + 10, by + 13);
      }

      ctx.restore();
    }

    _renderAreaFilter(ctx) {
      if (!this.areaFilterPolygon && !this.drawingAreaFilter) return;

      const now = performance.now();
      const zoom = this.camera.zoom;

      // 1. Render active drawing in-progress
      if (this.drawingAreaFilter && this.drawingAreaFilter.length) {
        const pts = this.drawingAreaFilter;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        if (this.drawingAreaFilterPreview) {
          ctx.lineTo(this.drawingAreaFilterPreview.x, this.drawingAreaFilterPreview.y);
        }
        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = Math.max(2, 2.5 / zoom);
        ctx.setLineDash([8 / zoom, 6 / zoom]);
        ctx.lineDashOffset = -((now * 0.04) % (14 / zoom));
        ctx.stroke();

        // Semi-transparent fill if >= 2 points
        if (pts.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          if (this.drawingAreaFilterPreview) {
            ctx.lineTo(this.drawingAreaFilterPreview.x, this.drawingAreaFilterPreview.y);
          }
          ctx.closePath();
          ctx.fillStyle = 'rgba(14, 165, 233, 0.08)';
          ctx.fill();
        }

        // Draw vertex dots
        for (let i = 0; i < pts.length; i++) {
          ctx.beginPath();
          ctx.arc(pts[i].x, pts[i].y, 5 / zoom, 0, Math.PI * 2);
          ctx.fillStyle = (i === 0 && pts.length >= 3) ? '#10b981' : '#0284c7';
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5 / zoom;
          ctx.stroke();
        }
        ctx.restore();
      }

      // 2. Render completed filter polygon (until a map click hides it)
      if (this.areaFilterPolygon && this.areaFilterPolygon.length >= 3 && !this.hideAreaFilterOutline) {
        const pts = this.areaFilterPolygon;
        ctx.save();

        // Translucent cyan fill
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(14, 165, 233, 0.16)';
        ctx.fill();

        // Dashed glowing outline
        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = Math.max(2.5, 3 / zoom);
        ctx.setLineDash([10 / zoom, 6 / zoom]);
        ctx.lineDashOffset = -((now * 0.03) % (16 / zoom));
        ctx.stroke();

        // Draw vertex dots
        for (let i = 0; i < pts.length; i++) {
          ctx.beginPath();
          ctx.arc(pts[i].x, pts[i].y, 4.5 / zoom, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.strokeStyle = '#0284c7';
          ctx.lineWidth = 2 / zoom;
          ctx.stroke();
        }

        // Floating Area Filter HUD Badge at top of polygon
        let minY = Infinity, topPt = pts[0];
        for (const p of pts) {
          if (p.y < minY) { minY = p.y; topPt = p; }
        }
        const passingCount = this.areaFilterPassingCount || 0;
        const hudText = `📍 Filtered Area: ${passingCount} Bus Number${passingCount === 1 ? '' : 's'} Active`;
        ctx.font = 'bold 12px sans-serif';
        const tw = ctx.measureText(hudText).width;
        const hx = topPt.x - tw / 2 - 12;
        const hy = topPt.y - 32 / zoom;
        const hw = tw + 24;
        const hh = 24 / zoom;

        ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
        if (ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(hx, hy, hw, hh, 6 / zoom);
          ctx.fill();
          ctx.strokeStyle = '#0284c7';
          ctx.lineWidth = 1.6 / zoom;
          ctx.stroke();
        } else {
          ctx.fillRect(hx, hy, hw, hh);
        }

        ctx.fillStyle = '#38bdf8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(hudText, hx + hw / 2, hy + hh / 2);

        ctx.restore();
      }
    }

    _renderSnapBack(ctx) {
      if (!this.snapBackAnim) return;
      const anim = this.snapBackAnim;
      const elapsed = performance.now() - anim.startTime;
      const t = Math.min(1, elapsed / anim.duration);
      const ease = 1 - Math.pow(1 - t, 3);

      const cx = anim.fromX + (anim.toX - anim.fromX) * ease;
      const cy = anim.fromY + (anim.toY - anim.fromY) * ease;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, 9 / this.camera.zoom, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.7)';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      if (t >= 1) {
        if (anim.onComplete) anim.onComplete();
        this.snapBackAnim = null;
      }
    }

    _renderInvalidPlacement(ctx) {
      // Disabled: do not display error or warning text on the canvas
      this.invalidPlacement = null;
    }

    // Each road's name along it, upright, once per stretch of screen; only when zoomed in enough to read
    _renderRoadNames(ctx, vp) {
      const zoom = this.camera.zoom;
      if (zoom < 0.35) return;
      ctx.save();
      ctx.font = `600 ${10 / zoom}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3 / zoom;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.fillStyle = '#475569';
      const placed = [];
      const gap = 260 / zoom;
      for (const e of this.city.edges) {
        if (!e.name || !B.bboxOverlap(vp, e.bb)) continue;
        if (e._len === undefined) {
          e._len = 0;
          for (let i = 1; i < e.pts.length; i++) e._len += Math.hypot(e.pts[i].x - e.pts[i - 1].x, e.pts[i].y - e.pts[i - 1].y);
        }
        const w = ctx.measureText(e.name).width;
        if (e._len < w * 1.15) continue;
        const i = Math.max(0, Math.floor((e.pts.length - 1) / 2));
        const a = e.pts[i], b = e.pts[i + 1] || e.pts[i];
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (placed.some((p) => p.name === e.name && Math.hypot(p.x - mx, p.y - my) < gap)) continue;
        let ang = Math.atan2(b.y - a.y, b.x - a.x);
        if (ang > Math.PI / 2) ang -= Math.PI;
        if (ang < -Math.PI / 2) ang += Math.PI;
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(ang);
        ctx.strokeText(e.name, 0, 0);
        ctx.fillText(e.name, 0, 0);
        ctx.restore();
        placed.push({ name: e.name, x: mx, y: my });
      }
      ctx.restore();
    }

    _renderLabels(ctx) {
      // Town names, the same size on screen at any zoom (a little larger on the drawing-link page)
      const zoom = this.camera.zoom;
      if (!this.city.placeLabels) return;
      ctx.save();
      ctx.font = `700 ${(this.namesAlways ? 12 : 11.5) / zoom}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3.5 / zoom;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fillStyle = 'rgba(30, 41, 59, 0.78)';
      for (const pl of this.city.placeLabels) {
        ctx.strokeText(pl.name, pl.x, pl.y);
        ctx.fillText(pl.name, pl.x, pl.y);
      }
      ctx.restore();
    }

    _renderScreenOverlays(ctx) {
      ctx.save();
      const barPixels = 90;
      const meters = barPixels / this.camera.zoom;
      const roundedMeters = meters >= 1000 ? Math.round(meters / 500) * 500 : Math.round(meters / 50) * 50;
      const actualPixels = roundedMeters * this.camera.zoom;

      const sx = 20, sy = this.height - 24;
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, sy - 5); ctx.lineTo(sx, sy);
      ctx.lineTo(sx + actualPixels, sy);
      ctx.lineTo(sx + actualPixels, sy - 5);
      ctx.stroke();

      ctx.fillStyle = '#334155';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      const label = roundedMeters >= 1000 ? `${(roundedMeters / 1000).toFixed(1)} km` : `${roundedMeters} m`;
      ctx.fillText(label, sx + actualPixels / 2, sy - 8);
      ctx.restore();
    }
  }

  B.MapRenderer = MapRenderer;
})();
