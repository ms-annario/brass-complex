/* BRASS — saved maps kept small.
 * A map is thousands of stops and hundreds of buses, and most saved maps (the Current Map, project drafts,
 * version snapshots) differ from the generated network in only a few of them. So a saved map keeps only its
 * changes from that network, and reading it back gives the whole map again: every caller still reads and
 * writes plain map JSON. Maps saved on the earlier, smaller island are set aside on first load.
 */
(function () {
  const B = window.B;
  B.MAP_VERSION = 'sg-1';

  const DOC_KEY = /^(brass_proj_doc_|brass_proj_base_|brass_map_snapshot_|brass_project_map_|brass_scheduled_base$|brass\.doc\.)/;
  const MARK = '~d';
  let base = null;
  let baseStr = null;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);

  // The generated network every saved map is compared with
  B.setDocBase = (docString) => {
    baseStr = docString;
    base = JSON.parse(docString);
  };

  // What a map changes from the network: per collection the items set or removed, other fields as they are
  B.docPatch = (doc) => {
    const patch = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(doc)])) {
      const b = base[key], v = doc[key];
      if (isMap(b) && isMap(v)) {
        const set = {}, del = [];
        for (const id of Object.keys(v)) if (!(id in b) || !same(v[id], b[id])) set[id] = v[id];
        for (const id of Object.keys(b)) if (!(id in v)) del.push(id);
        if (Object.keys(set).length || del.length) patch[key] = { set, del };
      } else if (!same(b, v)) {
        patch[key] = v === undefined ? { gone: true } : { value: v };
      }
    }
    return patch;
  };

  B.docFromPatch = (patch) => {
    const doc = JSON.parse(baseStr);
    for (const [key, p] of Object.entries(patch || {})) {
      if (p.set || p.del) {
        doc[key] = isMap(doc[key]) ? doc[key] : {};
        Object.assign(doc[key], p.set || {});
        for (const id of p.del || []) delete doc[key][id];
      } else if (p.gone) {
        delete doc[key];
      } else {
        doc[key] = p.value;
      }
    }
    return doc;
  };

  // Maps go into localStorage as "~d" + their changes, and come back out whole (the last few are remembered)
  const proto = window.Storage && window.Storage.prototype;
  if (proto) {
    const getItem = proto.getItem, setItem = proto.setItem;
    const decoded = new Map();
    proto.setItem = function (key, value) {
      if (base && this === window.localStorage && DOC_KEY.test(key) && typeof value === 'string' && value[0] === '{') {
        try { value = MARK + JSON.stringify(B.docPatch(JSON.parse(value))); } catch (e) { /* stored as it is */ }
      }
      decoded.delete(key);
      return setItem.call(this, key, value);
    };
    proto.getItem = function (key) {
      const value = getItem.call(this, key);
      if (!base || typeof value !== 'string' || !value.startsWith(MARK)) return value;
      const hit = decoded.get(key);
      if (hit && hit.enc === value) return hit.dec;
      let dec = null;
      try { dec = JSON.stringify(B.docFromPatch(JSON.parse(value.slice(MARK.length)))); } catch (e) { dec = null; }
      decoded.set(key, { enc: value, dec });
      if (decoded.size > 24) decoded.delete(decoded.keys().next().value);
      return dec;
    };
  }

  // Maps from the earlier, smaller island don't fit these roads: on first load they're put aside in one
  // backup entry (brass_backup_pulau_sambau), not deleted, and the app starts from the new network
  B.migrateStorage = () => {
    try {
      if (localStorage.getItem('brass_map_version') === B.MAP_VERSION) return;
      const keys = Object.keys(localStorage).filter((k) => /^brass[._]/.test(k) && !k.startsWith('brass_backup_'));
      if (keys.length && !localStorage.getItem('brass_backup_pulau_sambau')) {
        const old = {};
        for (const k of keys) old[k] = localStorage.getItem(k);
        localStorage.setItem('brass_backup_pulau_sambau', JSON.stringify(old));
      }
      keys.forEach((k) => localStorage.removeItem(k));
      localStorage.setItem('brass_map_version', B.MAP_VERSION);
    } catch (e) {
      console.warn('Could not set aside the maps from the earlier island', e);
    }
  };
})();
