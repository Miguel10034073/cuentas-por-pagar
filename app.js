// Facturas por cancelar: registro de cuentas por pagar con importación de XML DIAN,
// adjuntos PDF, pagos y copias de seguridad. Todo queda en IndexedDB de este navegador.
(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  // ---------- estado ----------
  let facturas = [];               // todas las facturas
  let adj = new Map();             // facturaId -> { pdf: [ids], xml: [ids] }
  let nitProveedor = {};           // NIT -> nombre de proveedor usado en la app
  let nitEmpresa = {};             // NIT del adquiriente -> "Empresa facturada"
  let provInfo = {};               // clave proveedor (NIT o n:nombre) -> { persona, resp: [], concepto, fuente }
  let empInfo = {};                // nombre de empresa -> { nit, resp: [], agenteRet }
  let clasifProducto = {};         // "NIT|código" -> concepto de retención usado la última vez
  let tab = 'pendientes';
  let orden = { pendientes: ['vencimiento', 1], historico: ['fecha', -1] };
  let limite = 300;
  // Pendientes agrupados por proveedor (lo que antes era la pestaña Reporte); se recuerda en este navegador
  let agrupar = (() => { try { return localStorage.getItem('cxp-agrupar') === '1'; } catch { return false; } })();
  const sel = new Set();

  // ---------- utilidades ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const red = v => Math.round((+v || 0) * 100) / 100;
  const pesos = v => '$ ' + Math.round(+v || 0).toLocaleString('es-CO');
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hoy = () => iso(new Date());
  const fechaTxt = s => s ? s.split('-').reverse().join('/') : '';
  const aUTC = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const dias = (desde, hasta) => (desde && hasta) ? Math.round((aUTC(hasta) - aUTC(desde)) / 864e5) : null;
  const sumarDias = (s, n) => { const d = new Date(aUTC(s) + n * 864e5); return d.toISOString().slice(0, 10); };
  const sinTildes = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const SUFIJOS = new Set(['sas', 'sa', 's', 'a', 'ltda', 'limitada', 'eu', 'sca', 'bic', 'y', 'cia', 'e']);
  // Nombre normalizado para comparar proveedores ("ALFONSOEME S.A." == "Alfonsoeme Sa")
  const norm = s => sinTildes(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter(t => t && !SUFIJOS.has(t)).join(' ');
  const normNum = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Sin número (p. ej. cuentas de cobro mensuales) se usa la fecha para distinguirlas.
  const claveDe = (prov, num, fecha = '') => `${norm(prov)}|${normNum(num) || 'SN' + fecha}`;
  // ---------- documentos: facturas, notas crédito y anticipos ----------
  // Nota crédito y anticipo son CRÉDITOS a favor: se guardan con valores positivos y se aplican a facturas
  // del proveedor en d.aplicaciones = [{ facturaId, valor }]. Nota débito se trata como una factura.
  const TIPOS_CREDITO = ['Nota crédito', 'Anticipo'];
  const esCredito = f => TIPOS_CREDITO.includes(f.tipoDoc);
  let aplicadoA = new Map();       // facturaId -> suma de notas crédito / anticipos aplicados
  const aplicadoDe = d => red((d.aplicaciones || []).reduce((a, x) => a + (+x.valor || 0), 0));
  const disponible = d => red((+d.total || 0) - aplicadoDe(d));
  const creditosDe = f => red(aplicadoA.get(f.id) || 0);
  // Saldo por pagar: factura = total − créditos aplicados (0 si se pagó); crédito = −(valor aún sin aplicar)
  function saldo(f) {
    if (esCredito(f)) return -Math.max(0, disponible(f));
    if (f.fechaPago || f.pagoRef) return 0;
    return red((+f.total || 0) - creditosDe(f));
  }
  // Pagada / cerrada: con fecha de pago o referencia de cruce (como en el Excel), o saldada con créditos;
  // un crédito queda cerrado cuando se aplicó completo.
  const pagada = f => esCredito(f) ? disponible(f) <= 0.5
    : !!(f.fechaPago || f.pagoRef) || (creditosDe(f) > 0 && saldo(f) <= 0.5);
  // Nota crédito: reversa las retenciones de la(s) factura(s) que afecta, en la misma proporción de su base.
  // Anula el 100% de la base -> reversa el 100% de la ReteFuente y ReteIVA, y la nota queda igual al saldo de la factura.
  function reversionRet(bruto, facturasAfectadas) {
    const fs = facturasAfectadas.filter(f => f && +f.bruto > 0);
    const base = fs.reduce((a, f) => a + (+f.bruto || 0), 0);
    if (!base) return { reteiva: 0, retefuente: 0, factor: 0, fs };
    const factor = Math.min(1, Math.abs(+bruto || 0) / base);
    const suma = k => fs.reduce((a, f) => a + (+f[k] || 0), 0);
    return { reteiva: Math.round(suma('reteiva') * factor), retefuente: Math.round(suma('retefuente') * factor), factor, fs };
  }
  // Factura que referencia una nota crédito (por CUFE o por número + proveedor)
  function facturaReferida(nc) {
    if (!nc.facturaRef && !nc.facturaRefCufe) return null;
    const ref = normNum(nc.facturaRef);
    return facturas.find(x => !esCredito(x) && nc.facturaRefCufe && x.cufe === nc.facturaRefCufe)
      || facturas.find(x => !esCredito(x) && ref && normNum(x.numero) === ref && (x.nit === nc.nit || norm(x.proveedor) === norm(nc.proveedor))) || null;
  }
  // Facturas a las que afecta una nota: las que tiene aplicadas o, si aún no, la referenciada
  function facturasAfectadas(nc, aplic) {
    const ids = (aplic || []).filter(a => +a.valor > 0).map(a => a.facturaId);
    const fs = facturas.filter(f => ids.includes(f.id));
    if (fs.length) return fs;
    const ref = facturaReferida(nc);
    return ref ? [ref] : [];
  }

  function recalcularAplicaciones() {
    aplicadoA = new Map();
    facturas.forEach(d => (d.aplicaciones || []).forEach(a => aplicadoA.set(a.facturaId, (aplicadoA.get(a.facturaId) || 0) + (+a.valor || 0))));
  }
  const limpio = s => String(s || '').trim().replace(/\s+/g, ' ');
  const titulo = s => limpio(s).toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
  // Mismas palabras en cualquier orden ("PEREZ SANCHEZ RAUL" == "Raul Perez Sanchez")
  const normSet = s => norm(s).split(' ').filter(Boolean).sort().join(' ');
  // NIT sin puntos ni dígito de verificación ("800.123.456-7" -> "800123456")
  const normNit = s => String(s || '').split('-')[0].replace(/[^0-9]/g, '');

  // Nombres oficiales de las empresas facturadas. Los nombres antiguos (del Excel) se
  // reemplazan automáticamente al cargar los datos.
  const EMPRESAS = [
    // agenteRet: obligada a practicar retención en la fuente por renta (valor inicial; se edita en ⋯ → Empresas)
    { nombre: 'Inversiones Mindala SAS', nit: '900588025', agenteRet: true, alias: ['INV MINDALA', 'MINDALA', 'INVERSIONES MINDALA'] },
    { nombre: 'Dora Helena Mejia Alzate', nit: '21847885', agenteRet: false, alias: ['DORA MEJIA', 'MEJIA ALZATE DORA HELENA'] },
  ];
  const empresaOficial = s => {
    const k = normSet(s);
    const e = k && EMPRESAS.find(e => [e.nombre, ...e.alias].some(a => normSet(a) === k));
    return e ? e.nombre : limpio(s);
  };

  function toast(msg, ms = 4000) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
  }

  // Fecha y hora legibles: "29/09/2026, 4:49 p. m."
  const fechaHora = s => new Date(s).toLocaleString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  function hace(s) {
    const min = Math.round((Date.now() - new Date(s).getTime()) / 60000);
    if (min < 1) return 'hace un momento';
    if (min < 60) return `hace ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.round(h / 24);
    return `hace ${d} ${d === 1 ? 'día' : 'días'}`;
  }

  // Cambios que aún no están en ninguna copia de seguridad (se guarda en este navegador)
  const lsLeer = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsPoner = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };
  let ultimoCambio = lsLeer('cxp-ultimoCambio');
  const cambiosSinCopia = () => !!ultimoCambio && (!revisarCopia.ultima || ultimoCambio > revisarCopia.ultima);
  DB.onCambio(() => {
    ultimoCambio = new Date().toISOString();
    lsPoner('cxp-ultimoCambio', ultimoCambio);
    clearTimeout(DB._t); DB._t = setTimeout(() => { revisarCopia().then(renderKpis); }, 400);
  });

  function descargar(blob, nombre) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function estado(f) {
    if (esCredito(f)) return pagada(f) ? { k: 'pagada', txt: 'Aplicada', cls: 'ok' }
      : { k: 'credito', txt: aplicadoDe(f) ? `${f.tipoDoc}: saldo por aplicar` : `${f.tipoDoc} por aplicar`, cls: 'ok', d: null };
    if (pagada(f)) return { k: 'pagada', txt: f.fechaPago || f.pagoRef ? 'Pagada' : 'Cruzada con créditos', cls: 'ok' };
    const d = dias(hoy(), f.vencimiento);
    if (d === null) return { k: 'sin', txt: 'Sin vencimiento', cls: 'neutral', d };
    if (d < 0) return { k: 'vencida', txt: `Vencida hace ${-d} d`, cls: 'bad', d };
    if (d === 0) return { k: 'hoy', txt: 'Vence hoy', cls: 'bad', d };
    if (d <= 7) return { k: 'pronto', txt: `Vence en ${d} d`, cls: 'warn', d };
    return { k: 'aldia', txt: `Vence en ${d} d`, cls: 'neutral', d };
  }

  // ---------- carga ----------
  async function cargar() {
    facturas = await DB.todas('facturas');
    const archivos = await DB.todas('archivos');
    adj = new Map();
    for (const a of archivos) {
      if (!adj.has(a.facturaId)) adj.set(a.facturaId, { pdf: [], xml: [], pago: [] });
      adj.get(a.facturaId)[a.tipo]?.push(a.id);
    }
    nitProveedor = await DB.cfg('nitProveedor', {});
    nitEmpresa = await DB.cfg('nitEmpresa', {});
    provInfo = await DB.cfg('proveedoresInfo', {});
    empInfo = await DB.cfg('empresasInfo', {});
    clasifProducto = await DB.cfg('clasifProducto', {});
    await migrar();
    recalcularAplicaciones();
    llenarListas();
    render();
    await revisarCopia();
    renderKpis();   // con la fecha de la última copia ya leída
  }

  // Catálogo nombre de proveedor -> NIT, armado con: facturas que ya tienen NIT, lo aprendido
  // de los XML y la lista inicial sacada de los XML de la carpeta de contabilidad.
  function catalogoNits() {
    const cat = new Map(), conflicto = new Set();
    const poner = (nombre, nit) => {
      const k = normSet(nombre), n = normNit(nit);
      if (!k || !n || conflicto.has(k)) return;
      if (cat.has(k) && cat.get(k) !== n) { cat.delete(k); conflicto.add(k); return; }
      cat.set(k, n);
    };
    (window.PROVEEDORES_SEMILLA || []).forEach(([nit, nombre]) => poner(nombre, nit));
    Object.entries(nitProveedor).forEach(([nit, nombre]) => { conflicto.delete(normSet(nombre)); cat.set(normSet(nombre), normNit(nit)); });
    facturas.forEach(f => { if (f.nit) { conflicto.delete(normSet(f.proveedor)); cat.set(normSet(f.proveedor), normNit(f.nit)); } });
    return cat;
  }
  const nitDe = nombre => catalogoNits().get(normSet(nombre)) || '';

  // Ajustes automáticos e idempotentes sobre los datos guardados (también se aplican a copias restauradas):
  // nombres oficiales de las empresas, NIT del proveedor y fecha de recepción.
  async function migrar() {
    const cat = catalogoNits();
    const cambios = [];
    for (const f of facturas) {
      const n = { ...f };
      n.empresa = empresaOficial(f.empresa);
      if (f.empresaPago) n.empresaPago = empresaOficial(f.empresaPago);
      if (!f.nit) n.nit = cat.get(normSet(f.proveedor)) || '';
      if (f.fechaRecepcion === undefined) n.fechaRecepcion = f.fecha || '';
      // Notas crédito importadas antes con valores negativos: ahora son créditos con valores positivos
      if (f.tipoDoc === 'Nota crédito' && +f.total < 0) {
        for (const k of ['bruto', 'iva', 'reteiva', 'retefuente', 'total']) n[k] = -(+f[k] || 0) || 0;
        if (!f.aplicaciones) n.aplicaciones = [];
      }
      if (['empresa', 'empresaPago', 'nit', 'fechaRecepcion', 'total'].some(k => (n[k] ?? '') !== (f[k] ?? ''))) {
        Object.assign(f, n); cambios.push(f);
      }
    }
    if (cambios.length) await DB.guardarVarias('facturas', cambios);
    await corregirRetencionDoble();
    await corregirReversionNC();
    let cambioEmp = false;
    for (const [nit, nom] of Object.entries(nitEmpresa)) {
      const o = empresaOficial(nom);
      if (o !== nom) { nitEmpresa[nit] = o; cambioEmp = true; }
    }
    for (const e of EMPRESAS) if (e.nit && !nitEmpresa[e.nit]) { nitEmpresa[e.nit] = e.nombre; cambioEmp = true; }
    if (cambioEmp) await DB.setCfg('nitEmpresa', nitEmpresa);
  }

  // ReteFuente histórica del Excel: fila 'manual' sin base. Cuando la factura ya tiene el cálculo por ítems
  // del XML, esa fila no debe sumarse (sería la misma retención dos veces).
  const esHistorica = r => r.concepto === 'manual' && (r.historico || r.base === '' || r.base == null);

  // Reparación: facturas guardadas con el cálculo por ítems MÁS la ReteFuente histórica del Excel.
  // Notas crédito registradas antes de la reversión de retenciones: se recalculan una vez.
  // Ej.: NCJO8 por $650.000 sobre FEJO3 con ReteFuente → la nota neta queda igual al saldo de la factura y cruza.
  async function corregirReversionNC() {
    const cambios = [];
    for (const nc of facturas.filter(f => f.tipoDoc === 'Nota crédito' && f.reversarRet === undefined)) {
      const rv = reversionRet(nc.bruto, facturasAfectadas(nc, nc.aplicaciones));
      nc.reversarRet = true;
      if (rv.reteiva || rv.retefuente) {
        nc.reteiva = rv.reteiva; nc.retefuente = rv.retefuente;
        nc.total = red((+nc.bruto || 0) + (+nc.iva || 0) - rv.reteiva - rv.retefuente);
        // Si ya tenía aplicado más que su nuevo valor neto, se recorta lo aplicado
        let exceso = red(aplicadoDe(nc) - nc.total);
        for (const a of [...(nc.aplicaciones || [])].reverse()) { if (exceso <= 0) break; const q = Math.min(exceso, a.valor); a.valor = red(a.valor - q); exceso = red(exceso - q); }
        nc.aplicaciones = (nc.aplicaciones || []).filter(a => a.valor > 0);
        cambios.push(nc);
      } else cambios.push(nc);
    }
    if (cambios.length) await DB.guardarVarias('facturas', cambios);
    const ajustadas = cambios.filter(n => n.retefuente || n.reteiva);
    if (ajustadas.length) setTimeout(() => toast(`Se reversaron las retenciones en ${ajustadas.length} ${ajustadas.length === 1 ? 'nota crédito' : 'notas crédito'}: ${ajustadas.map(n => n.numero).join(', ')}`, 9000), 800);
  }

  async function corregirRetencionDoble() {
    const cambios = [];
    for (const f of facturas) {
      const rs = f.retenciones || [];
      if (!rs.some(r => r.origen === 'items') || !rs.some(esHistorica)) continue;
      f.retenciones = rs.filter(r => !esHistorica(r));
      f.retefuente = red(f.retenciones.reduce((a, r) => a + (+r.valor || 0), 0));
      f.total = red((+f.bruto || 0) + (+f.iva || 0) - (+f.reteiva || 0) - f.retefuente);
      cambios.push(f);
    }
    if (cambios.length) {
      await DB.guardarVarias('facturas', cambios);
      setTimeout(() => toast(`Se corrigió la ReteFuente duplicada en ${cambios.length} ${cambios.length === 1 ? 'factura' : 'facturas'}: ${cambios.map(f => f.numero).join(', ')}`, 9000), 500);
    }
  }

  const unicos = campo => [...new Set(facturas.map(f => limpio(f[campo])).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));

  function llenarListas() {
    const opts = l => l.map(v => `<option value="${esc(v)}">`).join('');
    $('#dlProveedores').innerHTML = opts(unicos('proveedor'));
    $('#dlEmpresas').innerHTML = opts([...new Set([...EMPRESAS.map(e => e.nombre), ...unicos('empresa')])]);
    $('#dlCentros').innerHTML = opts(unicos('centro'));
    $('#dlPagadores').innerHTML = opts(unicos('empresaPago'));
    for (const [id, campo, todos] of [['#fEmpresa', 'empresa', 'Todas las empresas'], ['#fCentro', 'centro', 'Todos los centros']]) {
      const s = $(id), v = s.value;
      s.innerHTML = `<option value="">${todos}</option>` + unicos(campo).map(x => `<option>${esc(x)}</option>`).join('');
      s.value = v;
    }
  }

  // ---------- filtros ----------
  function filtradas() {
    const txt = norm($('#fTexto').value);
    const emp = $('#fEmpresa').value, cen = $('#fCentro').value, est = $('#fEstado').value;
    const desde = $('#fDesde').value, hasta = $('#fHasta').value;
    const recD = $('#fRecDesde').value, recH = $('#fRecHasta').value;
    const venD = $('#fVenDesde').value, venH = $('#fVenHasta').value;
    // Rango de fechas: si hay límite y la factura no tiene la fecha, queda por fuera
    const enRango = (v, d, h) => (!d && !h) || (!!v && (!d || v >= d) && (!h || v <= h));
    return facturas.filter(f => {
      if (tab !== 'historico' && pagada(f)) return false;
      if (!enRango(f.fechaRecepcion, recD, recH)) return false;
      if (!enRango(f.vencimiento, venD, venH)) return false;
      if (emp && limpio(f.empresa) !== emp) return false;
      if (cen && limpio(f.centro) !== cen) return false;
      if (est === 'vencida' && !(estado(f).d < 0 && !pagada(f))) return false;
      if (est === '7') { const e = estado(f); if (pagada(f) || e.d === null || e.d < 0 || e.d > 7) return false; }
      if (est === 'sinpdf' && adj.get(f.id)?.pdf.length) return false;
      if (est === 'sincomp' && (esCredito(f) || !pagada(f) || adj.get(f.id)?.pago?.length)) return false;
      if (tab === 'historico' && (desde || hasta)) {
        if (!f.fechaPago) return false;
        if (desde && f.fechaPago < desde) return false;
        if (hasta && f.fechaPago > hasta) return false;
      }
      if (txt) {
        const h = norm(`${f.proveedor} ${f.numero} ${f.nit} ${f.cufe} ${f.empresa} ${f.centro} ${f.notas} ${f.empresaPago}`);
        if (!txt.split(' ').every(t => h.includes(t))) return false;
      }
      return true;
    });
  }

  function ordenar(lista) {
    const [campo, dir] = orden[tab] || ['fecha', -1];
    return lista.sort((a, b) => {
      let x = campo === '_saldo' ? saldo(a) : a[campo] ?? '', y = campo === '_saldo' ? saldo(b) : b[campo] ?? '';
      if (typeof x === 'number' || typeof y === 'number') return ((+x || 0) - (+y || 0)) * dir;
      if (!x && y) return 1; if (x && !y) return -1;  // vacíos al final
      return String(x).localeCompare(String(y), 'es', { numeric: true }) * dir;
    });
  }

  // ---------- render ----------
  function render() {
    document.body.className = 'tab-' + tab;
    $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    renderKpis();
    for (const [a, b] of [['#fRecDesde', '#fRecHasta'], ['#fVenDesde', '#fVenHasta'], ['#fDesde', '#fHasta']]) {
      $(a).closest('fieldset').classList.toggle('activo', !!($(a).value || $(b).value));
    }
    if (tab === 'pendientes' && agrupar) renderReporte();
    else if (tab === 'proveedores') renderProveedores();
    else renderTabla();
    renderSel();
    if ($('#dlgFicha').open) pintarFicha();
  }

  // Texto de los rangos de fecha activos (para el encabezado del reporte y el nombre del Excel)
  function rangosActivos() {
    const r = (nom, d, h) => {
      const a = $(d).value, b = $(h).value;
      if (!a && !b) return '';
      return `${nom} ${a && b ? `del ${fechaTxt(a)} al ${fechaTxt(b)}` : a ? `desde el ${fechaTxt(a)}` : `hasta el ${fechaTxt(b)}`}`;
    };
    return [r('Recepción', '#fRecDesde', '#fRecHasta'), r('Vencimiento', '#fVenDesde', '#fVenHasta'),
      tab === 'historico' ? r('Pago', '#fDesde', '#fHasta') : ''].filter(Boolean);
  }

  const provCelda = f => `<button class="link" data-ficha="${esc(limpio(f.proveedor))}" title="Ver ficha del proveedor">${esc(f.proveedor)}</button>
    <div class="nit">${f.nit ? 'NIT ' + esc(f.nit) : '<span class="chip warn">Sin NIT</span>'}</div>`;

  function renderKpis() {
    const abiertos = facturas.filter(f => !pagada(f));
    const pend = abiertos.filter(f => !esCredito(f)), creditos = abiertos.filter(esCredito);
    const venc = pend.filter(f => estado(f).d < 0);
    const pronto = pend.filter(f => { const d = estado(f).d; return d !== null && d >= 0 && d <= 7; });
    const mes = hoy().slice(0, 7);
    const pagMes = facturas.filter(f => !esCredito(f) && (f.fechaPago || '').startsWith(mes));
    const s = l => l.reduce((a, f) => a + saldo(f), 0);                      // saldos (créditos restan)
    const sPagado = l => l.reduce((a, f) => a + (+f.total || 0) - creditosDe(f), 0);
    const ult = revisarCopia.ultima;
    const diasCopia = ult ? dias(ult.slice(0, 10), hoy()) : null;
    $('#kpis').innerHTML = `
      <div class="kpi"><div class="lbl">Total por pagar</div><div class="val">${pesos(s(abiertos))}</div>
        <div class="det">${pend.length} facturas${creditos.length ? ` · menos ${pesos(-s(creditos))} en ${creditos.length} ${creditos.length === 1 ? 'crédito' : 'créditos'} por aplicar` : ''}</div></div>
      <div class="kpi ${venc.length ? 'alerta' : ''}"><div class="lbl">Vencido</div><div class="val">${pesos(s(venc))}</div><div class="det">${venc.length} facturas</div></div>
      <div class="kpi"><div class="lbl">Vence en los próximos 7 días</div><div class="val">${pesos(s(pronto))}</div><div class="det">${pronto.length} facturas</div></div>
      <div class="kpi"><div class="lbl">Pagado este mes</div><div class="val">${pesos(sPagado(pagMes))}</div><div class="det">${pagMes.length} facturas</div></div>
      <div class="kpi ${diasCopia === null || diasCopia > 7 || cambiosSinCopia() ? 'alerta' : ''}"><div class="lbl">Última copia de seguridad</div>
        <div class="val" style="font-size:16px">${ult ? fechaHora(ult) : 'Nunca'}</div>
        <div class="det">${!ult ? "Descargue una copia" : `Copia de seguridad · ${hace(ult)}`}
          ${cambiosSinCopia() ? '<br><b class="rojo">Hay cambios sin respaldar</b>' : ''}</div></div>`;
  }

  function celdasAdj(f) {
    const a = adj.get(f.id) || { pdf: [], xml: [], pago: [] };
    const pdf = a.pdf.length
      ? `<button class="icono pdf" data-abrir="${a.pdf[0]}" title="Abrir PDF">PDF</button>`
      : `<button class="btn sm ghost" data-addpdf="${f.id}" title="Adjuntar PDF">+ PDF</button>`;
    const xml = a.xml.length ? ` <button class="icono xml" data-abrir="${a.xml[0]}" title="Descargar XML">XML</button>` : '';
    const pago = a.pago?.length ? ` <button class="icono pago" data-abrir="${a.pago[0]}" title="Abrir comprobante de pago${a.pago.length > 1 ? ` (hay ${a.pago.length}; véalos todos en la factura)` : ''}">PAGO</button>` : '';
    return pdf + xml + pago;
  }

  // Valor con signo: los créditos (notas crédito, anticipos) restan
  const valorDoc = f => esCredito(f) ? -(+f.total || 0) : (+f.total || 0);
  const ABREV_TIPO = { 'Nota crédito': 'NC', 'Nota débito': 'ND', 'Anticipo': 'Anticipo' };
  const chipTipo = f => ABREV_TIPO[f.tipoDoc] ? ` <span class="chip tipo ${esCredito(f) ? 'credito' : ''}" title="${esc(f.tipoDoc)}">${ABREV_TIPO[f.tipoDoc]}</span>` : '';

  function renderTabla() {
    const lista = ordenar(filtradas());
    const hist = tab === 'historico';
    const cols = [
      ['proveedor', 'Proveedor'], ['numero', 'No factura'], ['empresa', 'Empresa facturada'], ['centro', 'Centro'],
      ['fecha', 'Fecha factura'], ['fechaRecepcion', 'Recepción'], ['vencimiento', 'Vencimiento'],
      ...(hist ? [['fechaPago', 'Fecha pago'], ['empresaPago', 'Pagó']] : [['_estado', 'Estado']]),
      ['total', 'Total factura'],
      ...(hist ? [] : [['_saldo', 'Saldo']]),
    ];
    if (!facturas.length) {
      $('#vista').innerHTML = `<div class="vacio">
        <p><b>No hay facturas todavía.</b></p>
        <p>Use <b>Importar XML (+ PDF)</b> para registrar facturas nuevas (también puede arrastrar los archivos a esta ventana),<br>
        o <b>⋯ → Restaurar copia de seguridad</b> para cargar una copia guardada.</p></div>`;
      return;
    }
    if (!lista.length) { $('#vista').innerHTML = `<div class="vacio">Ninguna factura coincide con los filtros.</div>`; return; }
    const [oc, od] = orden[tab];
    const total = lista.reduce((a, f) => a + valorDoc(f), 0);
    const totalSaldo = lista.reduce((a, f) => a + saldo(f), 0);
    const seleccionables = lista.filter(f => !esCredito(f));
    const selTodas = !hist && seleccionables.length && seleccionables.every(f => sel.has(f.id));
    const nCols = cols.length + (hist ? 0 : 1) + 1;
    const nNum = hist ? 1 : 2;   // columnas numéricas al final (total [, saldo])

    // Histórico: agrupado por proveedor con subtotal. Dentro de cada proveedor se respeta el
    // orden elegido; los proveedores van por nombre (o por subtotal si se ordena por Total).
    let cuerpo, mostradas;
    if (hist) {
      const grupos = new Map();
      lista.forEach(f => { const p = limpio(f.proveedor); if (!grupos.has(p)) grupos.set(p, []); grupos.get(p).push(f); });
      const suma = fs => fs.reduce((a, f) => a + valorDoc(f), 0);
      const ordenados = [...grupos].map(([p, fs]) => [p, fs, suma(fs)]).sort((a, b) =>
        oc === 'total' ? (a[2] - b[2]) * od : a[0].localeCompare(b[0], 'es') * (oc === 'proveedor' ? od : 1));
      const partes = []; mostradas = 0;
      for (const [p, fs, sub] of ordenados) {
        if (mostradas >= limite) break;
        partes.push(...fs.map(filaHtml));
        mostradas += fs.length;
        const pend = fs.filter(f => !pagada(f)), tPend = pend.reduce((a, f) => a + saldo(f), 0);
        partes.push(`<tr class="subtotal"><td colspan="${nCols - 2}">Subtotal ${esc(p)} · ${fs.length} ${fs.length === 1 ? 'documento' : 'documentos'}${
          pend.length ? ` · <span class="chip warn">${pend.length} pendiente${pend.length > 1 ? 's' : ''}: ${pesos(tPend)}</span>` : ''}</td>
          <td class="num">${pesos(sub)}</td><td></td></tr>`);
      }
      cuerpo = partes.join('');
    } else {
      const visibles = lista.slice(0, limite);
      mostradas = visibles.length;
      cuerpo = visibles.map(filaHtml).join('');
    }

    $('#vista').innerHTML = `<div class="tabla-wrap"><table>
      <thead><tr>
        ${hist ? '' : `<th style="width:28px"><input type="checkbox" id="chkTodas" ${selTodas ? 'checked' : ''} title="Seleccionar todas las facturas filtradas"></th>`}
        ${cols.map(([c, t]) => `<th data-orden="${c}" class="${c === oc ? 'sorted' + (od > 0 ? ' asc' : '') : ''} ${c === 'total' || c === '_saldo' ? 'num' : ''}">${t}</th>`).join('')}
        <th>Adjuntos</th>
      </tr></thead>
      <tbody>${cuerpo}</tbody>
      <tfoot><tr><td colspan="${nCols - 1 - nNum}">${lista.length.toLocaleString('es-CO')} documentos</td><td class="num">${pesos(total)}</td>
        ${hist ? '' : `<td class="num">${pesos(totalSaldo)}</td>`}<td></td></tr></tfoot>
    </table>
    ${mostradas < lista.length ? `<div class="mas"><button class="btn" id="btnMasFilas">Mostrar más (${mostradas} de ${lista.length})</button></div>` : ''}
    </div>`;

    function filaHtml(f) {
        const e = estado(f), cred = creditosDe(f);
        return `<tr class="${sel.has(f.id) ? 'sel' : ''} ${esCredito(f) ? 'fila-credito' : ''}">
          ${hist ? '' : `<td>${esCredito(f) ? '' : `<input type="checkbox" data-sel="${f.id}" ${sel.has(f.id) ? 'checked' : ''}>`}</td>`}
          <td class="prov" title="${esc(f.proveedor)}">${provCelda(f)}</td>
          <td><button class="link" data-editar="${f.id}">${esc(f.numero || '(sin número)')}</button>${chipTipo(f)}</td>
          <td>${esc(f.empresa)}</td><td>${esc(f.centro)}</td>
          <td>${fechaTxt(f.fecha)}</td><td>${fechaTxt(f.fechaRecepcion)}</td><td>${fechaTxt(f.vencimiento)}</td>
          ${hist ? `<td>${f.fechaPago ? fechaTxt(f.fechaPago) : f.pagoRef ? `<span class="chip ok" title="Cruce / referencia">${esc(f.pagoRef)}</span>` : `<span class="chip ${e.cls}">${e.txt}</span>`}</td><td>${esc(f.empresaPago)}</td>`
                 : `<td><span class="chip ${e.cls}">${e.txt}</span></td>`}
          <td class="num">${pesos(valorDoc(f))}</td>
          ${hist ? '' : `<td class="num" ${cred ? `title="Total ${pesos(f.total)} − créditos aplicados ${pesos(cred)}"` : ''}>${pesos(saldo(f))}${cred ? '<small class="muted"> *</small>' : ''}</td>`}
          <td>${celdasAdj(f)}</td>
        </tr>`;
    }
  }

  function renderReporte() {
    const lista = filtradas().filter(f => !pagada(f));
    const rangos = rangosActivos();
    const info = `<p class="filtro-info">Pendientes agrupados por proveedor${rangos.length ? ' · ' + rangos.join(' · ') : ' · sin filtro de fechas'} · ${lista.length} facturas</p>`;
    if (!lista.length) { $('#vista').innerHTML = info + `<div class="vacio">No hay facturas pendientes con estos filtros.</div>`; return; }
    const porEmp = new Map();
    for (const f of lista) {
      const e = limpio(f.empresa) || '(sin empresa)';
      if (!porEmp.has(e)) porEmp.set(e, new Map());
      const m = porEmp.get(e), p = limpio(f.proveedor);
      if (!m.has(p)) m.set(p, []);
      m.get(p).push(f);
    }
    const s = l => l.reduce((a, f) => a + saldo(f), 0);   // saldo pendiente (créditos restan)
    const pct = (a, b) => b ? (a / b * 100).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + ' %' : '';
    let html = info;
    for (const [emp, provs] of [...porEmp].sort((a, b) => a[0].localeCompare(b[0]))) {
      const tEmp = s([...provs.values()].flat());
      const filas = [...provs].sort((a, b) => s(b[1]) - s(a[1])).map(([prov, fs]) => {
        const tProv = s(fs);
        fs.sort((a, b) => (a.vencimiento || '').localeCompare(b.vencimiento || ''));
        const nit = fs.find(f => f.nit)?.nit;
        const ids = fs.filter(f => !esCredito(f)).map(f => f.id), todos = ids.length && ids.every(id => sel.has(id));
        return `<tr class="grupo"><td class="sel-col">${ids.length ? `<input type="checkbox" data-sel-grupo="${ids.join(",")}" ${todos ? "checked" : ""} title="Seleccionar todas las facturas de este proveedor">` : ""}</td><td><button class="link" data-ficha="${esc(prov)}" title="Ver ficha del proveedor">${esc(prov)}</button><div class="nit">${nit ? 'NIT ' + esc(nit) : '<span class="chip warn">Sin NIT</span>'}</div></td>
            <td>${fs.length} fact.</td><td></td><td></td>
            <td class="num">${pesos(tProv)}</td><td class="num">${pct(tProv, tEmp)}</td>
            <td><div class="barra"><div style="width:${tEmp > 0 ? Math.max(0, tProv / tEmp * 100) : 0}%"></div></div></td></tr>` +
          fs.map(f => { const e = estado(f); return `<tr class="${sel.has(f.id) ? "sel" : ""}"><td class="sel-col">${esCredito(f) ? "" : `<input type="checkbox" data-sel="${f.id}" ${sel.has(f.id) ? "checked" : ""}>`}</td><td></td>
            <td><button class="link" data-editar="${f.id}">${esc(f.numero || '(sin número)')}</button>${chipTipo(f)}</td>
            <td>${fechaTxt(f.fechaRecepcion)}</td>
            <td><span class="chip ${e.cls}">${e.txt}</span> <span class="muted">${fechaTxt(f.vencimiento)}</span></td>
            <td class="num"${creditosDe(f) ? ` title="Total ${pesos(f.total)} − créditos aplicados ${pesos(creditosDe(f))}"` : ''}>${pesos(saldo(f))}</td><td class="num muted">${pct(saldo(f), tProv)}</td><td>${celdasAdj(f)}</td></tr>`; }).join('');
      }).join('');
      html += `<section class="reporte-emp"><h3><span>${esc(emp)}</span><span>${pesos(tEmp)}</span></h3>
        <div class="tabla-wrap"><table>
        <thead><tr><th class="sel-col"></th><th>Proveedor</th><th>No factura</th><th>Recepción</th><th>Estado / vencimiento</th><th class="num">Saldo</th><th class="num">% participación</th><th></th></tr></thead>
        <tbody>${filas}</tbody></table></div></section>`;
    }
    // Resumen por centro de costo
    const porCentro = new Map();
    lista.forEach(f => { const c = limpio(f.centro) || '(sin centro)'; porCentro.set(c, (porCentro.get(c) || 0) + saldo(f)); });
    const tot = s(lista);
    html += `<section class="reporte-emp"><h3><span>Por centro de costo</span><span>${pesos(tot)}</span></h3>
      <div class="tabla-wrap"><table><thead><tr><th>Centro</th><th class="num">Valor</th><th class="num">%</th><th></th></tr></thead><tbody>
      ${[...porCentro].sort((a, b) => b[1] - a[1]).map(([c, v]) => `<tr><td>${esc(c)}</td><td class="num">${pesos(v)}</td>
        <td class="num">${pct(v, tot)}</td><td><div class="barra"><div style="width:${tot > 0 ? Math.max(0, v / tot * 100) : 0}%"></div></div></td></tr>`).join('')}
      </tbody></table></div></section>`;
    $('#vista').innerHTML = html;
  }

  // ---------- proveedores (NIT) ----------
  // Color fijo por empresa para distinguirlas de un vistazo
  const claseEmpresa = e => { const i = EMPRESAS.findIndex(x => x.nombre === e); return i >= 0 ? 'emp' + i : 'emp-otra'; };

  function renderProveedores() {
    const txt = norm($('#fTexto').value);
    const grupos = new Map();
    for (const f of facturas) {
      const p = limpio(f.proveedor);
      if (!grupos.has(p)) grupos.set(p, []);
      grupos.get(p).push(f);
    }
    // Filtro por empresa: muestra solo los proveedores que le facturan a esa empresa, y las cifras
    // (facturas, pendientes, por pagar) se calculan solo con las facturas de esa empresa.
    const emp = $('#fEmpresa').value;
    const porNit = new Map();
    const filas = [...grupos].map(([nombre, fs]) => {
      const nits = [...new Set(fs.map(f => f.nit).filter(Boolean))];
      nits.forEach(n => porNit.set(n, [...(porNit.get(n) || []), nombre]));
      const empresas = new Map();
      fs.forEach(f => { const e = nombreEmpresa(f); empresas.set(e, (empresas.get(e) || 0) + 1); });
      const base = emp ? fs.filter(f => nombreEmpresa(f) === emp) : fs;
      const pend = base.filter(f => !pagada(f));
      return { nombre, nits, empresas, n: base.length, sinNit: fs.filter(f => !f.nit).length, pend: pend.length,
        porPagar: pend.reduce((a, f) => a + saldo(f), 0), ultima: base.map(f => f.fecha || '').sort().pop() };
    }).filter(p => !emp || p.n)
      .filter(p => !txt || norm(`${p.nombre} ${p.nits.join(' ')}`).includes(txt))
      .sort((a, b) => (!!a.nits.length - !!b.nits.length) || a.nombre.localeCompare(b.nombre, 'es'));
    const faltan = filas.filter(p => !p.nits.length).length;
    // Conteo por empresa: exclusivos de cada una y compartidos
    const conteo = new Map(); let ambas = 0;
    filas.forEach(p => { if (p.empresas.size > 1) ambas++; else { const e = [...p.empresas.keys()][0]; conteo.set(e, (conteo.get(e) || 0) + 1); } });
    const resumen = [...conteo].sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([e, n]) => `${n} solo de ${esc(e)}`)
      .concat(ambas ? [`${ambas} de ambas empresas`] : []).join(' · ');
    $('#vista').innerHTML = `<p class="filtro-info"><b>${filas.length} proveedores${emp ? ' de ' + esc(emp) : ''}</b> (${resumen}) ·
      ${faltan ? `<b style="color:var(--warn)">${faltan} sin NIT</b>` : 'todos tienen NIT'}.
      Corrija el nombre o el NIT (sin dígito de verificación) y el cambio se aplica a todas las facturas de ese proveedor, en ambas empresas.
      Si escribe el nombre de otro proveedor que ya existe, se ofrece unirlos.</p>
      <div class="tabla-wrap"><table>
      <thead><tr><th>Proveedor</th><th>NIT</th><th>Responsabilidades</th><th>Clasificación habitual</th><th>Empresa(s)</th><th class="num">Facturas</th><th class="num">Pendientes</th><th class="num">Por pagar</th><th>Última factura</th><th></th></tr></thead>
      <tbody>${filas.map(p => {
        const otros = p.nits.flatMap(n => porNit.get(n) || []).filter(x => x !== p.nombre);
        const avisos = [
          p.nits.length > 1 ? `<span class="chip bad">NIT distintos: ${p.nits.map(esc).join(', ')}</span>` : '',
          p.nits.length && p.sinNit ? `<span class="chip warn">${p.sinNit} facturas sin NIT</span>` : '',
          otros.length ? `<span class="chip warn" title="Puede ser el mismo proveedor escrito distinto">Mismo NIT que: ${otros.map(esc).join(', ')}</span>
            ${otros.map(o => `<button class="btn sm" data-unir="${esc(p.nombre)}" data-con="${esc(o)}" title="Pasar las facturas de este proveedor a «${esc(o)}»">Unir con ${esc(o)}</button>`).join(' ')}` : '',
        ].join(' ');
        return `<tr><td><input class="nombre-edit" data-prov="${esc(p.nombre)}" value="${esc(p.nombre)}" aria-label="Nombre del proveedor"></td>
          <td><input class="nit-edit ${p.nits.length ? '' : 'falta'}" data-prov="${esc(p.nombre)}" value="${esc(p.nits[0] || '')}" inputmode="numeric" placeholder="Falta NIT"></td>
          <td class="resp">${chipsResp(infoProveedor(p.nombre, p.nits[0]))}</td>
          <td class="clasif-hab">${(c => c === "NS" ? "No sujeto" : conceptoRet(c) ? esc(c + ". " + conceptoRet(c).nombre) : '<span class="muted">—</span>')(infoProveedor(p.nombre, p.nits[0]).concepto)}
            <button class="btn sm" data-edit-prov="${esc(p.nombre)}" data-nit="${esc(p.nits[0] || "")}">Editar</button>
            <button class="btn sm" data-ficha="${esc(p.nombre)}" title="Ver ficha del proveedor">Ficha</button></td>
          <td class="empresas">${[...p.empresas].sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([e, n]) =>
            `<span class="chip emp ${claseEmpresa(e)}" title="${n} facturas a ${esc(e)}">${esc(e)} · ${n}</span>`).join(' ')}</td>
          <td class="num">${p.n}</td><td class="num">${p.pend || ''}</td><td class="num">${p.porPagar ? pesos(p.porPagar) : ''}</td>
          <td>${fechaTxt(p.ultima)}</td><td>${avisos}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  // Cambia el nombre de un proveedor en todas sus facturas. Si el nombre nuevo ya existe
  // (aunque esté escrito distinto: mayúsculas, S.A.S., orden), se unen previa confirmación.
  async function renombrarProveedor(viejo, nuevo) {
    nuevo = limpio(nuevo);
    if (!nuevo) { toast('El nombre no puede quedar vacío'); render(); return; }
    if (nuevo === viejo) return;
    const mias = facturas.filter(f => limpio(f.proveedor) === viejo);
    const existente = unicos('proveedor').find(p => p !== viejo && (p.toLowerCase() === nuevo.toLowerCase() || normSet(p) === normSet(nuevo)));
    let destino = nuevo, msg = '', nitDestino = '';
    if (existente) {
      const suyas = facturas.filter(f => limpio(f.proveedor) === existente);
      const nitA = [...new Set(mias.map(f => f.nit).filter(Boolean))], nitB = [...new Set(suyas.map(f => f.nit).filter(Boolean))];
      const choqueNit = nitA.length && nitB.length && nitA.some(n => !nitB.includes(n));
      const clavesB = new Set(suyas.map(f => claveDe(existente, f.numero, f.fecha)));
      const repetidas = mias.filter(f => clavesB.has(claveDe(existente, f.numero, f.fecha))).length;
      if (!confirm(`Ya existe el proveedor "${existente}" con ${suyas.length} facturas.\n\n` +
        `¿Unir las ${mias.length} facturas de "${viejo}" con "${existente}"?` +
        (choqueNit ? `\n\n⚠ Tienen NIT distintos (${nitA.join(', ')} vs ${nitB.join(', ')}). Cada factura conserva el suyo; revise después.` : '') +
        (repetidas ? `\n\n⚠ ${repetidas} facturas tienen el mismo número en ambos y quedarán marcadas como REPETIDAS.` : ''))) { render(); return; }
      destino = existente;
      msg = `Unido: ${mias.length} facturas pasaron de "${viejo}" a "${existente}"`;
      nitDestino = nitB[0] || '';
    }
    const mod = new Date().toISOString();
    await DB.guardarVarias('facturas', mias.map(f => ({
      ...f, proveedor: destino, clave: claveDe(destino, f.numero, f.fecha), nit: f.nit || nitDestino || '', modificado: mod,
    })));
    let cambio = false;
    for (const [nit, nom] of Object.entries(nitProveedor)) if (nom === viejo) { nitProveedor[nit] = destino; cambio = true; }
    // Responsabilidades guardadas por nombre (proveedor sin NIT) pasan al nombre nuevo
    const kv = 'n:' + normSet(viejo);
    if (provInfo[kv] && kv !== 'n:' + normSet(destino)) { const kn = claveProv(destino, nitDestino); if (!provInfo[kn]) provInfo[kn] = provInfo[kv]; delete provInfo[kv]; await DB.setCfg('proveedoresInfo', provInfo); }
    if (cambio) await DB.setCfg('nitProveedor', nitProveedor);
    await cargar();
    toast(msg || `Proveedor renombrado a "${destino}" en ${mias.length} facturas`, 6000);
  }

  $('#vista').addEventListener('click', e => {
    const b = e.target.closest('[data-unir]');
    if (b) renombrarProveedor(b.dataset.unir, b.dataset.con);
    const ep = e.target.closest('[data-edit-prov]');
    if (ep) abrirProveedor(ep.dataset.editProv, ep.dataset.nit);
  });
  $('#vista').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('input.nombre-edit, input.nit-edit')) e.target.blur();
    if (e.key === 'Escape' && e.target.matches('input.nombre-edit')) { e.target.value = e.target.dataset.prov; e.target.blur(); }
  });

  $('#vista').addEventListener('change', async e => {
    const nom = e.target.closest('input.nombre-edit');
    if (nom) { await renombrarProveedor(nom.dataset.prov, nom.value); return; }
    const inp = e.target.closest('input.nit-edit');
    if (!inp) return;
    const nombre = inp.dataset.prov, nit = normNit(inp.value);
    inp.value = nit;
    const fs = facturas.filter(f => limpio(f.proveedor) === nombre);
    const mod = new Date().toISOString();
    await DB.guardarVarias('facturas', fs.map(f => ({ ...f, nit, modificado: mod })));
    if (nit) { nitProveedor[nit] = nombre; await DB.setCfg('nitProveedor', nitProveedor); }
    await cargar();
    toast(nit ? `NIT ${nit} asignado a ${fs.length} facturas de ${nombre}` : `NIT quitado de ${nombre}`);
  });

  // ---------- responsabilidades: diálogo del proveedor ----------
  const casillasResp = (sel, excluir = []) => RR.responsabilidades.filter(r => !excluir.includes(r.cod)).map(r =>
    `<label class="chk"><input type="checkbox" value="${esc(r.cod)}" ${sel.includes(r.cod) ? 'checked' : ''}>
      <b>${esc(r.cod)}</b> ${esc(r.nombre)}${r.noRetener ? ' <span class="chip warn">no se le retiene</span>' : ''}</label>`).join('');
  let provEditando = null;

  function abrirProveedor(nombre, nit) {
    const info = infoProveedor(nombre, nit);
    provEditando = { nombre, nit, clave: claveProv(nombre, nit) };
    const f = $('#frmProveedor');
    $('#provNombre').textContent = `${nombre}${nit ? ' · NIT ' + nit : ''}`;
    f.elements.persona.value = info.persona || '';
    f.elements.concepto.innerHTML = `<option value="">Sin clasificación habitual</option><option value="NS">No sujeto a retención</option>${opcionesConceptos}`;
    f.elements.concepto.value = info.concepto || '';
    $('#provResp').innerHTML = casillasResp(info.resp || []);
    $('#provFuente').textContent = { xml: 'Tomadas de la factura electrónica (XML) del proveedor.', semilla: 'Tomadas de los XML de su carpeta de contabilidad.',
      manual: 'Editadas manualmente.' }[info.fuente] || 'Sin información: márquelas según el RUT del proveedor.';
    $('#dlgProveedor').showModal();
  }
  $('#btnCancelarProv').addEventListener('click', () => $('#dlgProveedor').close());
  $('#frmProveedor').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    provInfo[provEditando.clave] = {
      persona: f.elements.persona.value, concepto: f.elements.concepto.value, fuente: 'manual',
      resp: [...$$('#provResp input:checked')].map(c => c.value),
    };
    await DB.setCfg('proveedoresInfo', provInfo);
    $('#dlgProveedor').close();
    if (dlg.open && edit) pintarRetenciones(); else render();
    toast(`Responsabilidades de ${provEditando.nombre} guardadas`);
  });

  // ---------- responsabilidades: empresas compradoras ----------
  function abrirEmpresas() {
    const nombres = [...new Set([...EMPRESAS.map(e => e.nombre), ...unicos('empresa')])];
    $('#empLista').innerHTML = nombres.map(n => {
      const i = infoEmpresa(n);
      return `<fieldset class="emp-resp" data-emp="${esc(n)}"><legend><span class="chip emp ${claseEmpresa(n)}">${esc(n)}</span></legend>
        <label>NIT <input data-campo="nit" value="${esc(i.nit || '')}" inputmode="numeric"></label>
        <label class="chk agente"><input type="checkbox" data-campo="agenteRet" ${i.agenteRet ? 'checked' : ''}>
          <b>Agente de retención en la fuente (renta)</b>: practica retención a sus proveedores</label>
        <div class="resp-lista">${casillasResp(i.resp || [], ['ND'])}</div>
      </fieldset>`;
    }).join('');
    $('#dlgEmpresas').showModal();
  }
  $('#btnCancelarEmp').addEventListener('click', () => $('#dlgEmpresas').close());
  $('#frmEmpresas').addEventListener('submit', async e => {
    e.preventDefault();
    $$('#empLista [data-emp]').forEach(fs => {
      empInfo[fs.dataset.emp] = {
        nit: normNit(fs.querySelector('[data-campo=nit]').value),
        agenteRet: fs.querySelector('[data-campo=agenteRet]').checked,
        resp: [...fs.querySelectorAll('.resp-lista input:checked')].map(c => c.value),
      };
    });
    await DB.setCfg('empresasInfo', empInfo);
    $('#dlgEmpresas').close();
    if (dlg.open && edit) pintarRetenciones();
    toast('Responsabilidades de las empresas guardadas');
  });

  // Desde el aviso de la factura: abre lo que explica por qué no se retiene
  function abrirResponsabilidades() {
    const emp = empresaOficial(frm.elements.empresa.value);
    if (emp && !infoEmpresa(emp).agenteRet) abrirEmpresas();
    else abrirProveedor(limpio(frm.elements.proveedor.value), normNit(frm.elements.nit.value));
  }

  // Chips de responsabilidades para la tabla de proveedores
  function chipsResp(info) {
    if (!info.resp.length) return '<span class="chip neutral">Sin dato</span>';
    return info.resp.map(c => {
      const r = RR.responsabilidades.find(x => x.cod === c);
      return `<span class="chip ${r?.noRetener ? 'warn' : 'neutral'}" title="${esc(nombreResp(c))}">${esc(r?.noRetener ? r.nombre : c)}</span>`;
    }).join(' ');
  }

  // ---------- ficha del proveedor ----------
  let fichaProv = null;   // nombre del proveedor abierto en la ficha

  function abrirFicha(nombre) {
    fichaProv = limpio(nombre);
    pintarFicha();
    const d = $('#dlgFicha');
    if (!d.open) d.showModal();
    d.querySelector('.ficha').scrollTop = 0;
  }
  $('#btnCerrarFicha').addEventListener('click', () => { $('#dlgFicha').close(); fichaProv = null; });
  $('#dlgFicha').addEventListener('keydown', e => { if (e.key === 'Escape' && !dlg.open) { fichaProv = null; } });

  function pintarFicha() {
    if (!fichaProv) return;
    const fs = facturas.filter(f => limpio(f.proveedor) === fichaProv);
    if (!fs.length) { $('#dlgFicha').close(); fichaProv = null; return; }   // p. ej. se renombró o unió
    const nits = [...new Set(fs.map(f => f.nit).filter(Boolean))];
    const info = infoProveedor(fichaProv, nits[0]);
    const s = l => l.reduce((a, f) => a + saldo(f), 0);
    const abiertos = fs.filter(f => !pagada(f));
    const pend = abiertos.filter(f => !esCredito(f)), creditos = abiertos.filter(esCredito);
    const vencidas = pend.filter(f => estado(f).d < 0);
    const haceUnAnio = sumarDias(hoy(), -365);
    const pagado12 = fs.filter(f => !esCredito(f) && f.fechaPago && f.fechaPago >= haceUnAnio).reduce((a, f) => a + (+f.total || 0) - creditosDe(f), 0);
    const cred = diasCreditoDe(fichaProv);
    const ultima = fs.map(f => f.fecha || '').sort().pop();
    const porEmp = new Map();
    fs.forEach(f => { const e = nombreEmpresa(f); const x = porEmp.get(e) || { n: 0, saldo: 0 }; x.n++; if (!pagada(f)) x.saldo += saldo(f); porEmp.set(e, x); });
    const persona = { J: 'Persona jurídica', N: 'Persona natural' }[info.persona] || 'Tipo de persona sin dato';
    const clasif = info.concepto === 'NS' ? 'No sujeto a retención' : conceptoRet(info.concepto) ? `${info.concepto}. ${conceptoRet(info.concepto).nombre}` : 'Sin clasificación habitual';
    const motivo = RR.responsabilidades.filter(r => r.noRetener && info.resp.includes(r.cod));

    $('#fichaNombre').textContent = fichaProv;
    $('#fichaSub').innerHTML = `${nits.length ? 'NIT ' + nits.map(esc).join(', ') : '<span class="chip warn">Sin NIT</span>'} · ${persona}`;

    const filaDoc = (f, conSaldo) => { const e = estado(f); return `<tr class="${esCredito(f) ? 'fila-credito' : ''}">
      <td><button class="link" data-editar="${f.id}">${esc(f.numero || '(sin número)')}</button>${chipTipo(f)}</td>
      <td><span class="chip emp ${claseEmpresa(nombreEmpresa(f))}">${esc(nombreEmpresa(f))}</span></td>
      <td>${fechaTxt(f.fecha)}</td><td>${fechaTxt(f.vencimiento)}</td>
      <td>${f.fechaPago ? 'Pagada ' + fechaTxt(f.fechaPago) : f.pagoRef ? `<span class="chip ok">${esc(f.pagoRef)}</span>` : `<span class="chip ${e.cls}">${e.txt}</span>`}</td>
      <td class="num">${pesos(valorDoc(f))}</td>${conSaldo ? `<td class="num">${pesos(saldo(f))}</td>` : ''}
      <td>${celdasAdj(f)}</td></tr>`; };
    const recientes = [...fs].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '')).slice(0, 25);

    $('#fichaCuerpo').innerHTML = `
      <section class="ficha-datos">
        <div><span class="muted">Responsabilidades</span><div>${chipsResp(info)}</div>
          ${motivo.length ? `<small class="muted">No se le practica retención en la fuente (${motivo.map(r => esc(r.nombre)).join(', ')}).</small>` : ''}</div>
        <div><span class="muted">Clasificación habitual (retención)</span><div>${esc(clasif)}</div></div>
        <div><span class="muted">Le factura a</span><div>${[...porEmp].sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([e, x]) =>
          `<span class="chip emp ${claseEmpresa(e)}">${esc(e)} · ${x.n}</span>`).join(' ')}</div></div>
        <div><span class="muted">Crédito habitual</span><div>${cred && cred.dias > 0 ? cred.dias + ' días' : 'De contado / sin dato'}</div></div>
        <div class="ficha-acciones">
          <button type="button" class="btn sm" data-ficha-editar>Editar datos tributarios</button>
          <button type="button" class="btn sm" data-ficha-historico>Ver en Histórico</button>
        </div>
      </section>

      <section class="kpis ficha-kpis">
        <div class="kpi"><div class="lbl">Saldo por pagar</div><div class="val">${pesos(s(abiertos))}</div>
          <div class="det">${pend.length} ${pend.length === 1 ? 'factura' : 'facturas'}${creditos.length ? ` · créditos ${pesos(-s(creditos))}` : ''}</div></div>
        <div class="kpi ${vencidas.length ? 'alerta' : ''}"><div class="lbl">Vencido</div><div class="val">${pesos(s(vencidas))}</div><div class="det">${vencidas.length} facturas</div></div>
        <div class="kpi"><div class="lbl">Pagado últimos 12 meses</div><div class="val">${pesos(pagado12)}</div><div class="det">desde ${fechaTxt(haceUnAnio)}</div></div>
        <div class="kpi"><div class="lbl">Documentos registrados</div><div class="val">${fs.length.toLocaleString('es-CO')}</div><div class="det">última factura ${fechaTxt(ultima) || '—'}</div></div>
      </section>

      ${porEmp.size > 1 ? `<p class="muted ficha-emp">Saldo por empresa: ${[...porEmp].map(([e, x]) => `${esc(e)} <b>${pesos(x.saldo)}</b>`).join(' · ')}</p>` : ''}

      <h3 class="ficha-tit">Pendientes (${abiertos.length})</h3>
      ${abiertos.length ? `<div class="tabla-wrap"><table>
        <thead><tr><th>Documento</th><th>Empresa</th><th>Fecha</th><th>Vencimiento</th><th>Estado</th><th class="num">Total</th><th class="num">Saldo</th><th></th></tr></thead>
        <tbody>${[...abiertos].sort((a, b) => (a.vencimiento || '').localeCompare(b.vencimiento || '')).map(f => filaDoc(f, true)).join('')}</tbody>
        <tfoot><tr><td colspan="6">Total</td><td class="num">${pesos(s(abiertos))}</td><td></td></tr></tfoot></table></div>`
        : '<p class="muted">No tiene documentos pendientes.</p>'}

      <h3 class="ficha-tit">Últimos documentos</h3>
      <div class="tabla-wrap"><table>
        <thead><tr><th>Documento</th><th>Empresa</th><th>Fecha</th><th>Vencimiento</th><th>Estado / pago</th><th class="num">Total</th><th></th></tr></thead>
        <tbody>${recientes.map(f => filaDoc(f, false)).join('')}</tbody></table></div>
      ${fs.length > recientes.length ? `<p class="muted">Se muestran los ${recientes.length} más recientes de ${fs.length}. Use «Ver en Histórico» para verlos todos.</p>` : ''}`;
  }

  $('#fichaCuerpo').addEventListener('click', async e => {
    const t = e.target;
    const ed = t.closest('[data-editar]');
    if (ed) { cola = []; resumenImport = null; const f = facturas.find(x => x.id === +ed.dataset.editar); if (f) abrirFormulario({ ...f }); return; }
    const ab = t.closest('[data-abrir]');
    if (ab) { abrirBlob(await DB.obtener('archivos', +ab.dataset.abrir)); return; }
    const ap = t.closest('[data-addpdf]');
    if (ap) { pdfPara = +ap.dataset.addpdf; inpRapido.click(); return; }
    if (t.closest('[data-ficha-editar]')) {
      const nit = facturas.find(f => limpio(f.proveedor) === fichaProv && f.nit)?.nit || '';
      abrirProveedor(fichaProv, nit);
    }
    if (t.closest('[data-ficha-historico]')) {
      $('#dlgFicha').close();
      tab = 'historico'; limite = 300;
      $('#fTexto').value = fichaProv; fichaProv = null;
      render();
      $('#tabs').scrollIntoView({ behavior: 'smooth' });
    }
  });

  function renderSel() {
    for (const id of [...sel]) if (!facturas.some(f => f.id === id && !pagada(f) && !esCredito(f))) sel.delete(id);
    const bar = $('#barraSel');
    bar.hidden = tab !== 'pendientes' || !sel.size;
    if (!bar.hidden) {
      const t = facturas.filter(f => sel.has(f.id)).reduce((a, f) => a + saldo(f), 0);
      $('#selInfo').innerHTML = `<b>${sel.size}</b> seleccionadas · <b>${pesos(t)}</b>`;
    }
  }

  // ---------- aprendizaje de nombres (NIT -> nombre) ----------
  function sugerirProveedor(nit, nombreXml) {
    if (nit && nitProveedor[nit]) return nitProveedor[nit];
    const conNit = facturas.find(f => f.nit && f.nit === nit);
    if (conNit) return conNit.proveedor;
    const n = norm(nombreXml);
    const igual = unicos('proveedor').find(p => norm(p) === n);
    return igual || titulo(nombreXml);
  }

  function sugerirEmpresa(nit, nombreXml) {
    if (nit && nitEmpresa[nit]) return nitEmpresa[nit];
    const tokXml = norm(nombreXml).split(' ');
    // "DORA MEJIA" coincide con "MEJIA ALZATE DORA HELENA"; "INV MINDALA" con "INVERSIONES MINDALA SAS"
    const cand = unicos('empresa').filter(e => {
      const t = norm(e).split(' ').filter(Boolean);
      return t.length && t.every(x => tokXml.some(y => y.startsWith(x)));
    });
    return cand[0] || limpio(nombreXml);
  }

  // Días de crédito habituales del proveedor (según su factura más reciente)
  function diasCreditoDe(proveedor) {
    const n = norm(proveedor);
    const ult = facturas.filter(f => norm(f.proveedor) === n && f.fecha && f.vencimiento)
      .sort((a, b) => b.fecha.localeCompare(a.fecha))[0];
    return ult ? { dias: dias(ult.fecha, ult.vencimiento), centro: ult.centro, ref: ult.numero } : null;
  }

  // ---------- formulario de factura ----------
  const frm = $('#frmFactura');
  const dlg = $('#dlgFactura');
  let edit = null;        // { factura, existentes: [archivos], nuevos: [{tipo, nombre, blob}], quitar: Set }
  let cola = [];          // borradores pendientes de revisar (importación XML)
  let resumenImport = null;

  function recalcular() {
    const v = n => +frm.elements[n].value || 0;
    frm.elements.total.value = red(v('bruto') + v('iva') - v('reteiva') - v('retefuente'));
    const d = dias(frm.elements.fecha.value, frm.elements.vencimiento.value);
    frm.elements.dias.value = d ?? '';
    revisarDuplicado();
  }

  function revisarDuplicado() {
    const c = claveDe(frm.elements.proveedor.value, frm.elements.numero.value, frm.elements.fecha.value);
    const id = edit?.factura.id;
    const msgs = [...(edit?.avisos || [])];
    const rep = facturas.filter(f => f.id !== id && f.clave === c);
    if (frm.elements.numero.value && rep.length) {
      msgs.unshift(['bad', `REPETIDA: esta factura ya está registrada (${rep.map(f => `${esc(f.proveedor)} ${esc(f.numero)} del ${fechaTxt(f.fecha)}${f.fechaPago ? ', pagada el ' + fechaTxt(f.fechaPago) : ''}`).join('; ')}).`]);
    } else if (frm.elements.numero.value) {
      const n = normNum(frm.elements.numero.value);
      const otros = facturas.filter(f => f.id !== id && normNum(f.numero) === n);
      if (otros.length) msgs.push(['warn', `El número ${esc(frm.elements.numero.value)} también existe para: ${otros.map(f => esc(f.proveedor)).join(', ')}.`]);
    }
    $('#dlgAvisos').innerHTML = msgs.map(([c, m]) => `<div class="msg ${c}">${m}</div>`).join('');
  }

  function pintarAdjuntos() {
    const items = [
      ...edit.existentes.filter(a => !edit.quitar.has(a.id)).map(a => ({ ...a, key: 'e' + a.id })),
      ...edit.nuevos.map((a, i) => ({ ...a, key: 'n' + i, nuevo: true })),
    ];
    $('#listaAdjuntos').innerHTML = items.length
      ? items.map(a => `<span class="adj"><span class="icono ${a.tipo}">${a.tipo.toUpperCase()}</span>
          <button type="button" class="link" data-ver="${a.key}">${esc(a.nombre)}</button>${a.nuevo ? ' <small class="muted">(nuevo)</small>' : ''}
          <button type="button" data-quitar="${a.key}" title="Quitar">×</button></span>`).join('')
      : '<span class="muted">Sin adjuntos</span>';
    pintarDetalle();
  }

  // ---------- detalle de productos / servicios leído del XML adjunto ----------
  const plata = v => '$ ' + (+v || 0).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const cant = v => (+v || 0).toLocaleString('es-CO', { maximumFractionDigits: 4 });
  let detalleXml = null;   // resultado del parser para el XML de la factura abierta
  // Valor bruto de la app a partir del XML: base de los ítems (neta de descuentos, más cargos) + impuestos distintos del IVA.
  // No se usa el «valor a pagar» porque algunos proveedores lo envían ya descontando retenciones.
  const brutoDeXml = x => red(x.subtotal - x.descuentoGlobal + x.cargoGlobal + x.otros);

  async function pintarDetalle() {
    const cuerpo = $('#detalleCuerpo'), resumen = $('#detalleResumen');
    const xml = edit.nuevos.find(a => a.tipo === 'xml') || edit.existentes.find(a => a.tipo === 'xml' && !edit.quitar.has(a.id));
    const token = pintarDetalle.token = {};
    detalleXml = null;
    if (!xml) {
      resumen.textContent = '';
      cuerpo.innerHTML = `<p class="muted">Esta factura no tiene XML adjunto. Use <b>Adjuntar PDF / XML</b> para ver aquí el detalle de productos, impuestos y retenciones.</p>`;
      if (edit.lineas) { edit.lineas = null; edit.xmlRet = 0; pintarRetenciones(); }
      return;
    }
    let r;
    try { r = Parser.procesar(Parser.decodificar(await xml.blob.arrayBuffer()), xml.nombre); }
    catch (err) { cuerpo.innerHTML = `<div class="msg bad">No se pudo leer ${esc(xml.nombre)}: ${esc(err.message)}</div>`; resumen.textContent = ''; return; }
    if (token !== pintarDetalle.token) return;   // se abrió otra factura mientras se leía
    detalleXml = r;
    const x = r.factura, L = r.lineas;
    edit.lineas = L;
    edit.xmlRet = x.retencionesTipo?.retefuente || 0;
    if (!edit.clasif || edit.clasif.length !== L.length) edit.clasif = clasificacionInicial(L, edit.factura);
    // Responsabilidades del proveedor según el XML (se guardan al guardar la factura si no había)
    edit.respXml = { resp: x.emisorResp || [], persona: x.emisorPersona || '' };
    const hayDesc = L.some(l => l.descuento), hayOtros = L.some(l => l.otros);
    resumen.textContent = `· ${L.length} ${L.length === 1 ? 'ítem' : 'ítems'} · ${xml.nombre}`;
    const rt = x.retencionesTipo || {};
    const hayRet = (rt.reteiva || 0) + (rt.retefuente || 0) + (rt.reteica || 0) + (rt.otras || 0) > 0;
    const fila = (lbl, v, cls = '') => v ? `<tr class="${cls}"><td>${lbl}</td><td class="num">${plata(v)}</td></tr>` : '';
    // Cuadre contra lo registrado: se compara con la base + IVA del XML (no con su "valor a pagar",
    // que algunos proveedores entregan ya descontando las retenciones)
    const bruto = +frm.elements.bruto.value || 0, iva = +frm.elements.iva.value || 0;
    const brutoXml = brutoDeXml(x), signo = x.tipo === 'Nota crédito' ? -1 : 1;
    const difReg = red(bruto + iva - signo * (brutoXml + x.iva));
    // ¿El valor a pagar del XML ya viene neto de las retenciones que informa?
    const pagoNetoDeRet = x.retenciones && Math.abs(x.diferencia + x.retenciones) < 1;
    cuerpo.innerHTML = `
      <p class="muted det-cab">${esc(x.tipo)} ${esc(x.numero)} · ${fechaTxt(x.fecha)} · ${esc(x.emisorNombre)} (NIT ${esc(x.emisorNit)}) →
        ${esc(x.adqNombre)} · ${esc(x.formaPago)}${x.medioPago && x.medioPago !== 'Sin información' ? ' / ' + esc(x.medioPago) : ''} · ${esc(x.estadoDian)}</p>
      <div class="clasif-todos">
        <label>Clasificar todos los ítems como
          <select id="clasifTodos"><option value="">— elegir —</option>${opcionesClasif.replace('<option value="">Sin clasificar</option>', '')}</select></label>
        <span class="muted">La retención se calcula sumando los ítems de cada clasificación y comparando con su tope.</span>
      </div>
      <div class="det-tabla"><table>
        <thead><tr><th>#</th><th>Código</th><th>Descripción</th><th>Clasificación (retención)</th><th class="num">Cant.</th><th>Unid.</th><th class="num">Precio unit.</th>
          ${hayDesc ? '<th class="num">Descuento</th>' : ''}<th class="num">Base</th><th class="num">IVA</th>
          ${hayOtros ? '<th class="num">Otros imp.</th>' : ''}<th class="num">Total</th></tr></thead>
        <tbody>${L.map((l, i) => `<tr>
          <td>${esc(l.item)}</td><td>${esc(l.codigo)}</td>
          <td class="desc">${esc(l.descripcion)}${l.marca ? ` <span class="muted">(${esc(l.marca)})</span>` : ''}</td>
          <td><select class="clasif ${edit.clasif[i] ? '' : 'falta'}" data-clasif="${i}" aria-label="Clasificación del ítem ${i + 1}">${conSeleccion(opcionesClasif, edit.clasif[i] || '')}</select></td>
          <td class="num">${cant(l.cantidad)}</td><td>${esc(l.unidad)}</td><td class="num">${plata(l.precio)}</td>
          ${hayDesc ? `<td class="num">${l.descuento ? plata(l.descuento) + (l.descuentoPct ? ` <small class="muted">${cant(l.descuentoPct)}%</small>` : '') : ''}</td>` : ''}
          <td class="num">${plata(l.subtotal)}</td>
          <td class="num">${l.iva ? plata(l.iva) + ` <small class="muted">${cant(l.ivaPct)}%</small>` : '<span class="muted">—</span>'}</td>
          ${hayOtros ? `<td class="num" title="${esc(l.otrosDetalle)}">${l.otros ? plata(l.otros) : ''}</td>` : ''}
          <td class="num">${plata(l.total)}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="det-pie">
        <table class="det-totales">
          ${fila('Valor bruto (antes de descuentos)', x.bruto !== x.subtotal ? x.bruto : 0)}
          ${fila('Descuentos', x.descuentos ? -x.descuentos : 0)}
          ${fila('Cargos', x.cargos)}
          <tr><td>Subtotal (base)</td><td class="num">${plata(x.subtotal - x.descuentoGlobal + x.cargoGlobal)}</td></tr>
          ${fila('IVA', x.iva)}
          ${x.otros ? `<tr><td>Otros impuestos <small class="muted">${esc(x.otrosDetalle)}</small></td><td class="num">${plata(x.otros)}</td></tr>` : ''}
          ${fila('Anticipos', x.anticipos ? -x.anticipos : 0)}
          ${fila('Redondeo', x.redondeo)}
          <tr><td>Total factura (base + impuestos)</td><td class="num">${plata(brutoXml + x.iva)}</td></tr>
          ${pagoNetoDeRet ? `<tr><td>Retenciones descontadas por el proveedor</td><td class="num">${plata(-x.retenciones)}</td></tr>` : ''}
          <tr class="tot"><td>Valor a pagar según XML</td><td class="num">${plata(x.total)}</td></tr>
        </table>
        <div class="det-ret">
          <b>Retenciones informadas en el XML</b>
          ${hayRet ? `<table class="det-totales">
              ${fila('ReteIVA', rt.reteiva)}${fila('ReteFuente (renta)', rt.retefuente)}${fila('ReteICA', rt.reteica)}${fila('Otras', rt.otras)}
            </table>
            ${rt.reteiva ? '<button type="button" class="btn sm" id="btnAplicarRet">Aplicar la ReteIVA del XML</button>' : ''}
            ${rt.retefuente ? '<p class="muted">La ReteFuente se calcula por ítems en «Retención en la fuente»; allí puede compararla o usar el valor del XML.</p>' : ''}
            ${rt.reteica ? '<p class="muted">La ReteICA no tiene casilla propia: anótela en Notas si aplica.</p>' : ''}`
          : `<p class="muted">El XML no trae retenciones. La ReteFuente se calcula con la clasificación de los ítems; la ReteIVA, si aplica, escríbala arriba.</p>`}
          ${Math.abs(difReg) >= 1 ? `<div class="msg warn">Lo registrado (bruto ${plata(bruto)} + IVA ${plata(iva)}) no coincide con el XML
            (bruto ${plata(signo * brutoXml)} + IVA ${plata(signo * x.iva)}); diferencia ${plata(difReg)}.
            <button type="button" class="btn sm" id="btnAplicarValores">Usar valores del XML</button></div>` : ''}
          ${pagoNetoDeRet ? `<p class="muted">El valor a pagar del XML ya viene con las retenciones descontadas (${plata(x.retenciones)}).</p>`
            : Math.abs(x.diferencia) >= 1 ? `<div class="msg warn">El XML no cuadra internamente por ${plata(x.diferencia)} (valor a pagar vs. suma de sus componentes).</div>` : ''}
        </div>
      </div>`;
    pintarRetenciones();
  }

  $('#detalleCuerpo').addEventListener('click', e => {
    if (!detalleXml) return;
    const x = detalleXml.factura, el = frm.elements;
    if (e.target.id === 'btnAplicarRet') {
      el.reteiva.value = x.retencionesTipo.reteiva || 0;
      recalcular(); toast('ReteIVA del XML aplicada; recuerde Guardar');
    }
    if (e.target.id === 'btnAplicarValores') {
      const sg = x.tipo === 'Nota crédito' ? -1 : 1;
      el.iva.value = red(sg * x.iva);
      el.bruto.value = red(sg * brutoDeXml(x));
      basesDesdeBruto();
      recalcular(); pintarDetalle(); toast('Valores del XML aplicados; recuerde Guardar');
    }
  });

  async function abrirFormulario(factura, { nuevos = [], avisos = [], hints = {}, paso = '' } = {}) {
    const existentes = factura.id ? await DB.archivosDe(factura.id) : [];
    edit = { factura, existentes, nuevos, quitar: new Set(), avisos };
    $('#dlgTitulo').textContent = factura.id ? `Factura ${factura.numero}` : factura.origen === 'xml' ? 'Nueva factura desde XML' : 'Nueva factura';
    $('#dlgPaso').textContent = paso;
    const campos = ['proveedor', 'nit', 'numero', 'fecha', 'fechaRecepcion', 'vencimiento', 'bruto', 'iva', 'reteiva', 'retefuente',
      'empresa', 'centro', 'fechaPago', 'pagoRef', 'empresaPago', 'notas'];
    campos.forEach(c => { frm.elements[c].value = factura[c] ?? ''; });
    frm.elements.nit.dataset.auto = '';
    if (!factura.nit) revisarNit('proveedor'); else $('#hintNit').textContent = '';
    $('#hintVenc').textContent = hints.venc || '';
    $('#hintTotal').textContent = hints.total || '';
    $('#btnBorrarFactura').hidden = !factura.id;
    $('#btnOmitir').hidden = !cola.length && !paso;
    edit.ret = retencionesIniciales(factura);
    edit.clasif = Array.isArray(factura.clasif) ? [...factura.clasif] : null;
    edit.tarifas = { ...(factura.tarifasRet || {}) };
    edit.lineas = null; edit.xmlRet = 0; edit.respXml = null;
    edit.usarRetXml = !!factura.usarRetXml;
    frm.elements.tipoDoc.value = factura.tipoDoc || 'Factura';
    edit.aplic = (factura.aplicaciones || []).map(a => ({ ...a }));
    edit.reversar = factura.reversarRet ?? true;   // nota crédito: reversar retenciones de la factura
    // Nota crédito recién importada: se aplica sola a la factura que referencia (por número o CUFE), hasta su saldo
    if (factura.tipoDoc === 'Nota crédito' && factura.aplicaciones == null && (factura.facturaRef || factura.facturaRefCufe)) {
      const f = facturaReferida(factura);
      if (f) {
        // Valor neto de la nota: base + IVA − retenciones reversadas de la factura
        const rv = reversionRet(factura.bruto, [f]);
        const v = red(Math.min(+factura.bruto + +factura.iva - rv.reteiva - rv.retefuente, saldo(f)));
        if (v > 0) edit.aplic.push({ facturaId: f.id, valor: v });
        edit.avisos.push(['info', v > 0 ? `Se aplicó automáticamente ${pesos(v)} a la factura ${esc(f.numero)} (saldo ${pesos(saldo(f))}).`
          : `La factura ${esc(f.numero)} ya no tiene saldo: la nota queda como crédito disponible.`]);
      } else {
        edit.avisos.push(['warn', `No se encontró registrada la factura ${esc(factura.facturaRef)}: la nota queda como crédito disponible hasta que la aplique.`]);
      }
    }
    pintarRetenciones();   // también llama a recalcular(); se repite cuando se lee el XML
    pintarAplicar();
    pintarAdjuntos();
    if (!dlg.open) dlg.showModal();
    frm.elements[factura.proveedor ? (factura.empresa ? 'centro' : 'empresa') : 'proveedor'].focus();
  }

  // NIT <-> proveedor: al escribir uno se propone el otro
  function revisarNit(origen) {
    const el = frm.elements, hint = $('#hintNit');
    if (origen === 'proveedor') {
      const n = nitDe(el.proveedor.value);
      if (n && (!el.nit.value || el.nit.dataset.auto === '1')) { el.nit.value = n; el.nit.dataset.auto = '1'; }
    }
    if (origen === 'nit') {
      el.nit.dataset.auto = '';
      const nombre = nitProveedor[normNit(el.nit.value)];
      if (nombre && !el.proveedor.value) el.proveedor.value = nombre;
    }
    const registrado = nitDe(el.proveedor.value), actual = normNit(el.nit.value);
    hint.textContent = registrado && actual && registrado !== actual ? `Ojo: este proveedor tiene registrado el NIT ${registrado}` : '';
  }

  frm.addEventListener('input', e => {
    if (e.target.name === 'proveedor' || e.target.name === 'nit') revisarNit(e.target.name);
    if (['proveedor', 'nit', 'empresa'].includes(e.target.name)) pintarRetenciones();
    if (e.target.name === 'bruto') basesDesdeBruto();
    if (['bruto', 'iva', 'reteiva', 'retefuente', 'fecha', 'vencimiento', 'proveedor', 'numero'].includes(e.target.name)) recalcular();
    if (e.target.name === 'tipoDoc') pintarRetenciones();
    if (['tipoDoc', 'proveedor', 'nit', 'empresa', 'bruto', 'iva', 'reteiva'].includes(e.target.name)) pintarAplicar();
  });

  frm.addEventListener('click', async e => {
    const ver = e.target.closest('[data-ver]'), quitar = e.target.closest('[data-quitar]');
    if (ver) {
      const k = ver.dataset.ver;
      const a = k[0] === 'e' ? edit.existentes.find(x => 'e' + x.id === k) : edit.nuevos[+k.slice(1)];
      // En el visor se puede pasar entre todos los adjuntos del formulario (guardados y nuevos)
      abrirBlob(a, [...edit.existentes.filter(x => !edit.quitar.has(x.id)), ...edit.nuevos]);
    }
    if (quitar) {
      const k = quitar.dataset.quitar;
      if (k[0] === 'e') edit.quitar.add(+k.slice(1)); else edit.nuevos.splice(+k.slice(1), 1);
      pintarAdjuntos();
    }
  });

  // ---------- retención en la fuente (renta) ----------
  // Con XML: cada ítem se clasifica en un concepto; los ítems se suman por concepto y, si ese
  // subtotal alcanza el tope (base mínima), se practica la retención con la tarifa del concepto.
  // Sin XML (o además): filas manuales { concepto, base, tarifa, valor }.
  // No se retiene si la empresa compradora no es agente de retención, o si el proveedor es
  // autorretenedor (O-15) o del régimen SIMPLE (O-47).
  // Se guarda: factura.clasif (concepto por ítem), factura.tarifasRet, factura.retenciones (filas
  // calculadas con origen 'items' + manuales) y factura.retefuente = suma.
  const RR = window.RETENCIONES_RENTA || { UVT: 0, conceptos: [], responsabilidades: [], noDeclarante: {} };
  const conceptoRet = cod => RR.conceptos.find(c => c.cod === cod);
  const pctTxt = v => (+v || 0).toLocaleString('es-CO', { maximumFractionDigits: 3 }) + '%';
  const nombreRet = r => r.concepto === 'xml' ? 'Informada en el XML' : r.concepto === 'manual' ? 'Valor manual'
    : (c => c ? `${c.cod}. ${c.nombre}` : r.concepto)(conceptoRet(r.concepto));
  const topeDe = c => c && c.uvt ? c.uvt * RR.UVT : 0;
  const opcionesConceptos = (() => {
    const grupos = [...new Set(RR.conceptos.map(c => c.grupo))];
    return grupos.map(g => `<optgroup label="${esc(g)}">${RR.conceptos.filter(c => c.grupo === g).map(c =>
      `<option value="${c.cod}">${esc(c.cod)}. ${esc(c.nombre)} · ${pctTxt(c.tarifa)}${c.uvt ? ` · tope ${c.uvt} UVT` : ''}</option>`).join('')}</optgroup>`).join('');
  })();
  const opcionesRet = opcionesConceptos +
    `<optgroup label="Otros"><option value="xml">Informada en el XML (valor fijo)</option><option value="manual">Otro concepto / valor manual</option></optgroup>`;
  const opcionesClasif = `<option value="">Sin clasificar</option><option value="NS">No sujeto a retención</option>` + opcionesConceptos;
  const conSeleccion = (html, v) => html.replace(`value="${v}"`, `value="${v}" selected`);
  $('#retVigencia').textContent = RR.anio ? `· Tabla ${RR.anio}, UVT ${pesos(RR.UVT)}` : '';

  // ----- responsabilidades de proveedores y empresas -----
  const claveProv = (nombre, nit) => normNit(nit) || 'n:' + normSet(nombre);
  function infoProveedor(nombre, nit) {
    const k = claveProv(nombre, nit);
    if (provInfo[k]) return provInfo[k];
    const s = (window.RESPONSABILIDADES_SEMILLA || {})[normNit(nit)];
    if (s) return { persona: s[0], resp: s.slice(1), concepto: '', fuente: 'semilla' };
    return { persona: '', resp: [], concepto: '', fuente: '' };
  }
  function infoEmpresa(nombre) {
    const def = EMPRESAS.find(e => e.nombre === nombre);
    return { nit: def?.nit || '', resp: [], agenteRet: def ? def.agenteRet : true, ...(empInfo[nombre] || {}) };
  }
  const nombreResp = cod => RR.responsabilidades.find(r => r.cod === cod)?.nombre || cod;
  // Motivo por el que NO se practica retención (o '' si sí se practica)
  function motivoNoRetener(empresa, proveedor, nit) {
    const emp = empresaOficial(empresa);
    if (emp && !infoEmpresa(emp).agenteRet) return `${emp} no es agente de retención en la fuente.`;
    const bloquea = infoProveedor(proveedor, nit).resp.filter(c => RR.responsabilidades.find(r => r.cod === c)?.noRetener);
    if (bloquea.length) return `El proveedor es ${bloquea.map(c => `${nombreResp(c)} (${c})`).join(' y ')}: no se le practica retención.`;
    return '';
  }
  // Variante "no declarante" del concepto cuando el proveedor tiene esa marca
  const conceptoPara = (cod, info) => info.resp.includes('ND') && RR.noDeclarante[cod] ? RR.noDeclarante[cod] : cod;

  // ----- clasificación de los ítems del XML -----
  const claveItem = (nit, l) => `${normNit(nit)}|${l.codigo || norm(l.descripcion)}`;
  function clasificacionInicial(L, f) {
    if (Array.isArray(f.clasif) && f.clasif.length === L.length) return [...f.clasif];
    // Factura que ya trae la ReteFuente registrada (Excel): no se reclasifica sola; se respeta ese valor
    // hasta que el usuario clasifique los ítems.
    if (edit.ret.some(esHistorica)) return L.map(() => '');
    const nit = frm.elements.nit.value, info = infoProveedor(frm.elements.proveedor.value, nit);
    const habitual = info.concepto || conceptoHabitual(frm.elements.proveedor.value);
    return L.map(l => clasifProducto[claveItem(nit, l)] || (habitual ? conceptoPara(habitual, info) : ''));
  }
  // Concepto más usado en las últimas facturas del proveedor
  function conceptoHabitual(proveedor) {
    const n = norm(proveedor);
    const usados = facturas.filter(f => norm(f.proveedor) === n && (f.retenciones || []).length)
      .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '')).slice(0, 5)
      .flatMap(f => f.retenciones.filter(r => conceptoRet(r.concepto)).map(r => r.concepto));
    const cuenta = new Map(); usados.forEach(c => cuenta.set(c, (cuenta.get(c) || 0) + 1));
    return [...cuenta].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }

  // Filas calculadas a partir de los ítems clasificados
  function filasPorItems() {
    if (!edit.lineas || edit.usarRetXml) return [];
    const grupos = new Map();
    edit.lineas.forEach((l, i) => {
      const c = edit.clasif[i];
      if (!conceptoRet(c)) return;
      grupos.set(c, (grupos.get(c) || 0) + (+l.subtotal || 0));
    });
    return [...grupos].map(([cod, base]) => {
      const c = conceptoRet(cod), tarifa = edit.tarifas[cod] ?? c.tarifa, tope = topeDe(c);
      const aplica = base >= tope;
      return { origen: 'items', concepto: cod, base: red(base), tarifa, valor: aplica ? Math.round(base * tarifa / 100) : 0, tope, aplica,
        items: edit.lineas.filter((_, i) => edit.clasif[i] === cod).length };
    });
  }

  function calcManual(r) {
    if (r.concepto === 'xml' || r.concepto === 'manual') {
      r.valor = red(r.valor);
      return r.concepto === 'xml' ? 'Valor que informa el proveedor en el XML.' : 'Escriba el valor retenido.';
    }
    const c = conceptoRet(r.concepto);
    if (!c) { r.valor = 0; return 'Elija un concepto.'; }
    const base = red(r.base), min = topeDe(c);
    if (base < min) { r.valor = 0; return `No aplica: la base ${pesos(base)} es menor al tope de ${c.uvt} UVT (${pesos(min)}).`; }
    r.valor = Math.round(base * (+r.tarifa || 0) / 100);
    return `${pesos(base)} × ${pctTxt(r.tarifa)} = ${pesos(r.valor)}${c.uvt ? ` · tope ${c.uvt} UVT (${pesos(min)})` : ' · sin tope'}`;
  }

  // Todas las filas que se guardan en la factura, ya con los bloqueos aplicados
  function filasRetencion() {
    const motivo = motivoNoRetener(frm.elements.empresa.value, frm.elements.proveedor.value, frm.elements.nit.value);
    const auto = filasPorItems().map(r => motivo ? { ...r, valor: 0 } : r);
    // Con cálculo por ítems, la ReteFuente histórica del Excel queda reemplazada (no se suma otra vez)
    const historicas = auto.length ? edit.ret.filter(esHistorica) : [];
    const manuales = edit.ret.map((r, i) => { r._i = i; return r; })
      .filter(r => !(auto.length && esHistorica(r)))
      .map(r => { calcManual(r); return motivo && conceptoRet(r.concepto) ? { ...r, valor: 0 } : r; });
    return { motivo, auto, manuales, historicas, todas: [...auto, ...manuales] };
  }

  function totalRet() {
    // Anticipos no llevan retención; en la nota crédito la ReteFuente es la reversión de la factura (ver pintarAplicar)
    if (tipoForm() === 'Anticipo') frm.elements.retefuente.value = 0;
    else if (!creditoForm()) frm.elements.retefuente.value = red(filasRetencion().todas.reduce((a, r) => a + (+r.valor || 0), 0));
    recalcular();
  }

  function pintarRetenciones() {
    const { motivo, auto, manuales, historicas } = filasRetencion();
    const partes = [];
    if (motivo) partes.push(`<div class="msg info">No se practica retención en la fuente: ${esc(motivo)}
      <button type="button" class="link" data-abrir-resp>Ver responsabilidades</button></div>`);
    // Cálculo por ítems
    if (edit.lineas) {
      const sinClasif = edit.lineas.filter((_, i) => !edit.clasif[i]);
      if (edit.usarRetXml) {
        partes.push(`<p class="muted">Se usa la ReteFuente que informa el XML en lugar del cálculo por ítems.
          <button type="button" class="link" data-ret-items>Volver a calcular por ítems</button></p>`);
      } else {
        partes.push(auto.length ? `<table class="ret-items"><thead><tr><th>Concepto (según clasificación de ítems)</th><th class="num">Ítems</th>
            <th class="num">Subtotal</th><th class="num">Tope</th><th class="num">Tarifa</th><th class="num">Retención</th></tr></thead><tbody>
            ${auto.map(r => `<tr class="${r.aplica ? '' : 'no-aplica'}"><td>${esc(nombreRet(r))}</td><td class="num">${r.items}</td>
              <td class="num">${pesos(r.base)}</td><td class="num">${r.tope ? pesos(r.tope) : 'Sin tope'}</td>
              <td class="num"><input type="number" step="0.001" data-tarifa-item="${esc(r.concepto)}" value="${r.tarifa}" aria-label="Tarifa"></td>
              <td class="num">${r.aplica ? pesos(r.valor) : '<span class="chip neutral" title="El subtotal no alcanza el tope">No supera el tope</span>'}</td></tr>`).join('')}
            </tbody></table>`
          : `<p class="muted">Ningún ítem está clasificado con un concepto de retención. Clasifíquelos en «Productos y servicios».</p>`);
        if (sinClasif.length) partes.push(`<div class="msg warn">${sinClasif.length} ${sinClasif.length === 1 ? 'ítem sin clasificar' : 'ítems sin clasificar'}
          (${pesos(sinClasif.reduce((a, l) => a + (+l.subtotal || 0), 0))}). Clasifíquelos en «Productos y servicios» o márquelos como «No sujeto».</div>`);
      }
      const rx = edit.xmlRet || 0;
      if (rx) {
        const calc = auto.reduce((a, r) => a + r.valor, 0);
        partes.push(`<p class="muted">El XML informa ReteFuente de ${pesos(rx)}${!edit.usarRetXml && auto.length ? (Math.abs(calc - rx) < 1 ? ' (coincide con el cálculo).' : ` y el cálculo da ${pesos(calc)}.`) : '.'}
          ${!edit.usarRetXml ? '<button type="button" class="link" data-usar-xml>Usar el valor del XML</button>' : ''}</p>`);
      }
      if (manuales.some(r => r.concepto !== 'xml') && auto.length) partes.push(`<div class="msg warn">Hay retenciones manuales además del cálculo por ítems: quítelas si ya están incluidas, para no duplicar.</div>`);
      if (historicas.length) partes.push(`<p class="muted">La ReteFuente registrada en el Excel (${pesos(historicas.reduce((a, r) => a + (+r.valor || 0), 0))}) se reemplaza por el cálculo por ítems; no se suma dos veces.</p>`);
    }
    // Filas manuales
    const fijo = r => r.concepto === 'xml' || r.concepto === 'manual';
    if (manuales.length) {
      partes.push(`<div class="ret-cab"><span>${edit.lineas ? 'Retención adicional / manual' : 'Concepto'}</span><span>Base</span><span>Tarifa</span><span>Retención</span><span></span></div>
        ${manuales.map(r => `<div class="ret-fila" data-i="${r._i}">
          <select data-campo="concepto" aria-label="Concepto de retención">${conSeleccion(opcionesRet, r.concepto)}</select>
          <input data-campo="base" type="number" step="0.01" value="${fijo(r) ? '' : r.base ?? ''}" ${fijo(r) ? 'disabled placeholder="—"' : ''} aria-label="Base">
          <input data-campo="tarifa" type="number" step="0.001" value="${fijo(r) ? '' : r.tarifa ?? ''}" ${fijo(r) ? 'disabled placeholder="—"' : ''} aria-label="Tarifa %">
          <input data-campo="valor" type="number" step="0.01" value="${r.valor ?? 0}" ${r.concepto === 'manual' ? '' : 'readonly tabindex="-1"'} aria-label="Valor retenido">
          <button type="button" class="btn sm ghost" data-quitar-ret="${r._i}" title="Quitar">×</button>
          <small class="muted ret-nota">${esc(motivo && conceptoRet(r.concepto) ? "No se practica: vea el aviso de arriba." : calcManual({ ...r }))}</small>
        </div>`).join('')}`);
    } else if (!edit.lineas) {
      partes.push(`<p class="muted">Sin retención en la fuente. Esta factura no tiene XML: agregue la retención por concepto si aplica.</p>`);
    }
    $('#retFilas').innerHTML = partes.join('');
    $('#btnAddRet').textContent = edit.lineas ? '+ Retención manual' : '+ Agregar retención';
    sugerirRet();
    totalRet();
  }

  // Botón con el concepto habitual del proveedor (modo manual)
  function sugerirRet() {
    const info = infoProveedor(frm.elements.proveedor.value, frm.elements.nit.value);
    const cod = conceptoPara(info.concepto || conceptoHabitual(frm.elements.proveedor.value), info);
    const c = conceptoRet(cod);
    const ya = !c || edit.lineas || edit.ret.some(x => x.concepto === cod);
    $('#retSugerencia').innerHTML = !ya
      ? `<button type="button" class="btn sm" data-sug-ret="${esc(cod)}">Usar el habitual de este proveedor: ${esc(c.cod)}. ${esc(c.nombre)} · ${pctTxt(c.tarifa)}</button>` : '';
  }

  function agregarRet(cod) {
    const info = infoProveedor(frm.elements.proveedor.value, frm.elements.nit.value);
    cod = conceptoPara(cod, info);
    const c = conceptoRet(cod);
    edit.ret.push({ concepto: cod, base: red(frm.elements.bruto.value), tarifa: c?.tarifa ?? 0, valor: 0, baseAuto: true });
    pintarRetenciones();
  }

  $('#btnAddRet').addEventListener('click', () => agregarRet(edit.lineas ? 'manual' : '26'));
  $('#retSugerencia').addEventListener('click', e => {
    const b = e.target.closest('[data-sug-ret]');
    if (b) agregarRet(b.dataset.sugRet);
  });
  $('#retFilas').addEventListener('click', e => {
    const b = e.target.closest('[data-quitar-ret]');
    if (b) { edit.ret.splice(+b.dataset.quitarRet, 1); pintarRetenciones(); }
    if (e.target.closest('[data-usar-xml]')) { edit.usarRetXml = true; edit.ret = edit.ret.filter(r => r.concepto !== 'xml'); edit.ret.unshift({ concepto: 'xml', valor: edit.xmlRet }); pintarRetenciones(); }
    if (e.target.closest('[data-ret-items]')) { edit.usarRetXml = false; edit.ret = edit.ret.filter(r => r.concepto !== 'xml'); pintarRetenciones(); }
    if (e.target.closest('[data-abrir-resp]')) abrirResponsabilidades();
  });
  $('#retFilas').addEventListener('change', e => {
    const fila = e.target.closest('.ret-fila');
    if (!fila || e.target.dataset.campo !== 'concepto') return;
    const r = edit.ret[+fila.dataset.i], c = conceptoRet(e.target.value);
    r.concepto = e.target.value;
    if (c) { r.tarifa = c.tarifa; if (r.base == null || r.base === '') { r.base = red(frm.elements.bruto.value); r.baseAuto = true; } }
    pintarRetenciones();
  });
  $('#retFilas').addEventListener('input', e => {
    e.stopPropagation();
    const ti = e.target.dataset.tarifaItem;
    if (ti) { edit.tarifas[ti] = e.target.value === '' ? conceptoRet(ti).tarifa : +e.target.value; clearTimeout(pintarRetenciones.t); pintarRetenciones.t = setTimeout(() => { const foco = document.activeElement?.dataset.tarifaItem; pintarRetenciones(); if (foco) { const el = $(`[data-tarifa-item="${foco}"]`); el?.focus(); } }, 600); totalRet(); return; }
    const fila = e.target.closest('.ret-fila'), campo = e.target.dataset.campo;
    if (!fila || !['base', 'tarifa', 'valor'].includes(campo)) return;
    const r = edit.ret[+fila.dataset.i];
    r[campo] = e.target.value === '' ? '' : +e.target.value;
    if (campo === 'base') r.baseAuto = false;
    const bloqueada = conceptoRet(r.concepto) && motivoNoRetener(frm.elements.empresa.value, frm.elements.proveedor.value, frm.elements.nit.value);
    const nota = calcManual(r);
    if (campo !== 'valor') fila.querySelector('[data-campo=valor]').value = bloqueada ? 0 : r.valor;
    fila.querySelector('.ret-nota').textContent = bloqueada ? 'No se practica: vea el aviso de arriba.' : nota;
    totalRet();
  });

  // Si cambia el valor bruto, las bases manuales que no se editaron a mano lo siguen
  function basesDesdeBruto() {
    let cambio = false;
    edit.ret.forEach(r => { if (r.baseAuto && conceptoRet(r.concepto)) { r.base = red(frm.elements.bruto.value); cambio = true; } });
    if (cambio) pintarRetenciones();
  }

  // Filas manuales al abrir: las guardadas que no vienen de los ítems (o la ReteFuente histórica del Excel)
  function retencionesIniciales(f) {
    if (f.retenciones?.length) return f.retenciones.filter(r => r.origen !== 'items').map(r => ({ ...r }));
    if (+f.retefuente && !f.clasif) return [{ concepto: 'manual', valor: +f.retefuente, historico: true }];
    return [];
  }

  // Clasificación en la tabla de productos
  $('#detalleCuerpo').addEventListener('change', e => {
    const s = e.target;
    if (s.dataset.clasif !== undefined) { edit.clasif[+s.dataset.clasif] = s.value; s.classList.toggle('falta', !s.value); pintarRetenciones(); }
    if (s.id === 'clasifTodos' && s.value) {
      edit.clasif = edit.clasif.map(() => s.value);
      $$('#detalleCuerpo [data-clasif]').forEach(x => { x.value = s.value; x.classList.remove('falta'); });
      s.value = '';
      pintarRetenciones();
    }
  });

  // ---------- notas crédito y anticipos: aplicación a facturas ----------
  // edit.aplic = [{ facturaId, valor }] del crédito que se está editando.
  const tipoForm = () => frm.elements.tipoDoc.value || 'Factura';
  const creditoForm = () => TIPOS_CREDITO.includes(tipoForm());
  const totalForm = () => +frm.elements.total.value || 0;
  // Saldo de una factura sin contar lo que le aplica el crédito que se está editando
  function saldoSinEste(f) {
    if (f.fechaPago || f.pagoRef) return 0;
    const propio = edit.factura.id ? (edit.factura.aplicaciones || []).filter(a => a.facturaId === f.id).reduce((s, a) => s + (+a.valor || 0), 0) : 0;
    return red((+f.total || 0) - (creditosDe(f) - propio));
  }
  // Facturas del mismo proveedor y empresa a las que se puede aplicar el crédito
  function candidatasAplicar() {
    const prov = norm(frm.elements.proveedor.value), nit = normNit(frm.elements.nit.value);
    const emp = empresaOficial(frm.elements.empresa.value);
    const aplicadas = new Set(edit.aplic.map(a => a.facturaId));
    return facturas.filter(f => !esCredito(f) && f.id !== edit.factura.id
        && (norm(f.proveedor) === prov || (nit && f.nit === nit))
        && (!emp || empresaOficial(f.empresa) === emp)
        && (aplicadas.has(f.id) || saldoSinEste(f) > 0.5))
      .sort((a, b) => (aplicadas.has(b.id) - aplicadas.has(a.id)) || (b.fecha || '').localeCompare(a.fecha || ''));
  }

  function pintarAplicar() {
    const sec = $('#secAplicar'), cuerpo = $('#aplicarCuerpo');
    const credito = creditoForm();
    $('#secRetenciones').hidden = credito;
    $('#hintTipo').textContent = {
      'Nota crédito': 'Disminuye lo que se le debe al proveedor. Aplíquela completa (cruza la factura) o parcial (deja saldo).',
      'Anticipo': 'Dinero entregado al proveedor por adelantado. Escriba el valor en «Valor bruto» y aplíquelo a sus facturas cuando lleguen.',
      'Nota débito': 'Aumenta lo que se le debe al proveedor; se paga como una factura.',
    }[tipoForm()] || '';
    frm.elements.vencimiento.required = !credito;
    // Nota crédito: reversión proporcional de las retenciones de la(s) factura(s) afectada(s)
    const esNC = tipoForm() === 'Nota crédito';
    let rev = null;
    if (esNC && edit.reversar) {
      rev = reversionRet(frm.elements.bruto.value, facturasAfectadas({ ...edit.factura, proveedor: frm.elements.proveedor.value, nit: normNit(frm.elements.nit.value) }, edit.aplic));
      frm.elements.reteiva.value = rev.reteiva;
      frm.elements.retefuente.value = rev.retefuente;
      recalcular();
    }
    frm.elements.reteiva.readOnly = esNC && edit.reversar;
    frm.elements.retefuente.readOnly = !(esNC && !edit.reversar);   // en facturas es la suma de la lista de retenciones
    if (credito) {
      sec.hidden = false;
      $('#aplicarTitulo').textContent = `Aplicar ${tipoForm() === 'Anticipo' ? 'el anticipo' : 'la nota crédito'} a facturas del proveedor`;
      const cands = candidatasAplicar();
      const aplicado = red(edit.aplic.reduce((s, a) => s + (+a.valor || 0), 0));
      const total = totalForm(), libre = red(total - aplicado);
      const ref = edit.factura.facturaRef ? normNum(edit.factura.facturaRef) : '';
      cuerpo.innerHTML = !frm.elements.proveedor.value ? '<p class="muted">Escriba el proveedor para ver sus facturas pendientes.</p>'
        : !cands.length ? `<p class="muted">El proveedor no tiene facturas pendientes${frm.elements.empresa.value ? ' con ' + esc(empresaOficial(frm.elements.empresa.value)) : ''}. El crédito queda disponible para aplicarlo después.</p>`
        : `<table class="ret-items aplicar"><thead><tr><th>Factura</th><th>Fecha</th><th class="num">Total</th><th class="num">Saldo</th><th class="num">Aplicar</th><th></th></tr></thead><tbody>
          ${cands.map(f => {
            const a = edit.aplic.find(x => x.facturaId === f.id), s = saldoSinEste(f);
            const esRef = ref && normNum(f.numero) === ref;
            return `<tr class="${esRef ? 'ref' : ''}"><td>${esc(f.numero || '(sin número)')}${esRef ? ' <span class="chip ok">referenciada en la nota</span>' : ''}</td>
              <td>${fechaTxt(f.fecha)}</td><td class="num">${pesos(f.total)}</td><td class="num">${pesos(s)}</td>
              <td class="num"><input type="number" step="0.01" min="0" data-aplicar="${f.id}" value="${a ? a.valor : ''}" placeholder="0"></td>
              <td><button type="button" class="btn sm" data-aplicar-todo="${f.id}" title="Aplicar lo que alcance del crédito al saldo de esta factura">Todo</button></td></tr>`;
          }).join('')}</tbody></table>`;
      cuerpo.insertAdjacentHTML('beforeend', `<p class="aplicar-resumen">Valor del documento <b>${pesos(total)}</b> · aplicado <b>${pesos(aplicado)}</b> ·
        disponible <b class="${libre < -0.5 ? 'rojo' : ''}">${pesos(libre)}</b></p>
        ${libre < -0.5 ? '<div class="msg bad">Lo aplicado supera el valor del documento.</div>' : ''}
        ${edit.aplic.some(a => { const f = facturas.find(x => x.id === a.facturaId); return f && +a.valor > saldoSinEste(f) + 0.5; }) ? '<div class="msg bad">Se aplica más que el saldo de alguna factura.</div>' : ''}`);
      if (esNC) {
        const pct = rev ? (rev.factor * 100).toLocaleString('es-CO', { maximumFractionDigits: 1 }) : '0';
        cuerpo.insertAdjacentHTML('beforeend', `<div class="reversion">
          <label class="chk"><input type="checkbox" data-reversar ${edit.reversar ? 'checked' : ''}>
            <b>Reversar las retenciones de la factura</b> en la misma proporción de la nota</label>
          ${!edit.reversar ? '<p class="muted">Sin reversión: escriba ReteIVA y ReteFuente a mano si la nota las trae.</p>'
            : !rev.fs.length ? '<p class="muted">Aplique la nota a una factura para calcular la reversión de sus retenciones.</p>'
            : `<p class="muted">Base de la nota ${pesos(frm.elements.bruto.value)} = ${pct}% de la base de ${rev.fs.map(f => esc(f.numero)).join(', ')}
                (${pesos(rev.fs.reduce((a, f) => a + (+f.bruto || 0), 0))}) → se reversa ReteFuente <b>${pesos(rev.retefuente)}</b>${rev.reteiva ? ` y ReteIVA <b>${pesos(rev.reteiva)}</b>` : ''}.
                Valor neto de la nota: <b>${pesos(totalForm())}</b>.</p>`}
        </div>`);
      }
    } else {
      // Factura: mostrar los créditos que se le han aplicado
      const docs = edit.factura.id ? facturas.filter(d => (d.aplicaciones || []).some(a => a.facturaId === edit.factura.id)) : [];
      sec.hidden = !docs.length;
      if (docs.length) {
        $('#aplicarTitulo').textContent = 'Notas crédito y anticipos aplicados';
        const aplicado = docs.reduce((s, d) => s + d.aplicaciones.filter(a => a.facturaId === edit.factura.id).reduce((t, a) => t + (+a.valor || 0), 0), 0);
        cuerpo.innerHTML = `<table class="ret-items"><thead><tr><th>Documento</th><th>Fecha</th><th class="num">Aplicado</th></tr></thead><tbody>
          ${docs.map(d => `<tr><td>${esc(d.tipoDoc)} ${esc(d.numero || '(sin número)')}</td><td>${fechaTxt(d.fecha)}</td>
            <td class="num">${pesos(d.aplicaciones.filter(a => a.facturaId === edit.factura.id).reduce((t, a) => t + (+a.valor || 0), 0))}</td></tr>`).join('')}
          </tbody></table>
          <p class="aplicar-resumen">Total factura <b>${pesos(totalForm())}</b> − créditos <b>${pesos(aplicado)}</b> = saldo <b>${pesos(red(totalForm() - aplicado))}</b>
          ${red(totalForm() - aplicado) <= 0.5 ? ' <span class="chip ok">Cruzada completa</span>' : ' <span class="chip warn">Cruce parcial</span>'}</p>`;
      }
    }
  }

  $('#aplicarCuerpo').addEventListener('input', e => {
    const id = e.target.dataset.aplicar;
    if (!id) return;
    e.stopPropagation();
    const v = e.target.value === '' ? 0 : +e.target.value;
    edit.aplic = edit.aplic.filter(a => a.facturaId !== +id);
    if (v > 0) edit.aplic.push({ facturaId: +id, valor: red(v) });
    clearTimeout(pintarAplicar.t);
    pintarAplicar.t = setTimeout(() => { const foco = document.activeElement?.dataset.aplicar; pintarAplicar(); if (foco) { const el = $(`[data-aplicar="${foco}"]`); if (el) { el.focus(); el.setSelectionRange?.(99, 99); } } }, 700);
  });
  $('#aplicarCuerpo').addEventListener('change', e => {
    if (e.target.dataset.reversar === undefined) return;
    edit.reversar = e.target.checked;
    if (!edit.reversar) { frm.elements.reteiva.value = 0; frm.elements.retefuente.value = 0; recalcular(); }
    pintarAplicar();
  });
  $('#aplicarCuerpo').addEventListener('click', e => {
    const b = e.target.closest('[data-aplicar-todo]');
    if (!b) return;
    const id = +b.dataset.aplicarTodo, f = facturas.find(x => x.id === id);
    const otros = edit.aplic.filter(a => a.facturaId !== id).reduce((s, a) => s + (+a.valor || 0), 0);
    // Valor neto del documento contando ya con esta factura (en nota crédito cambia la reversión de retenciones)
    let totalNeto = totalForm();
    if (tipoForm() === 'Nota crédito' && edit.reversar) {
      const el = frm.elements;
      const rv = reversionRet(el.bruto.value, facturasAfectadas(edit.factura, [...edit.aplic.filter(a => a.facturaId !== id), { facturaId: id, valor: 1 }]));
      totalNeto = red((+el.bruto.value || 0) + (+el.iva.value || 0) - rv.reteiva - rv.retefuente);
    }
    const v = red(Math.max(0, Math.min(saldoSinEste(f), totalNeto - otros)));
    edit.aplic = edit.aplic.filter(a => a.facturaId !== id);
    if (v > 0) edit.aplic.push({ facturaId: id, valor: v });
    pintarAplicar();
  });

  // Validación antes de guardar un crédito
  function errorAplicacion() {
    if (!creditoForm()) return '';
    const aplicado = edit.aplic.reduce((s, a) => s + (+a.valor || 0), 0);
    if (aplicado > totalForm() + 0.5) return `Lo aplicado (${pesos(aplicado)}) supera el valor del documento (${pesos(totalForm())}).`;
    for (const a of edit.aplic) {
      const f = facturas.find(x => x.id === a.facturaId);
      if (f && +a.valor > saldoSinEste(f) + 0.5) return `A la factura ${f.numero} se le aplica ${pesos(a.valor)}, pero su saldo es ${pesos(saldoSinEste(f))}.`;
    }
    return '';
  }

  $('#inpComprobante').addEventListener('change', e => {
    for (const f of e.target.files) edit.nuevos.push({ tipo: 'pago', nombre: f.name, blob: f });
    e.target.value = '';
    pintarAdjuntos();
    // Si aún no tiene fecha de pago, se propone hoy
    if (!frm.elements.fechaPago.value && !creditoForm()) { frm.elements.fechaPago.value = hoy(); toast('Se propuso la fecha de pago de hoy; ajústela si es otra'); }
  });

  $('#inpPdf').addEventListener('change', e => {
    for (const f of e.target.files) edit.nuevos.push({ tipo: /\.xml$/i.test(f.name) ? 'xml' : 'pdf', nombre: f.name, blob: f });
    e.target.value = '';
    pintarAdjuntos();
  });

  async function guardarFormulario() {
    const el = frm.elements, f = edit.factura;
    const reg = {
      ...f,
      proveedor: limpio(el.proveedor.value), nit: normNit(el.nit.value), numero: limpio(el.numero.value).toUpperCase(),
      fecha: el.fecha.value, fechaRecepcion: el.fechaRecepcion.value, vencimiento: el.vencimiento.value,
      bruto: red(el.bruto.value), iva: red(el.iva.value), reteiva: red(el.reteiva.value), retefuente: red(el.retefuente.value),
      retenciones: filasRetencion().todas.filter(r => r.concepto && (conceptoRet(r.concepto) || +r.valor)).map(r => ({
        origen: r.origen || 'manual', concepto: r.concepto, base: r.base ?? '', tarifa: r.tarifa ?? '', valor: red(r.valor), baseAuto: !!r.baseAuto, ...(r.historico ? { historico: true } : {}) })),
      clasif: edit.lineas ? [...edit.clasif] : f.clasif,
      tarifasRet: { ...edit.tarifas },
      usarRetXml: !!edit.usarRetXml,
      tipoDoc: el.tipoDoc.value || 'Factura',
      aplicaciones: creditoForm() ? edit.aplic.filter(a => +a.valor > 0).map(a => ({ facturaId: a.facturaId, valor: red(a.valor) })) : [],
      total: red(el.total.value),
      empresa: empresaOficial(el.empresa.value), centro: limpio(el.centro.value).toUpperCase(),
      fechaPago: el.fechaPago.value, pagoRef: limpio(el.pagoRef.value), empresaPago: limpio(el.empresaPago.value), notas: limpio(el.notas.value),
      modificado: new Date().toISOString(),
    };
    if (creditoForm()) { reg.retenciones = []; reg.clasif = null; }
    if (reg.tipoDoc === 'Anticipo') { reg.retefuente = 0; reg.reteiva = 0; }
    if (reg.tipoDoc === 'Nota crédito') reg.reversarRet = !!edit.reversar;
    reg.clave = claveDe(reg.proveedor, reg.numero, reg.fecha);
    if (!reg.creado) reg.creado = reg.modificado;
    if (!reg.id) delete reg.id;
    const id = await DB.guardar('facturas', reg);
    for (const a of edit.nuevos) await DB.guardar('archivos', { facturaId: id, tipo: a.tipo, nombre: a.nombre, blob: a.blob, fecha: reg.modificado });
    for (const aid of edit.quitar) await DB.borrar('archivos', aid);
    // Recordar nombres por NIT para la próxima importación
    if (reg.nit && nitProveedor[reg.nit] !== reg.proveedor) { nitProveedor[reg.nit] = reg.proveedor; await DB.setCfg('nitProveedor', nitProveedor); }
    // El NIT es del proveedor: se completa en sus otras facturas que no lo tengan
    if (reg.nit) {
      const otras = facturas.filter(x => x.id !== id && !x.nit && limpio(x.proveedor) === reg.proveedor);
      if (otras.length) await DB.guardarVarias('facturas', otras.map(x => ({ ...x, nit: reg.nit })));
    }
    if (reg.adqNit && reg.empresa && nitEmpresa[reg.adqNit] !== reg.empresa) {
      nitEmpresa[reg.adqNit] = reg.empresa; await DB.setCfg('nitEmpresa', nitEmpresa);
    }
    // Aprender la clasificación de cada producto de este proveedor para la próxima factura
    if (edit.lineas && reg.nit) {
      let cambio = false;
      edit.lineas.forEach((l, i) => { const c = edit.clasif[i], k = claveItem(reg.nit, l); if (c && clasifProducto[k] !== c) { clasifProducto[k] = c; cambio = true; } });
      if (cambio) await DB.setCfg('clasifProducto', clasifProducto);
    }
    // Responsabilidades del proveedor tomadas del XML, si aún no estaban registradas en la app
    const kp = claveProv(reg.proveedor, reg.nit);
    if (edit.respXml && edit.respXml.resp.length && !provInfo[kp]) {
      provInfo[kp] = { persona: edit.respXml.persona, resp: edit.respXml.resp, concepto: '', fuente: 'xml' };
      await DB.setCfg('proveedoresInfo', provInfo);
    }
    return id;
  }

  // Cierre explícito (no depende del evento 'close' del <dialog>)
  async function cerrarFormulario(guardar) {
    if (guardar && edit) {
      const errAp = errorAplicacion();
      if (errAp) { alert(errAp); return; }
      try { await guardarFormulario(); }
      catch (err) { alert('No se pudo guardar: ' + err.message); return; }
      if (resumenImport) resumenImport.guardadas++;
      dlg.close();
      await cargar();
      toast('Factura guardada');
    } else {
      if (resumenImport && edit) resumenImport.omitidas++;
      dlg.close();
    }
    siguienteDeCola();
  }

  frm.addEventListener('submit', e => { e.preventDefault(); cerrarFormulario(true); });
  $('#btnOmitir').addEventListener('click', () => cerrarFormulario(false));
  $('#btnCancelar').addEventListener('click', () => cerrarFormulario(false));
  dlg.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); cerrarFormulario(false); } });

  $('#btnBorrarFactura').addEventListener('click', async () => {
    const f = edit.factura;
    const conCruce = facturas.filter(d => (d.aplicaciones || []).some(a => a.facturaId === f.id));
    if (!confirm(`¿Eliminar ${(f.tipoDoc || 'factura').toLowerCase()} ${f.numero} de ${f.proveedor} y sus adjuntos?` +
      (conCruce.length ? `\nSe liberarán las notas crédito / anticipos aplicados a ella (${conCruce.map(d => d.numero).join(', ')}).` : '') +
      '\nEsta acción no se puede deshacer (salvo restaurando una copia de seguridad).')) return;
    // Los créditos aplicados a esta factura quedan otra vez disponibles
    if (conCruce.length) await DB.guardarVarias('facturas', conCruce.map(d => ({ ...d, aplicaciones: d.aplicaciones.filter(a => a.facturaId !== f.id) })));
    await DB.borrarFactura(f.id);
    edit = null;
    dlg.close();
    await cargar();
    toast('Factura eliminada');
    siguienteDeCola();
  });

  $('#btnNueva').addEventListener('click', () => {
    cola = []; resumenImport = null;
    abrirFormulario({ origen: 'manual', fecha: hoy(), fechaRecepcion: hoy(), reteiva: 0, retefuente: 0, iva: 0 });
  });

  // ---------- adjuntos: abrir / descargar ----------
  // ---------- visor de documentos ----------
  // PDF e imágenes (facturas y comprobantes de pago) se ven dentro de la app, sin descargar; el XML se descarga.
  const IMG_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  function tipoVista(a) {
    const mime = a?.blob?.type || '', ext = (a?.nombre || '').split('.').pop().toLowerCase();
    if (a?.tipo === 'pdf' || ext === 'pdf' || mime === 'application/pdf') return 'application/pdf';
    if (mime.startsWith('image/')) return mime;
    return IMG_EXT[ext] || '';
  }
  const ETIQ_ADJ = { pdf: 'Factura', pago: 'Comprobante de pago', xml: 'XML' };
  const visor = { lista: [], i: 0, url: null };

  async function abrirBlob(a, lista) {
    if (!a) return;
    if (!tipoVista(a)) { descargar(a.blob, a.nombre); return; }
    if (!lista && a.facturaId != null) lista = await DB.archivosDe(a.facturaId);
    lista = (lista || [a]).filter(x => tipoVista(x));
    let i = lista.findIndex(x => x === a || (x.id != null && x.id === a.id));
    if (i < 0) { lista.unshift(a); i = 0; }
    visor.lista = lista;
    mostrarVisor(i);
    const d = $('#dlgVisor');
    if (!d.open) d.showModal();
  }

  function mostrarVisor(i) {
    const lista = visor.lista, a = lista[i];
    visor.i = i;
    if (visor.url) URL.revokeObjectURL(visor.url);
    const tv = tipoVista(a);
    visor.url = URL.createObjectURL(new Blob([a.blob], { type: tv }));
    $('#visorNombre').textContent = a.nombre;
    $('#visorInfo').textContent = `· ${ETIQ_ADJ[a.tipo] || 'Documento'} · ${Math.max(1, Math.round((a.blob?.size || 0) / 1024)).toLocaleString('es-CO')} KB`;
    $('#visorLista').innerHTML = lista.length > 1 ? lista.map((x, j) => `<button type="button" class="btn sm ${j === i ? 'primary' : 'ghost'}" data-visor="${j}"
      title="${esc(x.nombre)}">${esc(ETIQ_ADJ[x.tipo] || 'Documento')}${lista.filter(y => y.tipo === x.tipo).length > 1 ? ' ' + (lista.filter(y => y.tipo === x.tipo).indexOf(x) + 1) : ''}</button>`).join('') : '';
    $('#visorCuerpo').innerHTML = tv === 'application/pdf'
      ? `<iframe src="${visor.url}#view=FitH" title="${esc(a.nombre)}"></iframe>`
      : `<div class="visor-img"><img src="${visor.url}" alt="${esc(a.nombre)}"></div>`;
  }

  function cerrarVisor() {
    const d = $('#dlgVisor');
    if (d.open) d.close();
    $('#visorCuerpo').innerHTML = '';
    if (visor.url) { URL.revokeObjectURL(visor.url); visor.url = null; }
  }
  $('#visorCerrar').addEventListener('click', cerrarVisor);
  $('#visorLista').addEventListener('click', e => { const b = e.target.closest('[data-visor]'); if (b) mostrarVisor(+b.dataset.visor); });
  $('#visorDescargar').addEventListener('click', () => { const a = visor.lista[visor.i]; if (a) descargar(a.blob, a.nombre); });
  $('#visorPestana').addEventListener('click', () => {
    const a = visor.lista[visor.i]; if (!a) return;
    const url = URL.createObjectURL(new Blob([a.blob], { type: tipoVista(a) }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
  $('#dlgVisor').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); cerrarVisor(); }
    if (e.key === 'ArrowRight' && visor.i < visor.lista.length - 1) mostrarVisor(visor.i + 1);
    if (e.key === 'ArrowLeft' && visor.i > 0) mostrarVisor(visor.i - 1);
  });
  // Clic fuera del documento (en el fondo oscuro) cierra el visor
  $('#dlgVisor').addEventListener('click', e => { if (e.target.id === 'dlgVisor') cerrarVisor(); });

  // Adjuntar PDF directamente desde la tabla
  let pdfPara = null;
  const inpRapido = Object.assign(document.createElement('input'), { type: 'file', accept: '.pdf', multiple: true });
  inpRapido.addEventListener('change', async () => {
    for (const f of inpRapido.files) await DB.guardar('archivos', { facturaId: pdfPara, tipo: 'pdf', nombre: f.name, blob: f, fecha: new Date().toISOString() });
    inpRapido.value = '';
    await cargar();
    toast('PDF adjuntado');
  });

  $('#vista').addEventListener('click', async e => {
    const t = e.target;
    const fi = t.closest('[data-ficha]');
    if (fi) { abrirFicha(fi.dataset.ficha); return; }
    const ed = t.closest('[data-editar]');
    if (ed) { cola = []; resumenImport = null; const f = facturas.find(x => x.id === +ed.dataset.editar); if (f) abrirFormulario({ ...f }); return; }
    const ab = t.closest('[data-abrir]');
    if (ab) { abrirBlob(await DB.obtener('archivos', +ab.dataset.abrir)); return; }
    const ap = t.closest('[data-addpdf]');
    if (ap) { pdfPara = +ap.dataset.addpdf; inpRapido.click(); return; }
    const th = t.closest('th[data-orden]');
    if (th) {
      const c = th.dataset.orden === '_estado' ? 'vencimiento' : th.dataset.orden;
      const [oc, od] = orden[tab];
      orden[tab] = [c, oc === c ? -od : 1];
      render();
      return;
    }
    if (t.id === 'btnMasFilas') { limite += 500; render(); return; }
    if (t.dataset.sel) { t.checked ? sel.add(+t.dataset.sel) : sel.delete(+t.dataset.sel); t.closest('tr').classList.toggle('sel', t.checked); renderSel(); return; }
    if (t.dataset.selGrupo) { t.dataset.selGrupo.split(',').forEach(id => t.checked ? sel.add(+id) : sel.delete(+id)); render(); return; }
    if (t.id === 'chkTodas') { filtradas().filter(f => !esCredito(f)).forEach(f => t.checked ? sel.add(f.id) : sel.delete(f.id)); render(); }
  });

  // ---------- pagos en lote ----------
  $('#btnDeselect').addEventListener('click', () => { sel.clear(); render(); });
  $('#btnPagar').addEventListener('click', () => {
    const d = $('#dlgPago'), fs = facturas.filter(f => sel.has(f.id));
    $('#pagoInfo').innerHTML = `${fs.length} facturas por <b>${pesos(fs.reduce((a, f) => a + saldo(f), 0))}</b>${fs.some(f => creditosDe(f)) ? ' (saldo después de notas crédito / anticipos aplicados)' : ''}`;
    d.querySelector('[name=fechaPago]').value = hoy();
    d.querySelector('[name=comprobante]').value = '';
    d.showModal();
  });
  $('#btnCancelarPago').addEventListener('click', () => $('#dlgPago').close());
  $('#frmPago').addEventListener('submit', async e => {
    e.preventDefault();
    const d = $('#dlgPago');
    d.close();
    const fecha = d.querySelector('[name=fechaPago]').value, quien = limpio(d.querySelector('[name=empresaPago]').value);
    const mod = new Date().toISOString();
    const lista = facturas.filter(f => sel.has(f.id)).map(f => ({ ...f, fechaPago: fecha, empresaPago: quien, modificado: mod }));
    await DB.guardarVarias('facturas', lista);
    // Comprobante(s) de pago: se adjuntan a cada factura pagada
    const inpC = d.querySelector('[name=comprobante]'), comprobantes = [...inpC.files];
    for (const f of lista) for (const c of comprobantes) {
      await DB.guardar('archivos', { facturaId: f.id, tipo: 'pago', nombre: c.name, blob: c, fecha: mod });
    }
    inpC.value = '';
    sel.clear();
    await cargar();
    toast(`${lista.length} facturas marcadas como pagadas${comprobantes.length ? ' con su comprobante de pago' : ''}`);
  });

  // ---------- importación de XML y PDF ----------
  async function importarArchivos(files) {
    files = [...files];
    const xmls = files.filter(f => /\.xml$/i.test(f.name));
    const pdfs = files.filter(f => /\.pdf$/i.test(f.name));
    const usados = new Set();
    const errores = [];
    const borradores = [];
    let adjuntadas = 0, repetidas = 0;

    for (const file of xmls) {
      let r;
      try { r = Parser.procesar(Parser.decodificar(await file.arrayBuffer()), file.name); }
      catch (e) { if (!e.omitir) errores.push(`${file.name}: ${e.message}`); continue; }
      const x = r.factura;
      const num = normNum(x.numero);
      const pdfsFactura = pdfs.filter(p => normNum(p.name).includes(num));
      pdfsFactura.forEach(p => usados.add(p));
      const nuevos = [{ tipo: 'xml', nombre: file.name, blob: file }, ...pdfsFactura.map(p => ({ tipo: 'pdf', nombre: p.name, blob: p }))];

      const proveedor = sugerirProveedor(x.emisorNit, x.emisorNombre);
      // ¿Ya existe? (mismo CUFE o mismo proveedor + número): solo se completan adjuntos que falten
      const existe = facturas.find(f => (x.cufe && f.cufe === x.cufe)) || facturas.find(f => f.clave === claveDe(proveedor, x.numero))
        || facturas.find(f => f.nit && f.nit === normNit(x.emisorNit) && normNum(f.numero) === num);
      if (existe) {
        repetidas++;
        const a = adj.get(existe.id) || { pdf: [], xml: [], pago: [] };
        for (const n of nuevos) {
          if (a[n.tipo].length) continue;
          await DB.guardar('archivos', { facturaId: existe.id, ...n, fecha: new Date().toISOString() });
          adjuntadas++;
        }
        if (!existe.cufe || !existe.nit) await DB.guardar('facturas', { ...existe, cufe: existe.cufe || x.cufe, nit: existe.nit || normNit(x.emisorNit) });
        continue;
      }

      const avisos = [];
      if (x.tipo === 'Nota crédito') avisos.push(['info', `Nota crédito${x.facturaRef ? ` que afecta la factura <b>${esc(x.facturaRef)}</b>` : ''}${x.motivoNota ? ` · motivo: ${esc(x.motivoNota)}` : ''}. Revise abajo a qué factura(s) se aplica y por cuánto.`]);
      else if (x.tipo !== 'Factura') avisos.push(['warn', `Este documento es una <b>${x.tipo}</b>: aumenta lo que se le debe al proveedor.`]);
      if (x.estadoDian && x.estadoDian !== 'Validado DIAN') avisos.push(['warn', `Estado DIAN: ${esc(x.estadoDian)}`]);
      const rt = x.retencionesTipo || {};
      if (x.retenciones) avisos.push(['info', `El XML informa retenciones: ${esc(x.retencionesDetalle)}. La ReteFuente se calcula con la clasificación de los ítems.`]);
      else if (x.tipo !== 'Nota crédito') avisos.push(['info', 'El XML no informa retención en la fuente: se calcula con la clasificación de cada ítem (vea «Productos y servicios»).']);
      if (!pdfsFactura.length) avisos.push(['info', 'No se encontró el PDF de esta factura entre los archivos seleccionados. Puede adjuntarlo abajo.']);

      const cred = diasCreditoDe(proveedor);
      const vencXml = x.vencimiento && x.vencimiento > x.fecha ? x.vencimiento : '';
      const vencimiento = cred && cred.dias > 0 ? sumarDias(x.fecha, cred.dias) : (vencXml || x.vencimiento || x.fecha);
      const hintVenc = [
        cred ? `Crédito habitual: ${cred.dias} días (factura ${cred.ref})` : 'Proveedor nuevo',
        `XML: ${fechaTxt(x.vencimiento) || 'sin fecha'}`,
      ].join(' · ');
      const iva = red(x.iva);
      borradores.push({
        factura: {
          origen: 'xml', proveedor, nit: normNit(x.emisorNit), numero: x.numero, fecha: x.fecha, fechaRecepcion: hoy(), vencimiento,
          bruto: brutoDeXml(x), iva, reteiva: x.tipo === 'Nota crédito' ? 0 : rt.reteiva || 0, retefuente: 0, clasif: null,
          facturaRef: x.facturaRef || '', facturaRefCufe: x.facturaRefCufe || '', motivoNota: x.motivoNota || '', aplicaciones: null,
          retenciones: [],
          empresa: sugerirEmpresa(x.adqNit, x.adqNombre), centro: cred?.centro || '',
          cufe: x.cufe, adqNit: x.adqNit, adqNombre: x.adqNombre, tipoDoc: x.tipo, totalXml: x.total, fechaPago: '', empresaPago: '', notas: '',
        },
        nuevos, avisos,
        hints: { venc: hintVenc, total: `Valor a pagar según XML: ${pesos(x.total)}${x.retenciones && Math.abs(x.diferencia + x.retenciones) < 1 ? ' (ya descuenta retenciones)' : ''}${cred?.centro ? ` · centro sugerido por la factura ${cred.ref}` : ''}` },
      });
    }

    // PDF sueltos (sin su XML en la selección): se asocian a una factura existente con ese número
    let pdfSueltos = 0; const sinPareja = [];
    for (const p of pdfs.filter(p => !usados.has(p))) {
      const n = normNum(p.name);
      const cand = facturas.filter(f => normNum(f.numero).length >= 3 && n.includes(normNum(f.numero)));
      // Si hay varios candidatos, gana el número más largo (FEV4194 vs FEV419469)
      cand.sort((a, b) => normNum(b.numero).length - normNum(a.numero).length);
      const mejor = cand.filter(f => normNum(f.numero).length === normNum(cand[0]?.numero).length);
      if (mejor.length === 1) {
        await DB.guardar('archivos', { facturaId: mejor[0].id, tipo: 'pdf', nombre: p.name, blob: p, fecha: new Date().toISOString() });
        pdfSueltos++;
      } else sinPareja.push(p.name);
    }

    resumenImport = { total: borradores.length, guardadas: 0, omitidas: 0, repetidas, adjuntadas: adjuntadas + pdfSueltos, errores, sinPareja };
    // Primero las facturas y después las notas crédito, para que la nota encuentre su factura ya guardada
    borradores.sort((a, b) => (a.factura.tipoDoc === 'Nota crédito') - (b.factura.tipoDoc === 'Nota crédito'));
    cola = borradores.map((b, i) => ({ ...b, paso: borradores.length > 1 ? `${i + 1} de ${borradores.length}` : '' }));
    await cargar();
    siguienteDeCola();
  }

  function siguienteDeCola() {
    if (cola.length) {
      const b = cola.shift();
      abrirFormulario(b.factura, b);
      return;
    }
    edit = null;
    if (resumenImport) {
      const r = resumenImport; resumenImport = null;
      const partes = [];
      if (r.total) partes.push(`${r.guardadas} de ${r.total} facturas nuevas guardadas`);
      if (r.repetidas) partes.push(`${r.repetidas} ya estaban registradas`);
      if (r.adjuntadas) partes.push(`${r.adjuntadas} adjuntos agregados a facturas existentes`);
      if (r.sinPareja.length) partes.push(`PDF sin factura: ${r.sinPareja.join(', ')}`);
      if (r.errores.length) partes.push(`Errores: ${r.errores.join(' | ')}`);
      if (r.errores.length || r.sinPareja.length) alert(partes.join('\n'));
      else if (partes.length) toast(partes.join(' · '), 6000);
    }
  }

  $('#inpXml').addEventListener('change', e => { importarArchivos(e.target.files); e.target.value = ''; });

  // Arrastrar y soltar
  let arrastre = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { arrastre++; $('#dropzone').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--arrastre <= 0) { arrastre = 0; $('#dropzone').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); arrastre = 0; $('#dropzone').hidden = true;
    if (dlg.open && edit) {   // soltar sobre el formulario abierto = adjuntar
      for (const f of e.dataTransfer.files) if (/\.(pdf|xml)$/i.test(f.name)) edit.nuevos.push({ tipo: /\.pdf$/i.test(f.name) ? 'pdf' : 'xml', nombre: f.name, blob: f });
      pintarAdjuntos();
    } else importarArchivos(e.dataTransfer.files);
  });

  // ---------- copias de seguridad ----------
  // Una sola copia, completa, en UN archivo .json: datos + todos los adjuntos (PDF, XML, comprobantes)
  // incluidos en base64 dentro del mismo JSON. Cada archivo idéntico (mismo contenido) se guarda
  // UNA sola vez aunque esté adjunto a varias facturas. El nombre lleva fecha y hora de la copia.
  const sello = () => { const d = new Date(); return `${iso(d)}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`; };
  const aBase64 = blob => new Promise((ok, mal) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] || '');
    r.onerror = () => mal(r.error);
    r.readAsDataURL(blob);
  });
  const deBase64 = (b64, tipo) => {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: tipo });
  };
  const mb = b => b >= 1048576 ? `${(b / 1048576).toLocaleString('es-CO', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(b / 1024)).toLocaleString('es-CO')} KB`;

  // Huella del contenido (SHA-256) para detectar archivos repetidos
  async function huella(blob) {
    try {
      const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      return [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch { return `t${blob.size}_${blob.type.replace(/\W/g, '')}`; }   // sin crypto: por tamaño (menos exacto)
  }

  // Pregunta dónde guardar la copia (ventana "Guardar como" del sistema; Edge/Chrome).
  // Debe llamarse enseguida tras el clic: el navegador solo abre la ventana como respuesta a un gesto del usuario.
  // Devuelve el archivo elegido, null si el usuario canceló, o 'descarga' si el navegador no permite elegir.
  async function elegirDestino(nombre) {
    if (!window.showSaveFilePicker) return 'descarga';
    try {
      return await window.showSaveFilePicker({
        suggestedName: nombre, id: 'cxp-copias', startIn: 'documents',
        types: [{ description: 'Copia de seguridad (JSON)', accept: { 'application/json': ['.json'] } }],
      });
    } catch (e) {
      if (e.name === 'AbortError') return null;   // canceló la ventana
      return 'descarga';                          // sin permiso o sin gesto del usuario: descarga normal
    }
  }

  async function crearCopia(prefijo = 'copia-de-seguridad') {
    const nombre = `${prefijo}_${sello()}.json`;
    const destino = await elegirDestino(nombre);
    if (!destino) return null;
    toast('Generando copia de seguridad… (puede tardar si hay muchos adjuntos)', 20000);
    const config = await DB.todas('config');
    const archivos = await DB.todas('archivos');
    const meta = [], contenidos = {}, vistos = new Map();   // huella -> ruta
    let originales = 0, repetidos = 0, ahorro = 0;
    for (const a of archivos) {
      originales += a.blob?.size || 0;
      const h = await huella(a.blob);
      let ruta = vistos.get(h);
      if (ruta) { repetidos++; ahorro += a.blob?.size || 0; }
      else {
        const ext = (a.nombre.match(/\.[a-z0-9]{1,5}$/i) || [''])[0].toLowerCase();
        ruta = `archivos/${h}${ext}`;
        contenidos[ruta] = a.blob ? await aBase64(a.blob) : '';
        vistos.set(h, ruta);
      }
      meta.push({ id: a.id, facturaId: a.facturaId, tipo: a.tipo, nombre: a.nombre, fecha: a.fecha, mime: a.blob?.type || '', ruta });
    }
    const datos = { app: 'facturas-por-cancelar', version: 3, tipo: 'completa', fecha: new Date().toISOString(), facturas, archivos: meta, contenidos, config };
    const blob = new Blob([JSON.stringify(datos)], { type: 'application/json' });
    if (destino === 'descarga') descargar(blob, nombre);
    else { const w = await destino.createWritable(); await w.write(blob); await w.close(); }
    return { tam: blob.size, originales, repetidos, ahorro, adjuntos: meta.length,
      nombre: destino === 'descarga' ? nombre : destino.name, elegido: destino !== 'descarga' };
  }

  // Devuelve true si la copia quedó guardada.
  async function hacerCopia() {
    if (!facturas.length) { toast('No hay datos para copiar todavía'); return false; }
    let r;
    try { r = await crearCopia(); }
    catch (err) { alert('No se pudo guardar la copia de seguridad: ' + err.message); return false; }
    if (!r) { toast('Copia de seguridad cancelada: no se guardó ningún archivo'); return false; }
    const ahora = new Date().toISOString();
    await DB.setCfg('ultimaCopia', ahora);
    await DB.setCfg('ultimaCopiaCompleta', ahora);
    await revisarCopia(); renderKpis();
    toast(`Copia de seguridad ${r.elegido ? `guardada como "${r.nombre}"` : 'descargada'} (${mb(r.tam)}; ${r.adjuntos} adjuntos que ocupan ${mb(r.originales)} en la app` +
      `${r.repetidos ? `; ${r.repetidos} archivos repetidos guardados una sola vez, ${mb(r.ahorro)} menos` : ''}).` +
      `${r.elegido ? '' : ' Guárdela en OneDrive o en otra carpeta segura.'}`, 10000);
    return true;
  }
  $('#btnBackup').addEventListener('click', () => hacerCopia());

  $('#inpRestaurar').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = ''; $('#menuMas').hidden = true;
    if (!file) return;
    try {
      // Copias actuales: un solo .json con los adjuntos en base64. Copias antiguas: .zip con datos.json + archivos/.
      const esZip = /\.zip$/i.test(file.name);
      let zip = null, datos;
      if (esZip) {
        zip = await JSZip.loadAsync(file);
        const j = zip.file('datos.json');
        if (!j) throw new Error('el archivo no contiene datos.json');
        datos = JSON.parse(await j.async('string'));
      } else {
        try { datos = JSON.parse(await file.text()); } catch { throw new Error('el archivo no es un JSON válido'); }
      }
      if (datos.app !== 'facturas-por-cancelar') throw new Error('no es una copia de esta aplicación');
      const fecha = new Date(datos.fecha).toLocaleString('es-CO');
      const soloDatos = datos.tipo === 'solo-datos';
      if (!confirm(`Copia ${soloDatos ? 'SOLO DATOS' : 'completa'} del ${fecha}: ${datos.facturas.length} documentos` +
        (soloDatos ? '.\nLos adjuntos (PDF, XML, comprobantes) que ya están en este navegador se conservan.' : ` y ${datos.archivos.length} adjuntos.`) +
        `\n\nEsto REEMPLAZA los ${facturas.length} registros actuales.` +
        (facturas.length ? '\nAntes de restaurar se le preguntará dónde guardar una copia de seguridad de los datos actuales.' : '') + '\n\n¿Restaurar?')) return;
      if (facturas.length && !(await crearCopia('antes-de-restaurar')) &&
        !confirm('No se guardó la copia de los datos actuales.\n\n¿Restaurar de todas formas? Los registros actuales se perderán.')) return;
      const config = (datos.config || []).filter(c => !['ultimaCopia', 'ultimaCopiaCompleta'].includes(c.k));
      config.push({ k: 'ultimaCopia', v: datos.fecha });   // lo restaurado ya está respaldado en ese archivo
      if (!soloDatos) config.push({ k: 'ultimaCopiaCompleta', v: datos.fecha });
      else { const c = await DB.cfg('ultimaCopiaCompleta', null); if (c) config.push({ k: 'ultimaCopiaCompleta', v: c }); }
      if (soloDatos) {
        await DB.reemplazarDatos({ facturas: datos.facturas, config });
        ultimoCambio = datos.fecha; lsPoner('cxp-ultimoCambio', ultimoCambio);   // lo restaurado es igual a la copia
      } else {
        const archivos = [], cache = new Map();   // una ruta puede servir a varios adjuntos (archivos repetidos)
        for (const a of datos.archivos) {
          const mime = a.mime || (a.tipo === 'xml' ? 'application/xml' : 'application/pdf');
          if (!cache.has(a.ruta)) {
            if (zip) { const z = zip.file(a.ruta); if (!z) continue; cache.set(a.ruta, new Blob([await z.async('arraybuffer')], { type: mime })); }
            else { const b64 = datos.contenidos?.[a.ruta]; if (b64 === undefined) continue; cache.set(a.ruta, deBase64(b64, mime)); }
          }
          const blob = new Blob([cache.get(a.ruta)], { type: mime });
          archivos.push({ id: a.id, facturaId: a.facturaId, tipo: a.tipo, nombre: a.nombre, fecha: a.fecha, blob });
        }
        await DB.reemplazarTodo({ facturas: datos.facturas, archivos, config });
        ultimoCambio = datos.fecha; lsPoner('cxp-ultimoCambio', ultimoCambio);
      }
      sel.clear();
      await cargar();
      toast(`Copia restaurada: ${datos.facturas.length} documentos${soloDatos ? ' (adjuntos conservados)' : `, ${datos.archivos.length} adjuntos`}`);
    } catch (err) { alert('No se pudo restaurar: ' + err.message); }
  });

  async function revisarCopia() {
    // Referencia: la última copia completa (las antiguas copias "solo datos" no cuentan, no traen los adjuntos)
    const ult = await DB.cfg('ultimaCopiaCompleta', await DB.cfg('ultimaCopia', null));
    revisarCopia.ultima = ult;
    const d = ult ? dias(ult.slice(0, 10), hoy()) : null;
    const av = $('#aviso');
    let msg = '';
    if (facturas.length && d === null) msg = 'Los datos solo existen en este navegador y aún no ha descargado ninguna copia de seguridad.';
    else if (facturas.length && cambiosSinCopia()) msg = `Hay cambios desde la última copia de seguridad (${fechaHora(ult)}, ${hace(ult)}). Último cambio: ${fechaHora(ultimoCambio)}`;
    else if (facturas.length && d > 7) msg = `Los datos solo existen en este navegador. La última copia fue el ${fechaHora(ult)} (${hace(ult)}).`;
    if (msg) { av.innerHTML = `<span>⚠ ${msg}</span><span class="aviso-botones"><button class="btn sm primary" data-copia>Copia de seguridad</button></span>`; av.hidden = false; }
    else av.hidden = true;
  }
  $('#aviso').addEventListener('click', e => { if (e.target.closest('[data-copia]')) hacerCopia(); });

  // ---------- aviso antes de cerrar o recargar ----------
  // Al cerrar la pestaña o el navegador solo se puede mostrar el aviso propio del navegador (sin botones).
  // Al recargar con F5 / Ctrl+R se muestra una ventana con la opción de hacer la copia completa primero.
  let salirSinAviso = false;
  window.addEventListener('beforeunload', e => {
    if (salirSinAviso || !facturas.length || !cambiosSinCopia()) return;
    e.preventDefault();
    e.returnValue = 'Hay cambios sin copia de seguridad.';
    return e.returnValue;
  });
  window.addEventListener('keydown', e => {
    const recargar = e.key === 'F5' || ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'));
    if (!recargar || !facturas.length || !cambiosSinCopia()) return;
    e.preventDefault();
    const ult = revisarCopia.ultima;
    $('#salirInfo').innerHTML = ult
      ? `La última copia de seguridad es del <b>${fechaHora(ult)}</b> (${hace(ult)}) y hay cambios posteriores (último: ${fechaHora(ultimoCambio)}).`
      : 'Todavía no ha descargado ninguna copia de seguridad.';
    $('#dlgSalir').showModal();
  });
  $('#salirCopia').addEventListener('click', async () => {
    $('#dlgSalir').close();
    if (!(await hacerCopia())) return;   // canceló o falló: no recargar
    salirSinAviso = true;
    setTimeout(() => location.reload(), 1500);   // da tiempo a que empiece la descarga
  });
  $('#salirSin').addEventListener('click', () => { salirSinAviso = true; location.reload(); });
  $('#salirCancelar').addEventListener('click', () => $('#dlgSalir').close());

  // ---------- exportar a Excel / PDF por empresa ----------
  const nombreEmpresa = f => limpio(f.empresa) || '(Sin empresa)';
  const porEmpresa = lista => {
    const m = new Map();
    for (const f of lista) { const e = nombreEmpresa(f); if (!m.has(e)) m.set(e, []); m.get(e).push(f); }
    return [...m].sort((a, b) => a[0].localeCompare(b[0], 'es'));
  };

  // Descripción legible de los filtros activos (va en el encabezado del Excel y del PDF)
  function descFiltros() {
    const p = [];
    if ($('#fTexto').value) p.push(`Búsqueda: "${$('#fTexto').value}"`);
    if ($('#fEmpresa').value) p.push(`Empresa: ${$('#fEmpresa').value}`);
    if (tab !== 'proveedores') {
      if ($('#fCentro').value) p.push(`Centro: ${$('#fCentro').value}`);
      if ($('#fEstado').value) p.push(`Estado: ${$('#fEstado').selectedOptions[0].text}`);
      p.push(...rangosActivos());
    }
    return p.length ? 'Filtros: ' + p.join(' · ') : 'Sin filtros';
  }

  const COLS_FACTURA = [
    { h: 'Proveedor', k: 'proveedor', ancho: 32 }, { h: 'NIT', k: 'nit', ancho: 12 }, { h: 'No factura', k: 'numero', ancho: 12 },
    { h: 'Centro', k: 'centro', ancho: 13 },
    { h: 'Fecha factura', k: 'fecha', tipo: 'fecha' }, { h: 'Recepción', k: 'fechaRecepcion', tipo: 'fecha' },
    { h: 'Vencimiento', k: 'vencimiento', tipo: 'fecha' },
  ];
  const COLS_VALORES = [
    { h: 'Valor bruto', k: 'bruto', tipo: 'dinero', pdf: false }, { h: 'IVA', k: 'iva', tipo: 'dinero', pdf: false },
    { h: 'ReteIVA', k: 'reteiva', tipo: 'dinero', pdf: false }, { h: 'ReteFuente', k: 'retefuente', tipo: 'dinero', pdf: false },
    { h: 'Concepto retención', k: '_conceptosRet', pdf: false, ancho: 44 },
    { h: 'Total factura', k: 'total', tipo: 'dinero', suma: true },
  ];

  function datosExportacion() {
    const base = { filtros: descFiltros(), unidad: 'facturas' };
    if ((tab === 'pendientes' && !agrupar) || tab === 'historico') {
      const hist = tab === 'historico';
      const columnas = [...COLS_FACTURA.slice(0, 3), { h: 'Tipo', k: '_doc', ancho: 12 }, ...COLS_FACTURA.slice(3),
        ...(hist ? [{ h: 'Fecha pago / cruce', k: '_pago', tipo: 'fecha' }, { h: 'Pagó', k: 'empresaPago', ancho: 20 }]
                 : [{ h: 'Estado', k: '_estado', ancho: 18 }, { h: 'Días para vencer', k: '_dias', tipo: 'num', pdf: false }]),
        // En pendientes lo que se suma es el saldo (total − notas crédito / anticipos aplicados)
        ...(hist ? COLS_VALORES : [...COLS_VALORES.map(c => c.k === 'total' ? { ...c, suma: false, pdf: false } : c),
          { h: 'NC / anticipos aplicados', k: '_creditos', tipo: 'dinero', pdf: false }, { h: 'Saldo', k: '_saldo', tipo: 'dinero', suma: true }]),
        { h: 'Notas', k: 'notas', pdf: false, ancho: 24 }];
      const fila = f => ({ ...f, total: valorDoc(f), _doc: f.tipoDoc || 'Factura', _saldo: saldo(f), _creditos: creditosDe(f) || '',
        _pago: f.fechaPago || f.pagoRef || estado(f).txt, _estado: estado(f).txt, _dias: estado(f).d ?? '',
        _conceptosRet: (f.retenciones || []).map(r => conceptoRet(r.concepto) ? `${nombreRet(r)} ${pctTxt(r.tarifa)} sobre ${pesos(r.base)}` : nombreRet(r)).join('; ') });
      return { ...base, titulo: hist ? 'Histórico de facturas' : 'Facturas pendientes por pagar', archivo: hist ? 'historico' : 'pendientes', columnas,
        empresas: porEmpresa(ordenar(filtradas())).map(([nombre, fs]) => ({ nombre, n: fs.length, filas: hist ? conSubtotales(fs) : fs.map(fila) })) };
      // Histórico: facturas agrupadas por proveedor (por nombre) y una fila de subtotal después de cada uno
      function conSubtotales(fs) {
        const g = new Map();
        fs.forEach(f => { const p = limpio(f.proveedor); if (!g.has(p)) g.set(p, []); g.get(p).push(f); });
        return [...g].sort((a, b) => a[0].localeCompare(b[0], 'es')).flatMap(([p, l]) => [...l.map(fila), {
          _tipo: 'subtotal', proveedor: `Subtotal ${p}`, nit: l.find(f => f.nit)?.nit || '', numero: `${l.length} fact.`,
          ...Object.fromEntries(['bruto', 'iva', 'reteiva', 'retefuente'].map(k => [k, red(l.reduce((a, f) => a + (+f[k] || 0), 0))])),
          total: red(l.reduce((a, f) => a + valorDoc(f), 0)),
        }]);
      }
    }
    if (tab === 'pendientes' && agrupar) {
      // Igual que la pantalla: por empresa, subtotal de cada proveedor seguido de sus facturas
      const columnas = [{ h: 'Proveedor', k: 'proveedor', ancho: 34 }, { h: 'NIT', k: 'nit', ancho: 12 }, { h: 'No factura', k: 'numero', ancho: 12 },
        { h: 'Recepción', k: 'fechaRecepcion', tipo: 'fecha' }, { h: 'Vencimiento', k: 'vencimiento', tipo: 'fecha' },
        { h: 'Estado', k: '_estado', ancho: 18 }, { h: 'Centro', k: 'centro', pdf: false },
        { h: 'Saldo', k: '_saldo', tipo: 'dinero', suma: true }, { h: '% participación', k: '_pct', tipo: 'pct' }];
      const empresas = porEmpresa(filtradas().filter(f => !pagada(f))).map(([nombre, fs]) => {
        const tEmp = fs.reduce((a, f) => a + saldo(f), 0);
        const provs = new Map();
        fs.forEach(f => { const p = limpio(f.proveedor); if (!provs.has(p)) provs.set(p, []); provs.get(p).push(f); });
        const filas = [];
        [...provs].map(([p, l]) => [p, l, l.reduce((a, f) => a + saldo(f), 0)]).sort((a, b) => b[2] - a[2]).forEach(([p, l, tProv]) => {
          filas.push({ _tipo: 'subtotal', proveedor: p, nit: l.find(f => f.nit)?.nit || 'Sin NIT', numero: `${l.length} doc.`, _saldo: tProv, _pct: tEmp ? tProv / tEmp : '' });
          l.sort((a, b) => (a.vencimiento || '').localeCompare(b.vencimiento || '')).forEach(f =>
            filas.push({ ...f, proveedor: '', nit: '', numero: (f.numero || '') + (ABREV_TIPO[f.tipoDoc] ? ' (' + ABREV_TIPO[f.tipoDoc] + ')' : ''), _estado: estado(f).txt, _saldo: saldo(f), _pct: tProv ? saldo(f) / tProv : '' }));
        });
        return { nombre, n: fs.length, filas };
      });
      return { ...base, titulo: 'Reporte de cuentas por pagar', archivo: 'reporte', columnas, empresas };
    }
    // Proveedores: por empresa, cada proveedor con sus facturas y saldo pendiente con esa empresa
    const txt = norm($('#fTexto').value);
    const columnas = [{ h: 'Proveedor', k: 'proveedor', ancho: 40 }, { h: 'NIT', k: 'nit', ancho: 14 },
      { h: 'Le factura a', k: 'empresas', ancho: 44 },
      { h: 'Facturas', k: 'n', tipo: 'num' }, { h: 'Pendientes', k: 'pend', tipo: 'num' },
      { h: 'Por pagar', k: 'porPagar', tipo: 'dinero', suma: true }, { h: 'Última factura', k: 'ultima', tipo: 'fecha' }];
    const emp = $('#fEmpresa').value;
    // A qué empresas le factura cada proveedor (todas sus facturas, sin importar el filtro)
    const aQuien = new Map();
    facturas.forEach(f => { const p = limpio(f.proveedor), e = nombreEmpresa(f); if (!aQuien.has(p)) aQuien.set(p, new Map()); aQuien.get(p).set(e, (aQuien.get(p).get(e) || 0) + 1); });
    const textoEmpresas = p => [...(aQuien.get(p) || [])].sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([e, n]) => `${e} (${n})`).join(', ');
    const empresas = porEmpresa(emp ? facturas.filter(f => nombreEmpresa(f) === emp) : facturas).map(([nombre, fs]) => {
      const provs = new Map();
      fs.forEach(f => { const p = limpio(f.proveedor); if (!provs.has(p)) provs.set(p, []); provs.get(p).push(f); });
      const filas = [...provs].map(([p, l]) => {
        const pend = l.filter(f => !pagada(f));
        return { proveedor: p, nit: [...new Set(l.map(f => f.nit).filter(Boolean))].join(', ') || 'Sin NIT', empresas: textoEmpresas(p), n: l.length, pend: pend.length,
          porPagar: pend.reduce((a, f) => a + saldo(f), 0), ultima: l.map(f => f.fecha || '').sort().pop() };
      }).filter(p => !txt || norm(`${p.proveedor} ${p.nit}`).includes(txt))
        .sort((a, b) => b.porPagar - a.porPagar || a.proveedor.localeCompare(b.proveedor, 'es'));
      return { nombre, n: filas.length, filas };
    }).filter(e => e.filas.length);
    return { ...base, unidad: 'proveedores', titulo: 'Proveedores', archivo: 'proveedores', columnas, empresas };
  }

  function exportar(formato) {
    const d = datosExportacion();
    if (!d.empresas.length) { toast('No hay datos para exportar con estos filtros'); return; }
    try {
      if (formato === 'pdf') Exportar.pdf(d); else Exportar.excel(d);
      toast(`${formato === 'pdf' ? 'PDF' : 'Excel'} generado: ${d.empresas.length} ${d.empresas.length === 1 ? 'empresa' : 'empresas'}`);
    } catch (err) { alert('No se pudo exportar: ' + err.message); }
  }
  $('#btnExpXls').addEventListener('click', () => exportar('xlsx'));
  $('#btnExpPdf').addEventListener('click', () => exportar('pdf'));

  // ---------- menú, pestañas, filtros ----------
  $('#btnMas').addEventListener('click', e => { e.stopPropagation(); $('#menuMas').hidden = !$('#menuMas').hidden; });
  document.addEventListener('click', e => { if (!e.target.closest('.menu')) $('#menuMas').hidden = true; });
  $('#menuMas').addEventListener('click', async e => {
    const acc = e.target.dataset.acc;
    if (!acc) return;
    $('#menuMas').hidden = true;
    if (acc === 'empresas') abrirEmpresas();
    if (acc === 'borrar') {
      const r = prompt(`Se borrarán ${facturas.length} facturas y todos los adjuntos de este navegador.\nDescargue antes una copia de seguridad.\n\nEscriba BORRAR para confirmar:`);
      if (r === 'BORRAR') { await DB.reemplazarTodo({ facturas: [], archivos: [], config: [] }); await cargar(); toast('Datos borrados'); }
    }
  });

  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    tab = b.dataset.tab; limite = 300; render();
  });
  const FILTROS = ['#fTexto', '#fEmpresa', '#fCentro', '#fEstado', '#fDesde', '#fHasta', '#fRecDesde', '#fRecHasta', '#fVenDesde', '#fVenHasta'];
  for (const id of FILTROS) $(id).addEventListener('input', () => { limite = 300; render(); });
  function pintarBotonAgrupar() {
    const b = $('#btnAgrupar');
    b.setAttribute('aria-pressed', agrupar);
    b.classList.toggle('primary', agrupar);
    b.textContent = agrupar ? '✓ Agrupado por proveedor' : 'Agrupar por proveedor';
    b.title = agrupar ? 'Volver a la lista por documento' : 'Muestra los pendientes agrupados por empresa y proveedor, con subtotales y % de participación';
  }
  $('#btnAgrupar').addEventListener('click', () => {
    agrupar = !agrupar;
    try { localStorage.setItem('cxp-agrupar', agrupar ? '1' : '0'); } catch { /* sin almacenamiento */ }
    pintarBotonAgrupar(); limite = 300; render();
  });
  pintarBotonAgrupar();

  $('#btnLimpiar').addEventListener('click', () => {
    for (const id of FILTROS) $(id).value = '';
    render();
  });

  // ---------- inicio ----------
  (async () => {
    await DB.abrir();
    DB.persistir();
    await cargar();
  })().catch(err => { document.body.insertAdjacentHTML('afterbegin', `<div class="msg bad">Error al iniciar: ${esc(err.message)}</div>`); });
})();
