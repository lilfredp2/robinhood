/* Parlor — what the browser keeps.
   Text lives in localStorage, pictures in IndexedDB. Both are guarded: a
   browser with storage blocked keeps working, it just forgets. */

const LOG_KEY = 'parlor:log';
const PREF_KEY = 'parlor:prefs';
const LOG_LIMIT = 300;

const DB_NAME = 'parlor';
const DB_VERSION = 1;
const STORE = 'pictures';

/* ── Small values ──────────────────────────────────────────────────────── */

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

export const prefs = {
  read() { return readJSON(PREF_KEY, {}); },
  patch(part) { return writeJSON(PREF_KEY, { ...prefs.read(), ...part }); },
};

export const log = {
  read() {
    const entries = readJSON(LOG_KEY, []);
    return Array.isArray(entries) ? entries : [];
  },
  write(entries) { return writeJSON(LOG_KEY, entries.slice(-LOG_LIMIT)); },
  clear() { try { localStorage.removeItem(LOG_KEY); } catch { /* nothing to do */ } },
};

/* ── Pictures ──────────────────────────────────────────────────────────── */

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { reject(new Error('No IndexedDB')); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((err) => { dbPromise = null; throw err; });
  return dbPromise;
}

function run(mode, work) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = work(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  })).catch((err) => { console.warn('Parlor: picture store unavailable —', err?.message || err); return undefined; });
}

export const pictures = {
  put(record) { return run('readwrite', (store) => store.put(record)); },
  get(id) { return run('readonly', (store) => store.get(id)); },
  all() { return run('readonly', (store) => store.getAll()).then((rows) => rows || []); },
  clear() { return run('readwrite', (store) => store.clear()); },
};

/* ── Preparing a picture for the wire ──────────────────────────────────── */

const MAX_EDGE = 1600;
const QUALITY = 0.82;

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch { /* fall back below */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // The bitmap is drawn synchronously by the caller, so the URL can go now.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode the picture.')), type, quality);
  });
}

/**
 * Scale a picture down to MAX_EDGE and re-encode it, so what goes over the wire
 * is a few hundred kilobytes rather than a phone camera's several megabytes.
 * GIFs are passed through untouched, since re-encoding would kill the animation.
 */
export async function prepare(file) {
  const name = file.name || 'picture';
  if (file.type === 'image/gif' || file.size < 120 * 1024) {
    const size = await measure(file);
    return { blob: file, type: file.type || 'image/jpeg', name, ...size };
  }

  const source = await decode(file);
  const w = source.width;
  const h = source.height;
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const width = Math.max(1, Math.round(w * scale));
  const height = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(source, 0, 0, width, height);
  if (typeof source.close === 'function') source.close();

  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await canvasToBlob(canvas, type, QUALITY);
  // Keep whichever is smaller: re-encoding a small PNG can make it bigger.
  if (blob.size >= file.size && scale === 1) return { blob: file, type: file.type, name, width: w, height: h };
  return { blob, type, name, width, height };
}

async function measure(file) {
  try {
    const bitmap = await decode(file);
    const size = { width: bitmap.width, height: bitmap.height };
    if (typeof bitmap.close === 'function') bitmap.close();
    return size;
  } catch { return { width: 0, height: 0 }; }
}

export function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
