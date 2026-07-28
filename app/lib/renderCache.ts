// ---------------------------------------------------------------------------
// Persistente cache voor NOW-slide-renders (PNG-dataUrls) in IndexedDB.
//
// De engine rendert elke slide met een headless browser — traag en duur. Door
// het resultaat hier op te slaan kan CarouselNowPreview bij het heropenen van
// een carousel de eerder gerenderde beelden direct tonen en alleen slides
// renderen waarvan de inhoud écht veranderd is.
//
// Alles is fail-soft: elke IndexedDB-fout levert een leeg resultaat of no-op
// op en gooit nooit naar de aanroeper. Zonder `indexedDB` (SSR) gebeurt er
// gewoon niets.
// ---------------------------------------------------------------------------

const DB_NAME = 'carousel-render-cache';
const DB_VERSION = 1;
const STORE = 'renders';

// Bump bij een wijziging van het entry-formaat: de sleutel-prefix verandert
// mee, waardoor oude entries nooit meer gevonden worden en vanzelf door de
// pruning worden opgeruimd.
const SCHEMA = 'v1';

// Pruning: entries ouder dan 7 dagen weg, en nooit meer dan ~300 entries
// (oudste eerst weg, LRU-achtig).
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 300;

interface RenderEntry {
  /** `${SCHEMA}|${articleId}|${sleutel van de aanroeper}` */
  key: string;
  articleId: number;
  dataUrl: string;
  updatedAt: number;
}

const keyPrefix = (articleId: number) => `${SCHEMA}|${articleId}|`;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('updatedAt', 'updatedAt');
        store.createIndex('articleId', 'articleId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Alle gecachte sleutel→dataUrl-entries van dit artikel. */
export async function loadRenderCache(articleId: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const db = await openDb();
  if (!db) return out;
  try {
    const entries = await new Promise<RenderEntry[]>(resolve => {
      try {
        const req = db
          .transaction(STORE, 'readonly')
          .objectStore(STORE)
          .index('articleId')
          .getAll(IDBKeyRange.only(articleId));
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
    const prefix = keyPrefix(articleId);
    for (const e of entries) {
      // Entries met een oudere SCHEMA-prefix vallen hier vanzelf af.
      if (typeof e?.key === 'string' && e.key.startsWith(prefix) && typeof e.dataUrl === 'string') {
        out.set(e.key.slice(prefix.length), e.dataUrl);
      }
    }
  } catch {
    // fail-soft: lege map teruggeven
  } finally {
    db.close();
  }
  return out;
}

/** Upsert van één render; ruimt daarna (fire-and-forget) oude entries op. */
export async function saveRender(articleId: number, key: string, dataUrl: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>(resolve => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const entry: RenderEntry = {
          key: keyPrefix(articleId) + key,
          articleId,
          dataUrl,
          updatedAt: Date.now(),
        };
        tx.objectStore(STORE).put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
    await prune(db);
  } catch {
    // fail-soft
  } finally {
    db.close();
  }
}

/** Alle cache-entries van dit artikel weggooien (bij verwijderen carousel). */
export async function clearArticleRenders(articleId: number): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>(resolve => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const req = store.index('articleId').openKeyCursor(IDBKeyRange.only(articleId));
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) {
            store.delete(cur.primaryKey);
            cur.continue();
          }
        };
        req.onerror = () => resolve();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  } catch {
    // fail-soft
  } finally {
    db.close();
  }
}

// Verwijder verlopen entries en houd het totaal onder MAX_ENTRIES. Via een
// key-cursor zodat de (zware) dataUrls niet gelezen hoeven te worden.
function prune(db: IDBDatabase): Promise<void> {
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      // De updatedAt-index loopt oplopend: oudste entries eerst.
      const req = store.index('updatedAt').openKeyCursor();
      const keys: { primary: IDBValidKey; updatedAt: number }[] = [];
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          keys.push({ primary: cur.primaryKey, updatedAt: Number(cur.key) });
          cur.continue();
          return;
        }
        const cutoff = Date.now() - MAX_AGE_MS;
        const stale = keys.filter(k => k.updatedAt < cutoff);
        const fresh = keys.filter(k => k.updatedAt >= cutoff);
        const surplus = Math.max(0, fresh.length - MAX_ENTRIES);
        for (const k of [...stale, ...fresh.slice(0, surplus)]) store.delete(k.primary);
      };
      req.onerror = () => resolve();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
