// Almacenamiento local en IndexedDB (queda en este navegador; no se envía a ningún servidor).
// Tiendas:
//   facturas  - una fila por factura (equivale a la Tabla1 del Excel + NIT, CUFE, etc.)
//   archivos  - PDF y XML adjuntos (Blob), índice por factura
//   config    - valores sueltos: fecha de la última copia, nombres aprendidos por NIT, etc.
const DB = (() => {
  const NOMBRE = 'cuentas-por-pagar';
  const VERSION = 1;
  let db;

  function abrir() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NOMBRE, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        const f = d.createObjectStore('facturas', { keyPath: 'id', autoIncrement: true });
        f.createIndex('clave', 'clave');
        f.createIndex('cufe', 'cufe');
        const a = d.createObjectStore('archivos', { keyPath: 'id', autoIncrement: true });
        a.createIndex('facturaId', 'facturaId');
        d.createObjectStore('config', { keyPath: 'k' });
      };
      req.onsuccess = () => { db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }

  // Aviso de cambios: la app lo usa para saber si hay datos que aún no están en una copia de seguridad
  let alCambiar = null;
  const onCambio = fn => { alCambiar = fn; };

  function tx(stores, modo, fn, silencioso = false) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, modo);
      let out;
      Promise.resolve(fn(t)).then(v => { out = v; });
      t.oncomplete = () => { if (modo === 'readwrite' && !silencioso && alCambiar) alCambiar(); resolve(out); };
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  const todas = store => tx([store], 'readonly', t => req2p(t.objectStore(store).getAll()));
  const obtener = (store, id) => tx([store], 'readonly', t => req2p(t.objectStore(store).get(id)));

  // Guarda (inserta o actualiza) y devuelve el id.
  const guardar = (store, obj) => tx([store], 'readwrite', t => req2p(t.objectStore(store).put(obj)));

  function guardarVarias(store, lista) {
    return tx([store], 'readwrite', t => {
      const s = t.objectStore(store);
      lista.forEach(o => s.put(o));
    });
  }

  const borrar = (store, id) => tx([store], 'readwrite', t => { t.objectStore(store).delete(id); });

  function archivosDe(facturaId) {
    return tx(['archivos'], 'readonly', t => req2p(t.objectStore('archivos').index('facturaId').getAll(facturaId)));
  }

  // Borra la factura y sus adjuntos.
  function borrarFactura(id) {
    return tx(['facturas', 'archivos'], 'readwrite', t => {
      t.objectStore('facturas').delete(id);
      const idx = t.objectStore('archivos').index('facturaId');
      idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = e => {
        const c = e.target.result;
        if (c) { t.objectStore('archivos').delete(c.primaryKey); c.continue(); }
      };
    });
  }

  async function cfg(k, def) {
    const r = await obtener('config', k);
    return r ? r.v : def;
  }
  // Registrar la fecha de la copia (o marcas internas) no cuenta como un cambio de datos
  const CFG_SIN_CAMBIO = ['ultimaCopia', 'ultimaCopiaCompleta'];
  const setCfg = (k, v) => tx(['config'], 'readwrite', t => req2p(t.objectStore('config').put({ k, v })), CFG_SIN_CAMBIO.includes(k));

  // Reemplaza TODO el contenido (usado al restaurar una copia).
  function reemplazarTodo({ facturas, archivos, config }) {
    return tx(['facturas', 'archivos', 'config'], 'readwrite', t => {
      for (const s of ['facturas', 'archivos', 'config']) t.objectStore(s).clear();
      facturas.forEach(o => t.objectStore('facturas').put(o));
      archivos.forEach(o => t.objectStore('archivos').put(o));
      config.forEach(o => t.objectStore('config').put(o));
    });
  }

  // Restaurar una copia "solo datos": reemplaza facturas y configuración, conserva los adjuntos.
  function reemplazarDatos({ facturas, config }) {
    return tx(['facturas', 'config'], 'readwrite', t => {
      t.objectStore('facturas').clear();
      t.objectStore('config').clear();
      facturas.forEach(o => t.objectStore('facturas').put(o));
      config.forEach(o => t.objectStore('config').put(o));
    });
  }

  async function persistir() {
    try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; }
    catch { return false; }
  }

  return { abrir, todas, obtener, guardar, guardarVarias, borrar, archivosDe, borrarFactura, cfg, setCfg, reemplazarTodo, reemplazarDatos, persistir, onCambio };
})();
