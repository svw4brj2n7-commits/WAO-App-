/* WAO lokaler Laufzeit-Ersatz
   Die Seiten wurden als Claude-Artefakte gebaut und nutzen dort window.claude.use('db' | 'assets' | 'downloads').
   Läuft eine Seite außerhalb von claude.ai (z. B. lokal oder auf GitHub Pages), stellt dieses Skript dieselben
   Schnittstellen im Browser bereit: Daten in localStorage, hochgeladene Dateien in IndexedDB, Downloads als Datei-Download.
   Hinweis: Die Daten liegen dann nur in diesem Browser auf diesem Gerät. */
(function () {
  if (window.claude && window.claude.use) return;

  /* ---------- Datenbank (Firestore-ähnlich, localStorage) ---------- */
  const KEY = 'wao:db';
  let store;
  const load = () => { try { store = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { store = {}; } };
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { console.warn('WAO: Speichern fehlgeschlagen', e); } };
  load();

  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const coll = name => (store[name] = store[name] || {});
  const getPath = (o, p) => p.split('.').reduce((a, k) => a == null ? undefined : a[k], o);
  const setPath = (o, p, v) => { const ks = p.split('.'); let c = o; ks.slice(0, -1).forEach(k => { if (typeof c[k] !== 'object' || c[k] === null) c[k] = {}; c = c[k]; }); c[ks[ks.length - 1]] = v; };
  const cmp = (a, b) => a == null && b == null ? 0 : a == null ? -1 : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0;

  const listeners = new Set();
  const notify = () => listeners.forEach(l => setTimeout(() => { if (listeners.has(l)) l(); }, 0));
  window.addEventListener('storage', e => { if (e.key === KEY) { load(); notify(); } });

  const docSnap = (id, data) => ({ id, exists: data !== undefined, data: () => clone(data) });
  const qSnap = docs => ({ docs, empty: !docs.length, size: docs.length, forEach: f => docs.forEach(f) });

  function docRef(c, id) {
    const read = () => docSnap(id, coll(c)[id]);
    return {
      id, path: c + '/' + id,
      get: async () => read(),
      set: async (data, opts) => { coll(c)[id] = opts && opts.merge ? { ...(coll(c)[id] || {}), ...clone(data) } : clone(data); persist(); notify(); },
      update: async patch => {
        const cur = coll(c)[id];
        if (cur === undefined) { const e = new Error('Dokument nicht gefunden: ' + c + '/' + id); e.code = 'not-found'; throw e; }
        Object.entries(clone(patch)).forEach(([k, v]) => setPath(cur, k, v));
        persist(); notify();
      },
      delete: async () => { delete coll(c)[id]; persist(); notify(); },
      onSnapshot: (cb, err) => {
        const l = () => { try { cb(read()); } catch (e) { err ? err(e) : console.error(e); } };
        listeners.add(l); l(); return () => listeners.delete(l);
      }
    };
  }

  function query(c, filters = [], order = [], lim = null) {
    const run = () => {
      let rows = Object.entries(coll(c)).map(([id, d]) => ({ id, d }));
      filters.forEach(([f, op, v]) => {
        rows = rows.filter(({ d }) => {
          const x = getPath(d, f);
          switch (op) {
            case '==': return x === v; case '!=': return x !== v;
            case '<': return x < v; case '<=': return x <= v; case '>': return x > v; case '>=': return x >= v;
            case 'in': return Array.isArray(v) && v.includes(x);
            case 'array-contains': return Array.isArray(x) && x.includes(v);
            default: return true;
          }
        });
      });
      if (order.length) rows.sort((a, b) => { for (const [f, dir] of order) { const r = cmp(getPath(a.d, f), getPath(b.d, f)); if (r) return dir === 'desc' ? -r : r; } return 0; });
      if (lim != null) rows = rows.slice(0, lim);
      return qSnap(rows.map(({ id, d }) => docSnap(id, d)));
    };
    return {
      where: (f, op, v) => query(c, [...filters, [f, op, v]], order, lim),
      orderBy: (f, dir = 'asc') => query(c, filters, [...order, [f, dir]], lim),
      limit: n => query(c, filters, order, n),
      doc: id => docRef(c, id || newId()),
      get: async () => run(),
      onSnapshot: (cb, err) => {
        const l = () => { try { cb(run()); } catch (e) { err ? err(e) : console.error(e); } };
        listeners.add(l); l(); return () => listeners.delete(l);
      }
    };
  }

  const db = {
    collection: name => query(name),
    doc: path => { const [c, id] = String(path).split('/'); return docRef(c, id); }
  };

  /* ---------- Dateien (IndexedDB) ---------- */
  const urls = {};
  const idb = new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('IndexedDB nicht verfügbar'));
    const r = indexedDB.open('wao-assets', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = (mode, fn) => idb.then(d => new Promise((res, rej) => {
    const t = d.transaction('files', mode); const s = t.objectStore('files'); const out = fn(s);
    t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error);
  }));
  /* vorhandene Dateien beim Start laden, damit Bild-URLs synchron verfügbar sind */
  const ready = tx('readonly', s => { const req = s.openCursor(); req.onsuccess = () => { const c = req.result; if (c) { urls[c.key] = URL.createObjectURL(c.value); c.continue(); } }; })
    .catch(() => {})
    .then(() => { if (typeof window.render === 'function') try { window.render(); } catch (e) {} });

  window.waoBlobUrl = id => urls[id] || '';

  const assets = {
    upload: async file => {
      const id = newId();
      await tx('readwrite', s => s.put(file, id));
      urls[id] = URL.createObjectURL(file);
      return { id, url: urls[id] };
    },
    delete: async id => { await tx('readwrite', s => s.delete(id)); if (urls[id]) URL.revokeObjectURL(urls[id]); delete urls[id]; }
  };

  /* ---------- Downloads ---------- */
  const downloads = {
    save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename || 'download';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
  };

  window.claude = {
    local: true,
    use: async name => {
      if (name === 'db') return db;
      if (name === 'assets') { await ready; return assets; }
      if (name === 'downloads') return downloads;
      return null;
    }
  };
})();
