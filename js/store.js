// Persistent library of loaded files (original text) and chosen ranges, kept in this browser's IndexedDB.
// Files are re-parsed on startup, so parser fixes apply to old sessions too. Nothing leaves the device.
SS.Store = (() => {
  const DB = 'streamscope', VER = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB niedostępne')); return; }
      const req = indexedDB.open(DB, VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('ranges')) db.createObjectStore('ranges', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const putFile = rec => tx('files', 'readwrite', s => s.put({ ...rec, savedAt: Date.now() }));
  const allFiles = () => tx('files', 'readonly', s => s.getAll());
  const deleteFile = key => tx('files', 'readwrite', s => s.delete(key));
  const putRange = r => tx('ranges', 'readwrite', s => s.put(r));
  const allRanges = () => tx('ranges', 'readonly', s => s.getAll());
  const clearAll = () => Promise.all([tx('files', 'readwrite', s => s.clear()), tx('ranges', 'readwrite', s => s.clear())]);

  // Ask the browser not to evict our data under storage pressure (Safari otherwise may drop it after weeks unused).
  async function persist() {
    try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch (e) { return false; }
  }
  async function usage() {
    try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (e) { return null; }
  }

  const api = { putFile, allFiles, deleteFile, putRange, allRanges, clearAll, persist, usage, agent: null };

  // When the page is served by StreamScope Agent, the agent's archive replaces this browser's IndexedDB,
  // so every device on the network sees the same files, ranges and history.
  async function detectAgent() {
    try {
      const r = await fetch('api/info', { cache: 'no-store' });
      if (!r.ok) return null;
      const info = await r.json();
      if (!info || info.agent !== 'StreamScope Agent') return null;
      useAgent(info);
      return info;
    } catch (e) { return null; }
  }

  function useAgent(info) {
    api.agent = info;
    let prefs = null, saveTimer = null;
    const loadPrefs = async () => prefs || (prefs = await (await fetch('api/prefs', { cache: 'no-store' })).json() || {});
    const savePrefs = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => fetch('api/prefs', { method: 'PUT', body: JSON.stringify(prefs) }).catch(() => {}), 400);
    };
    api.listFiles = async () => (await fetch('api/files', { cache: 'no-store' })).json();
    api.readFile = async id => (await fetch('api/file?id=' + encodeURIComponent(id), { cache: 'no-store' })).text();
    api.allFiles = async () => {
      const list = await api.listFiles();
      const out = [];
      for (const f of list) out.push({ key: f.id, id: f.id, name: f.name, size: f.size, mtime: f.mtime, savedAt: f.mtime, text: await api.readFile(f.id) });
      return out;
    };
    api.putFile = rec => fetch('api/files?name=' + encodeURIComponent(rec.name), { method: 'POST', body: rec.text }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); });
    api.deleteFile = async () => {};   // sources would re-supply the file; the app hides sessions instead
    api.allRanges = async () => Object.values((await loadPrefs()).ranges || {});
    api.putRange = async r => { await loadPrefs(); prefs.ranges = prefs.ranges || {}; prefs.ranges[r.id] = r; savePrefs(); };
    api.clearAll = async () => { await loadPrefs(); prefs.ranges = {}; savePrefs(); };
    api.usage = async () => null;
    api.persist = async () => true;
    api.info = async () => (await fetch('api/info', { cache: 'no-store' })).json();
    api.collectNow = () => fetch('api/collect', { method: 'POST' });
  }

  api.detectAgent = detectAgent;
  return api;
})();
