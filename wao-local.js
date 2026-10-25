/* WAO lokaler Laufzeit-Ersatz
   Die Seiten wurden als Claude-Artefakte gebaut und nutzen dort window.claude.use('db' | 'assets' | 'downloads').
   Außerhalb von claude.ai stellt dieses Skript dieselben Schnittstellen bereit:
   - über den WAO Server (server.js): Daten und Dateien liegen zentral auf dem Server, alle Geräte sehen dasselbe
   - ohne Server (z. B. Datei direkt geöffnet oder GitHub Pages): Daten in localStorage, Dateien in IndexedDB,
     also nur in diesem Browser auf diesem Gerät
   Downloads werden in beiden Fällen als normaler Datei-Download gespeichert. */
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

  let serverMode = false;
  window.waoBlobUrl = id => serverMode ? '/api/assets/' + encodeURIComponent(id) : (urls[id] || '');

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

  /* ---------- WAO Server ---------- */
  async function call(url, body, headers = {}) {
    const code = (() => { try { return localStorage.getItem('meCode') || ''; } catch (e) { return ''; } })();
    const r = await fetch(url, { method: 'POST', credentials: 'same-origin', body,
      headers: { 'X-Patient-Code': code, ...headers } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || ('HTTP ' + r.status)); e.code = j.error || 'error'; e.status = r.status; throw e; }
    return j;
  }
  const dbCall = q => call('/api/db', JSON.stringify(q), { 'Content-Type': 'application/json' });

  const sListeners = new Set();
  let lastVersion = 0, polling = false;
  const refresh = () => sListeners.forEach(l => l());
  async function poll() {
    try {
      const r = await fetch('/api/version', { credentials: 'same-origin', cache: 'no-store' });
      const { v } = await r.json();
      if (v !== lastVersion) { lastVersion = v; refresh(); }
    } catch (e) {}
  }
  function startPolling() {
    if (polling) return; polling = true;
    setInterval(() => { if (!document.hidden) poll(); }, 4000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  }
  const afterWrite = () => setTimeout(poll, 0);

  function sDocRef(c, id) {
    const read = async () => { const { doc } = await dbCall({ op: 'get', coll: c, id }); return docSnap(id, doc === null ? undefined : doc); };
    return {
      id, path: c + '/' + id,
      get: read,
      set: async (data, opts) => { await dbCall({ op: 'set', coll: c, id, data, merge: !!(opts && opts.merge) }); afterWrite(); },
      update: async data => { await dbCall({ op: 'update', coll: c, id, data }); afterWrite(); },
      delete: async () => { await dbCall({ op: 'delete', coll: c, id }); afterWrite(); },
      onSnapshot: (cb, err) => {
        const l = () => read().then(cb, e => err ? err(e) : console.warn(e));
        sListeners.add(l); l(); startPolling(); return () => sListeners.delete(l);
      }
    };
  }
  function sQuery(c, filters = [], order = [], lim = null) {
    const run = async () => {
      const { docs } = await dbCall({ op: 'query', coll: c, filters, order, limit: lim });
      return qSnap(docs.map(d => docSnap(d.id, d.data)));
    };
    return {
      where: (f, op, v) => sQuery(c, [...filters, [f, op, v]], order, lim),
      orderBy: (f, dir = 'asc') => sQuery(c, filters, [...order, [f, dir]], lim),
      limit: n => sQuery(c, filters, order, n),
      doc: id => sDocRef(c, id || newId()),
      get: run,
      onSnapshot: (cb, err) => {
        const l = () => run().then(cb, e => err ? err(e) : console.warn(e));
        sListeners.add(l); l(); startPolling(); return () => sListeners.delete(l);
      }
    };
  }
  const serverDb = {
    collection: name => sQuery(name),
    doc: path => { const [c, id] = String(path).split('/'); return sDocRef(c, id); },
    login: async pin => { try { await call('/api/login', JSON.stringify({ pin }), { 'Content-Type': 'application/json' }); refresh(); return true; } catch (e) { return false; } },
    logout: async () => { try { await call('/api/logout', '{}', { 'Content-Type': 'application/json' }); } catch (e) {} },
    setPin: async pin => { await call('/api/pin', JSON.stringify({ pin }), { 'Content-Type': 'application/json' }); }
  };
  const serverAssets = {
    upload: async file => call('/api/assets', file, { 'Content-Type': file.type || 'application/octet-stream' }),
    delete: async id => { await fetch('/api/assets/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' }); }
  };

  const mode = /^https?:$/.test(location.protocol)
    ? fetch('/api/version', { credentials: 'same-origin', cache: 'no-store' })
        .then(r => r.ok ? r.json() : null).then(j => { serverMode = !!(j && typeof j.v === 'number'); if (serverMode) lastVersion = j.v; })
        .catch(() => {})
    : Promise.resolve();

  window.claude = {
    local: true,
    use: async name => {
      await mode;
      if (name === 'db') return serverMode ? serverDb : db;
      if (name === 'assets') { if (serverMode) return serverAssets; await ready; return assets; }
      if (name === 'downloads') return downloads;
      return null;
    }
  };
})();
