/* BRASS — Change report: a PDF comparing a project draft with the Current Map.
 * Page 1 shows both maps side by side, framed on what changed (changed buses in full colour,
 * everything else faded). The pages after it list every change. Pages are drawn on a canvas and
 * written as a small image-based PDF, so no PDF library is needed.
 */
(function () {
  const B = window.B;

  // A4 landscape, drawn at 2x (the PDF page is 842 x 595 pt)
  const PAGE_W = 1684, PAGE_H = 1190, M = 64;
  const PDF_W = 842, PDF_H = 595;
  const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
  const COLORS = { add: '#16a34a', del: '#dc2626', mod: '#d97706', close: '#dc2626', reopen: '#2563eb' };

  // Route geometry for any doc, from a throwaway calculator (no storage, no events)
  function geometryOf(store, doc) {
    const calc = Object.create(B.Store.prototype);
    Object.assign(calc, { city: store.city, net: store.net, doc, legCache: store.legCache });
    calc.derive();
    return calc;
  }

  // What differs between the Current Map (base) and the draft (proj)
  function diffDocs(c, base, proj) {
    const groupsOf = (doc) => new Map(c._busGroups(Object.values(doc.routes || {})).map((g) => [g.number, g]));
    const gb = groupsOf(base), gp = groupsOf(proj);
    const signature = (doc, g) => JSON.stringify([g.routes.map((r) => JSON.stringify(r.anchors)).sort(), B.busHours(doc, g.number), B.busModel(doc, g.number), B.busDays(doc, g.number), B.busActive(doc, g.number), B.busFleetSet(doc, g.number)]);
    const changedBuses = [...gp.keys()].filter((n) => gb.has(n) && signature(base, gb.get(n)) !== signature(proj, gp.get(n)));
    const bs = base.stops || {}, ps = proj.stops || {};
    const bc = base.closures || {}, pc = proj.closures || {};
    const ba = base.areas || {}, pa = proj.areas || {};
    return {
      addedBuses: new Set([...gp.keys()].filter((n) => !gb.has(n))),
      removedBuses: new Set([...gb.keys()].filter((n) => !gp.has(n))),
      changedBuses: new Set(changedBuses),
      addedStops: new Set(Object.keys(ps).filter((id) => !bs[id])),
      removedStops: new Set(Object.keys(bs).filter((id) => !ps[id])),
      movedStops: new Set(Object.keys(ps).filter((id) => bs[id] && (bs[id].edge !== ps[id].edge || Math.abs((bs[id].s || 0) - (ps[id].s || 0)) > 1))),
      addedClosures: Object.keys(pc).filter((id) => !bc[id]),
      removedClosures: Object.keys(bc).filter((id) => !pc[id]),
      addedAreas: Object.keys(pa).filter((id) => !ba[id]),
      removedAreas: Object.keys(ba).filter((id) => !pa[id]),
    };
  }

  // The part of the map both pages frame: everything that changed, or the whole island
  function changeBounds(city, before, after, d) {
    const pts = [];
    const routePts = (calc, doc, numbers) => {
      for (const r of Object.values(doc.routes || {})) {
        if (!numbers.has(String(r.number).trim())) continue;
        const g = calc.geom[r.id];
        if (g) for (const l of g.legs) if (l.pts) pts.push(...l.pts);
      }
    };
    routePts(before.calc, before.doc, new Set([...d.removedBuses, ...d.changedBuses]));
    routePts(after.calc, after.doc, new Set([...d.addedBuses, ...d.changedBuses]));
    const stopPt = (side, id) => { const s = side.doc.stops[id]; if (s) pts.push(side.calc.net.posPoint(s, 0.78)); };
    d.removedStops.forEach((id) => stopPt(before, id));
    [...d.addedStops, ...d.movedStops].forEach((id) => stopPt(after, id));
    [...d.addedClosures, ...d.removedClosures].forEach((id) => { const e = city.edges[id]; if (e) pts.push(...e.pts); });
    d.addedAreas.forEach((id) => pts.push(...after.calc.areaPoly(after.doc.areas[id])));
    d.removedAreas.forEach((id) => pts.push(...before.calc.areaPoly(before.doc.areas[id])));
    if (!pts.length) return { ...city.bounds };
    const bb = B.bbox(pts);
    const pad = Math.max(150, 0.08 * Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0));
    return { x0: bb.x0 - pad, y0: bb.y0 - pad, x1: bb.x1 + pad, y1: bb.y1 + pad };
  }

  // World box to a panel, keeping the aspect ratio and filling the panel
  function fitTo(bbox, rect) {
    let { x0, y0, x1, y1 } = bbox;
    const want = rect.w / rect.h;
    if ((x1 - x0) / (y1 - y0) < want) {
      const grow = ((y1 - y0) * want - (x1 - x0)) / 2; x0 -= grow; x1 += grow;
    } else {
      const grow = ((x1 - x0) / want - (y1 - y0)) / 2; y0 -= grow; y1 += grow;
    }
    const s = rect.w / (x1 - x0);
    return { s, X: (x) => rect.x + (x - x0) * s, Y: (y) => rect.y + (y - y0) * s };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // One map panel: land, roads, areas, closures, buses (changed ones bright), and the stops that changed
  function drawMap(ctx, rect, city, side, d, bbox, which) {
    const t = fitTo(bbox, rect);
    const path = (pts, close) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(t.X(p.x), t.Y(p.y)) : ctx.moveTo(t.X(p.x), t.Y(p.y))));
      if (close) ctx.closePath();
    };
    ctx.save();
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 14);
    ctx.clip();
    ctx.fillStyle = '#cfe3f3';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    ctx.fillStyle = '#f3f1ea';
    path(city.coast, true); ctx.fill();
    for (const i of city.islets || []) { path(i.poly, true); ctx.fill(); }
    ctx.fillStyle = '#dcebd5';
    for (const p of city.parks || []) { path(p.poly, true); ctx.fill(); }
    ctx.fillStyle = '#cfe3f3';
    for (const l of city.lakes || []) { path(l.poly, true); ctx.fill(); }
    ctx.strokeStyle = '#cfe3f3';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const r of city.rivers || []) { ctx.lineWidth = Math.max(2, r.hw * 2 * t.s); path(r.pts, false); ctx.stroke(); }

    ctx.strokeStyle = '#d5dae2';
    for (const e of city.edges) { ctx.lineWidth = Math.max(1, (e.cls === 'major' ? 12 : 7) * t.s); path(e.pts, false); ctx.stroke(); }

    // Affected areas and closures on this map
    for (const a of Object.values(side.doc.areas || {})) {
      path(side.calc.areaPoly(a), true);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.14)'; ctx.fill();
      ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.strokeStyle = '#dc2626';
    for (const id of Object.keys(side.doc.closures || {})) {
      const e = city.edges[id]; if (!e) continue;
      ctx.lineWidth = Math.max(4, 11 * t.s); path(e.pts, false); ctx.stroke();
    }

    // Buses: the ones that changed on this side in full colour, the rest faded
    const bright = which === 'before'
      ? new Set([...d.removedBuses, ...d.changedBuses])
      : new Set([...d.addedBuses, ...d.changedBuses]);
    const routes = Object.values(side.doc.routes || {}).sort((a, b) => bright.has(String(a.number).trim()) - bright.has(String(b.number).trim()));
    const labels = [];
    for (const r of routes) {
      const g = side.calc.geom[r.id];
      if (!g) continue;
      const num = String(r.number).trim();
      const on = bright.has(num);
      ctx.globalAlpha = on ? 1 : 0.16;
      ctx.strokeStyle = r.color || '#2563eb';
      ctx.lineWidth = on ? 6 : 4;
      for (const l of g.legs) { if (l.ok && l.pts && l.pts.length > 1) { path(l.pts, false); ctx.stroke(); } }
      if (on) {
        const all = g.legs.flatMap((l) => l.pts || []);
        if (all.length) labels.push({ num, color: r.color || '#2563eb', p: all[Math.floor(all.length / 2)] });
      }
    }
    ctx.globalAlpha = 1;

    // Only the stops that changed: added (green) and moved (amber) on the draft, removed (red) on the Current Map
    const dot = (p, fill, r, ring) => {
      ctx.beginPath(); ctx.arc(t.X(p.x), t.Y(p.y), r, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill();
      if (ring) { ctx.lineWidth = 2.5; ctx.strokeStyle = ring; ctx.stroke(); }
    };
    const marks = which === 'after'
      ? [[d.addedStops, COLORS.add], [d.movedStops, COLORS.mod]]
      : [[d.removedStops, COLORS.del]];
    for (const [ids, color] of marks) {
      for (const id of ids) {
        const s = side.doc.stops[id];
        if (s) dot(side.calc.net.posPoint(s, 0.78), color, 7, '#ffffff');
      }
    }

    // Bus numbers on the changed lines
    ctx.font = `800 18px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const lb of labels) {
      const x = t.X(lb.p.x), y = t.Y(lb.p.y);
      const w = ctx.measureText(lb.num).width + 16;
      roundRect(ctx, x - w / 2, y - 14, w, 28, 6);
      ctx.fillStyle = lb.color; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      ctx.fillStyle = '#ffffff'; ctx.fillText(lb.num, x, y + 1);
    }
    ctx.restore();

    ctx.save();
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 14);
    ctx.lineWidth = 2; ctx.strokeStyle = '#cbd5e1'; ctx.stroke();
    ctx.restore();
  }

  function newPage() {
    const canvas = document.createElement('canvas');
    canvas.width = PAGE_W; canvas.height = PAGE_H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    return { canvas, ctx };
  }

  function header(ctx, title, subtitle) {
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#0f172a';
    ctx.font = `800 40px ${FONT}`;
    ctx.fillText(title, M, M + 34);
    ctx.fillStyle = '#64748b';
    ctx.font = `500 21px ${FONT}`;
    ctx.fillText(subtitle, M, M + 72);
  }

  function footer(ctx, page, pages) {
    ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#94a3b8';
    ctx.font = `500 18px ${FONT}`;
    ctx.fillText(`BRASS · Page ${page} of ${pages}`, PAGE_W - M, PAGE_H - 36);
  }

  // Summary chips: "+20 buses", "−6 buses", ...
  function summaryChips(ctx, d, x, y) {
    const chips = [
      [d.addedBuses.size, 'bus added', 'buses added', COLORS.add],
      [d.removedBuses.size, 'bus removed', 'buses removed', COLORS.del],
      [d.changedBuses.size, 'bus changed', 'buses changed', COLORS.mod],
      [d.addedStops.size, 'stop added', 'stops added', COLORS.add],
      [d.removedStops.size, 'stop removed', 'stops removed', COLORS.del],
      [d.movedStops.size, 'stop moved', 'stops moved', COLORS.mod],
      [d.addedClosures.length, 'road closed', 'roads closed', COLORS.close],
      [d.removedClosures.length, 'road reopened', 'roads reopened', COLORS.reopen],
      [d.addedAreas.length, 'area added', 'areas added', COLORS.del],
      [d.removedAreas.length, 'area removed', 'areas removed', COLORS.reopen],
    ].filter(([n]) => n > 0);
    ctx.font = `700 20px ${FONT}`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    if (!chips.length) {
      ctx.fillStyle = '#64748b';
      ctx.fillText('No differences from the Current Map', x, y + 18);
      return;
    }
    for (const [n, one, many, color] of chips) {
      const text = `${n} ${n === 1 ? one : many}`;
      const w = ctx.measureText(text).width + 28;
      roundRect(ctx, x, y, w, 36, 8);
      ctx.fillStyle = '#f8fafc'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
      ctx.fillStyle = color; ctx.fillText(text, x + 14, y + 19);
      x += w + 10;
    }
  }

  function legend(ctx, x, y) {
    const items = [
      ['line', '#2563eb', 1, 'Changed bus (full colour)'],
      ['line', '#2563eb', 0.16, 'Unchanged bus'],
      ['line', '#dc2626', 1, 'Road closure'],
      ['area', '#ef4444', 1, 'Affected area'],
      ['dot', COLORS.add, 1, 'Stop added'],
      ['dot', COLORS.mod, 1, 'Stop moved'],
      ['dot', COLORS.del, 1, 'Stop removed'],
    ];
    ctx.font = `600 18px ${FONT}`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (const [kind, color, alpha, label] of items) {
      ctx.globalAlpha = alpha;
      if (kind === 'line') {
        ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 34, y); ctx.stroke();
      } else if (kind === 'area') {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.14)'; ctx.fillRect(x, y - 11, 34, 22);
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.strokeRect(x, y - 11, 34, 22);
      } else {
        ctx.beginPath(); ctx.arc(x + 17, y, 8, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#334155';
      ctx.fillText(label, x + 44, y + 1);
      x += 44 + ctx.measureText(label).width + 30;
    }
  }

  // Pages after the maps: every change, one line each, two columns
  function changePages(lines, title, subtitle) {
    const PER_COL = 26, LINE = 34;
    const perPage = PER_COL * 2;
    const pages = [];
    const glyph = { add: '+', del: '−', mod: '~', close: '■', reopen: '□' };
    for (let i = 0; i < Math.max(1, lines.length); i += perPage) {
      const { canvas, ctx } = newPage();
      header(ctx, title, subtitle);
      ctx.fillStyle = '#0f172a';
      ctx.font = `800 24px ${FONT}`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(`Changes (${lines.length})`, M, M + 130);
      const chunk = lines.slice(i, i + perPage);
      if (!chunk.length) {
        ctx.fillStyle = '#64748b'; ctx.font = `500 20px ${FONT}`;
        ctx.fillText('No differences from the Current Map', M, M + 180);
      }
      const colW = (PAGE_W - M * 2) / 2;
      chunk.forEach((ch, k) => {
        const col = Math.floor(k / PER_COL), row = k % PER_COL;
        const x = M + col * colW, y = M + 180 + row * LINE;
        ctx.font = `800 22px ${FONT}`;
        ctx.fillStyle = COLORS[ch.action] || '#64748b';
        ctx.fillText(glyph[ch.action] || '•', x, y);
        ctx.font = `500 20px ${FONT}`;
        ctx.fillStyle = '#1e293b';
        let text = ch.text;
        while (ctx.measureText(text).width > colW - 60 && text.length > 4) text = text.slice(0, -2);
        if (text !== ch.text) text = text.trimEnd() + '…';
        ctx.fillText(text, x + 30, y);
      });
      pages.push({ canvas, ctx });
    }
    return pages;
  }

  // A minimal PDF: one JPEG filling each A4 landscape page
  function buildPdf(images) {
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let offset = 0;
    const push = (data) => {
      const bytes = typeof data === 'string' ? enc.encode(data) : data;
      chunks.push(bytes);
      offset += bytes.length;
    };
    const obj = (n, write) => { offsets[n] = offset; push(`${n} 0 obj\n`); write(); push('\nendobj\n'); };

    push('%PDF-1.4\n%âãÏÓ\n');
    const kids = images.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push(`<< /Type /Pages /Kids [${kids}] /Count ${images.length} >>`));
    images.forEach((img, i) => {
      const pageN = 3 + i * 3, contentN = pageN + 1, imageN = pageN + 2;
      obj(pageN, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_W} ${PDF_H}] /Resources << /XObject << /Im${i} ${imageN} 0 R >> >> /Contents ${contentN} 0 R >>`));
      const content = `q ${PDF_W} 0 0 ${PDF_H} 0 0 cm /Im${i} Do Q`;
      obj(contentN, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
      obj(imageN, () => {
        push(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>\nstream\n`);
        push(img.jpeg);
        push('\nendstream');
      });
    });
    const xref = offset;
    const size = 3 + images.length * 3;
    push(`xref\n0 ${size}\n0000000000 65535 f \n`);
    for (let n = 1; n < size; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
    push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  function jpegOf(canvas) {
    const b64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { jpeg: bytes, w: canvas.width, h: canvas.height };
  }

  // Builds the report for a project draft; returns { blob, filename, canvases }
  B.buildChangeReport = async function (c, projectId) {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const project = c.projects.find((p) => p.id === projectId);
    const name = project ? project.name : 'Project';
    const baseDoc = c._loadProjectDraft('main');
    const projDoc = c.activeProjectId === projectId ? JSON.parse(JSON.stringify(c.store.doc)) : c._loadProjectDraft(projectId);
    const city = c.store.city;
    const before = { doc: baseDoc, calc: geometryOf(c.store, baseDoc) };
    const after = { doc: projDoc, calc: geometryOf(c.store, projDoc) };
    const d = diffDocs(c, baseDoc, projDoc);
    const lines = c._computeProjectChanges(baseDoc, projDoc);

    const when = new Date().toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const title = `Change report: ${name}`;
    const subtitle = `Compared with the Current Map · Prepared by John Doe · ${when}`;

    // Page 1: summary, both maps side by side, legend
    const first = newPage();
    header(first.ctx, title, subtitle);
    summaryChips(first.ctx, d, M, M + 100);
    const top = M + 190, gap = 40;
    const panelW = (PAGE_W - M * 2 - gap) / 2;
    const panelH = PAGE_H - top - 150;
    const bbox = changeBounds(city, before, after, d);
    const rects = [
      { x: M, y: top, w: panelW, h: panelH },
      { x: M + panelW + gap, y: top, w: panelW, h: panelH },
    ];
    first.ctx.fillStyle = '#0f172a';
    first.ctx.font = `800 24px ${FONT}`;
    first.ctx.textAlign = 'left'; first.ctx.textBaseline = 'alphabetic';
    first.ctx.fillText('Current Map', rects[0].x, top - 16);
    first.ctx.fillText(`${name} (proposed)`, rects[1].x, top - 16);
    drawMap(first.ctx, rects[0], city, before, d, bbox, 'before');
    drawMap(first.ctx, rects[1], city, after, d, bbox, 'after');
    legend(first.ctx, M, PAGE_H - 100);

    const pages = [first, ...changePages(lines, title, subtitle)];
    pages.forEach((p, i) => footer(p.ctx, i + 1, pages.length));

    const blob = buildPdf(pages.map((p) => jpegOf(p.canvas)));
    const filename = `${name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Project'} - change report.pdf`;
    return { blob, filename, canvases: pages.map((p) => p.canvas) };
  };

  // Builds the report and saves it as a file
  B.downloadChangeReport = async function (c, projectId) {
    const { blob, filename } = await B.buildChangeReport(c, projectId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return filename;
  };
})();
