// Almacenamiento local en IndexedDB (queda en este navegador; no se envía a ningún servidor).
// Tiendas:
//   facturas   - una fila por factura (equivale a la Tabla1 del Excel + NIT, CUFE, etc.)
//   archivos   - PDF y XML adjuntos (Blob), índice por factura
//   config     - valores sueltos: fecha de la última copia, nombres aprendidos por NIT, etc.
//   historial  - puntos para Deshacer / Rehacer (facturas, configuración y lista de adjuntos de cada momento)
//   retenidos  - adjuntos eliminados que aún pueden volver con Deshacer
// Aparte, la base «cxp-local» guarda la carpeta de copias vinculada (no viaja en las copias ni se borra al restaurar).
const DB = (() => {
  const NOMBRE = 'cuentas-por-pagar';
  const VERSION = 2;
  let db;

  function abrir() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NOMBRE, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('facturas')) {
          const f = d.createObjectStore('facturas', { keyPath: 'id', autoIncrement: true });
          f.createIndex('clave', 'clave');
          f.createIndex('cufe', 'cufe');
        }
        if (!d.objectStoreNames.contains('archivos')) {
          const a = d.createObjectStore('archivos', { keyPath: 'id', autoIncrement: true });
          a.createIndex('facturaId', 'facturaId');
        }
        if (!d.objectStoreNames.contains('config')) d.createObjectStore('config', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('historial')) d.createObjectStore('historial');
        if (!d.objectStoreNames.contains('retenidos')) d.createObjectStore('retenidos', { keyPath: 'id' });
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
  const claves = store => tx([store], 'readonly', t => req2p(t.objectStore(store).getAllKeys()));
  const obtener = (store, id) => tx([store], 'readonly', t => req2p(t.objectStore(store).get(id)));

  // Guarda (inserta o actualiza) y devuelve el id.
  const guardar = (store, obj) => tx([store], 'readwrite', t => req2p(t.objectStore(store).put(obj)));

  function guardarVarias(store, lista) {
    return tx([store], 'readwrite', t => {
      const s = t.objectStore(store);
      lista.forEach(o => s.put(o));
    });
  }

  // Un adjunto eliminado se aparta en «retenidos» (para Deshacer) antes de quitarlo.
  function retenerYBorrar(t, id) {
    const r = t.objectStore('archivos').get(id);
    r.onsuccess = () => { if (r.result) { t.objectStore('retenidos').put(r.result); t.objectStore('archivos').delete(id); } };
  }
  const borrar = (store, id) => store === 'archivos'
    ? tx(['archivos', 'retenidos'], 'readwrite', t => { retenerYBorrar(t, id); })
    : tx([store], 'readwrite', t => { t.objectStore(store).delete(id); });

  function archivosDe(facturaId) {
    return tx(['archivos'], 'readonly', t => req2p(t.objectStore('archivos').index('facturaId').getAll(facturaId)));
  }

  // Borra la factura y aparta sus adjuntos (para Deshacer).
  function borrarFactura(id) {
    return tx(['facturas', 'archivos', 'retenidos'], 'readwrite', t => {
      t.objectStore('facturas').delete(id);
      const idx = t.objectStore('archivos').index('facturaId');
      idx.openCursor(IDBKeyRange.only(id)).onsuccess = e => {
        const c = e.target.result;
        if (c) { t.objectStore('retenidos').put(c.value); c.delete(); c.continue(); }
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

  // Reemplaza TODO el contenido (usado al restaurar una copia). El historial de Deshacer empieza de nuevo.
  function reemplazarTodo({ facturas, archivos, config }) {
    return tx(['facturas', 'archivos', 'config', 'historial', 'retenidos'], 'readwrite', t => {
      for (const s of ['facturas', 'archivos', 'config', 'historial', 'retenidos']) t.objectStore(s).clear();
      facturas.forEach(o => t.objectStore('facturas').put(o));
      archivos.forEach(o => t.objectStore('archivos').put(o));
      config.forEach(o => t.objectStore('config').put(o));
    });
  }

  // Restaurar una copia "solo datos": reemplaza facturas y configuración, conserva los adjuntos.
  function reemplazarDatos({ facturas, config }) {
    return tx(['facturas', 'config', 'historial'], 'readwrite', t => {
      t.objectStore('facturas').clear();
      t.objectStore('config').clear();
      t.objectStore('historial').clear();
      facturas.forEach(o => t.objectStore('facturas').put(o));
      config.forEach(o => t.objectStore('config').put(o));
    });
  }

  // ---------- Deshacer / Rehacer ----------
  // Foto del momento: facturas, configuración (sin las marcas de copia) e ids de los adjuntos.
  async function foto() {
    const [facturas, config, archivos] = await Promise.all([todas('facturas'), todas('config'), claves('archivos')]);
    return { facturas, config: config.filter(c => !CFG_SIN_CAMBIO.includes(c.k)), archivos };
  }
  // Vuelve los datos a una foto. Los adjuntos que sobran se apartan y los que faltan vuelven de «retenidos».
  // Es silencioso: no crea un punto nuevo en el historial (la app marca el cambio para la copia).
  function aplicarFoto(f) {
    return tx(['facturas', 'archivos', 'config', 'retenidos'], 'readwrite', t => {
      const fs = t.objectStore('facturas'), cs = t.objectStore('config'), as = t.objectStore('archivos'), rs = t.objectStore('retenidos');
      fs.clear(); f.facturas.forEach(o => fs.put(o));
      const marcas = [];
      cs.openCursor().onsuccess = e => {
        const c = e.target.result;
        if (c) { if (CFG_SIN_CAMBIO.includes(c.value.k)) marcas.push(c.value); c.continue(); return; }
        cs.clear().onsuccess = () => { f.config.forEach(o => cs.put(o)); marcas.forEach(o => cs.put(o)); };
      };
      const quiero = new Set(f.archivos);
      as.getAllKeys().onsuccess = e => {
        const hay = new Set(e.target.result);
        for (const id of hay) if (!quiero.has(id)) { const r = as.get(id); r.onsuccess = () => { rs.put(r.result); as.delete(id); }; }
        for (const id of quiero) if (!hay.has(id)) { const r = rs.get(id); r.onsuccess = () => { if (r.result) { as.put(r.result); rs.delete(id); } }; }
      };
    }, true);
  }
  const histLeer = k => tx(['historial'], 'readonly', t => req2p(t.objectStore('historial').get(k)));
  const histPoner = (k, v) => tx(['historial'], 'readwrite', t => { t.objectStore('historial').put(v, k); }, true);
  const histQuitar = ks => tx(['historial'], 'readwrite', t => { ks.forEach(k => t.objectStore('historial').delete(k)); }, true);
  const histLimpiar = () => tx(['historial'], 'readwrite', t => { t.objectStore('historial').clear(); }, true);
  // Quita de «retenidos» lo que ya ningún punto del historial necesita.
  const limpiarRetenidos = usados => tx(['retenidos'], 'readwrite', t => {
    const s = t.objectStore('retenidos');
    s.getAllKeys().onsuccess = e => { for (const k of e.target.result) if (!usados.has(k)) s.delete(k); };
  }, true);

  // ---------- Base local: carpeta de copias vinculada ----------
  let dbLocal = null;
  const abrirLocal = () => dbLocal ? Promise.resolve(dbLocal) : new Promise((ok, mal) => {
    const r = indexedDB.open('cxp-local', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('k');
    r.onsuccess = () => { dbLocal = r.result; ok(dbLocal); };
    r.onerror = () => mal(r.error);
  });
  const local = async (modo, fn) => { const d = await abrirLocal(); return new Promise((ok, mal) => { const t = d.transaction('k', modo); let out; const q = fn(t.objectStore('k')); if (q) q.onsuccess = () => { out = q.result; }; t.oncomplete = () => ok(out); t.onerror = () => mal(t.error); }); };
  const localLeer = k => local('readonly', s => s.get(k)).catch(() => null);
  const localPoner = (k, v) => local('readwrite', s => s.put(v, k)).catch(() => {});

  async function persistir() {
    try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; }
    catch { return false; }
  }

  return { abrir, todas, claves, obtener, guardar, guardarVarias, borrar, archivosDe, borrarFactura, cfg, setCfg, reemplazarTodo, reemplazarDatos, persistir, onCambio,
    foto, aplicarFoto, histLeer, histPoner, histQuitar, histLimpiar, limpiarRetenidos, localLeer, localPoner };
})();
