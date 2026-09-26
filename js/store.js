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

  return { putFile, allFiles, deleteFile, putRange, allRanges, clearAll, persist, usage };
})();
