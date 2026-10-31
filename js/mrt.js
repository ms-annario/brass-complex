/* BRASS — MRT stations
 * One station beside the main road at each town centre, plus stations halfway between neighbouring towns.
 * The city comes from a fixed seed and so do these, so every machine and every project sees the same stations.
 */
(function () {
  const B = window.B;

  // "Braddell Road" → "Braddell"
  const placeName = (road) => String(road || '').replace(/\s+(Road|Rd|Avenue|Ave|Street|St|Drive|Dr|Way|Lane|Boulevard|Crescent|Link|Expressway)\b.*$/i, '').trim();
  const firstWord = (name) => name.split(/\s+/)[0].toLowerCase();

  B.placeMrtStations = (city, net) => {
    const stations = [];
    const add = (t, name) => {
      const road = net.nearest(t, 420);
      if (!road) return;
      const e = net.edge(road.edge);
      name = name || placeName(e && e.name);
      if (!name || stations.some((s) => firstWord(s.name) === firstWord(name))) return;
      // Just off the road, on the side of the town centre
      const dx = t.x - road.x, dy = t.y - road.y;
      const d = Math.hypot(dx, dy);
      const off = (road.hw || 6) + 26;
      const p = d > 1 ? { x: road.x + (dx / d) * off, y: road.y + (dy / d) * off } : { x: road.x, y: road.y - off };
      if (stations.some((s) => Math.hypot(s.x - p.x, s.y - p.y) < 550)) return;
      stations.push({ id: `MRT${stations.length + 1}`, name, x: p.x, y: p.y, edge: road.edge });
    };

    // Town centres
    const ds = city.districts;
    ds.forEach((d) => add(d, d.name));

    // Between towns: halfway along the closer pairs first, named after the road there
    const pairs = [];
    for (let i = 0; i < ds.length; i++) {
      for (let j = i + 1; j < ds.length; j++) {
        const d = Math.hypot(ds[i].x - ds[j].x, ds[i].y - ds[j].y);
        if (d > 900 && d < 3000) pairs.push({ d, x: (ds[i].x + ds[j].x) / 2, y: (ds[i].y + ds[j].y) / 2 });
      }
    }
    pairs.sort((a, b) => a.d - b.d).forEach((p) => add(p, null));
    return stations;
  };
})();
