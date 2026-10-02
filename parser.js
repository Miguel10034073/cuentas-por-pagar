// Lectura de facturas electrónicas DIAN (UBL 2.1).
// Acepta:
//   - AttachedDocument (contenedor DIAN con la Invoice/CreditNote/DebitNote y la
//     ApplicationResponse embebidas como CDATA)
//   - Invoice, CreditNote o DebitNote "sueltas" (sin contenedor)
// Todas las búsquedas usan el nombre local del nodo, así que no dependen de los
// prefijos de namespace (cbc:, cac:, etc.).
const Parser = (() => {

  const TIPOS = {
    Invoice:    { tipo: 'Factura',      linea: 'InvoiceLine',    cantidad: 'InvoicedQuantity', total: 'LegalMonetaryTotal' },
    CreditNote: { tipo: 'Nota crédito', linea: 'CreditNoteLine', cantidad: 'CreditedQuantity', total: 'LegalMonetaryTotal' },
    DebitNote:  { tipo: 'Nota débito',  linea: 'DebitNoteLine',  cantidad: 'DebitedQuantity',  total: 'RequestedMonetaryTotal' },
  };

  // Catálogo DIAN de tributos (TaxScheme/ID) para cuando el XML no trae el nombre.
  const TRIBUTOS = {
    '01': 'IVA', '02': 'IC', '03': 'ICA', '04': 'INC', '05': 'ReteIVA', '06': 'ReteRenta',
    '07': 'ReteICA', '08': 'IC Porcentual', '20': 'FtoHorticultura', '21': 'Timbre',
    '22': 'INC Bolsas', '23': 'INCarbono', '24': 'INCombustibles', '25': 'Sobretasa Combustibles',
    '26': 'Sordicom', '30': 'IC Datos', '32': 'ICL', '33': 'INPP', '34': 'IBUA', '35': 'ICUI', 'ZZ': 'Otro',
  };

  const FORMA_PAGO = { '1': 'Contado', '2': 'Crédito' };
  const MEDIO_PAGO = {
    '1': 'Instrumento no definido', '10': 'Efectivo', '20': 'Cheque', '42': 'Consignación bancaria',
    '45': 'Transferencia crédito bancaria', '46': 'Transferencia débito interbancaria',
    '47': 'Transferencia débito bancaria', '48': 'Tarjeta crédito', '49': 'Tarjeta débito',
    '71': 'Bonos', '72': 'Vales', 'ZZZ': 'Otro',
  };

  // ---------- utilidades DOM ----------
  const hijos = (el, nombre) => el ? [...el.children].filter(c => c.localName === nombre) : [];
  const hijo = (el, nombre) => hijos(el, nombre)[0] || null;
  // Ruta de hijos directos: ruta(el, 'A/B/C')
  const ruta = (el, r) => r.split('/').reduce((n, p) => n && hijo(n, p), el);
  // Primer descendiente (cualquier nivel) con ese nombre local
  const desc = (el, nombre) => el ? el.getElementsByTagNameNS('*', nombre)[0] || null : null;
  const txt = n => (n && n.textContent || '').trim();
  const num = n => { const v = parseFloat(txt(n)); return isFinite(v) ? v : 0; };
  const fecha = s => /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
  const red = v => Math.round(v * 100) / 100;

  // ---------- lectura con la codificación correcta ----------
  function decodificar(buffer) {
    const cabecera = new TextDecoder('latin1').decode(buffer.slice(0, 200));
    const m = cabecera.match(/encoding\s*=\s*["']([\w-]+)["']/i);
    let enc = m ? m[1].toLowerCase() : 'utf-8';
    try { return new TextDecoder(enc).decode(buffer); }
    catch { return new TextDecoder('utf-8').decode(buffer); }
  }

  function parsearXML(texto, contexto) {
    const doc = new DOMParser().parseFromString(texto.replace(/^﻿/, ''), 'application/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) {
      const detalle = txt(err)
        .replace(/^This page contains the following errors:/i, '')
        .split(/Below is a rendering/i)[0].split('\n')[0].trim().slice(0, 160);
      throw new Error(`XML mal formado (${contexto}): ${detalle}`);
    }
    return doc;
  }

  // ---------- impuestos ----------
  function nombreTributo(subtotal) {
    const esquema = ruta(subtotal, 'TaxCategory/TaxScheme');
    const id = txt(hijo(esquema, 'ID'));
    const nombre = txt(hijo(esquema, 'Name')) || TRIBUTOS[id] || id || 'Impuesto';
    return { id, nombre, esIva: id === '01' || nombre.toUpperCase() === 'IVA' };
  }

  // Suma los TaxSubtotal de los contenedores dados (TaxTotal o WithholdingTaxTotal),
  // separando IVA del resto y agrupando el resto por tributo + tarifa.
  function resumirImpuestos(contenedores) {
    let iva = 0, ivaPct = 0, otros = 0;
    const grupos = new Map();
    for (const tt of contenedores) {
      for (const st of hijos(tt, 'TaxSubtotal')) {
        const t = nombreTributo(st);
        const monto = num(hijo(st, 'TaxAmount'));
        const pct = num(ruta(st, 'TaxCategory/Percent')) || num(hijo(st, 'Percent'));
        if (t.esIva) {
          iva += monto;
          if (pct > ivaPct) ivaPct = pct;
        } else {
          otros += monto;
          const k = pct ? `${t.nombre} ${fmtPct(pct)}%` : t.nombre;
          grupos.set(k, (grupos.get(k) || 0) + monto);
        }
      }
    }
    const detalle = [...grupos].filter(([, v]) => Math.abs(v) >= 0.005).map(([k, v]) => `${k}: ${fmtNum(v)}`).join('; ');
    return { iva: red(iva), ivaPct, otros: red(otros), detalle };
  }

  const fmtPct = v => String(+v.toFixed(2)).replace('.', ',');
  const fmtNum = v => v.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ---------- descuentos y cargos (cac:AllowanceCharge) ----------
  // ChargeIndicator=false -> descuento; true -> cargo (fletes, recargos...).
  function descuentosYCargos(nodos) {
    let descuento = 0, cargo = 0;
    const motivos = new Set();
    for (const ac of nodos) {
      const monto = num(hijo(ac, 'Amount'));
      if (!monto) continue;
      const esCargo = txt(hijo(ac, 'ChargeIndicator')).toLowerCase() === 'true';
      if (esCargo) cargo += monto; else descuento += monto;
      const motivo = txt(hijo(ac, 'AllowanceChargeReason'));
      if (motivo) motivos.add(esCargo ? `Cargo: ${motivo}` : motivo);
    }
    return { descuento: red(descuento), cargo: red(cargo), motivos: [...motivos].join('; ') };
  }

  // ---------- partes (emisor / adquiriente) ----------
  function parte(nodoParte) {
    const p = hijo(nodoParte, 'Party') || nodoParte;
    const pts = desc(p, 'PartyTaxScheme');
    const ple = desc(p, 'PartyLegalEntity');
    const nit = txt(hijo(pts, 'CompanyID')) || txt(hijo(ple, 'CompanyID')) || txt(desc(p, 'CompanyID'));
    const nombre = txt(hijo(pts, 'RegistrationName')) || txt(hijo(ple, 'RegistrationName')) || txt(desc(p, 'Name'));
    const ciudad = txt(desc(desc(p, 'PhysicalLocation'), 'CityName')) || txt(desc(desc(pts, 'RegistrationAddress'), 'CityName'));
    const correo = txt(desc(desc(p, 'Contact'), 'ElectronicMail'));
    // Responsabilidades fiscales del RUT (O-13 gran contribuyente, O-15 autorretenedor, O-47 SIMPLE…)
    const resp = [...new Set(txt(hijo(pts, 'TaxLevelCode') || desc(p, 'TaxLevelCode')).split(/[;,\s]+/).filter(Boolean))];
    const tipo = txt(hijo(nodoParte, 'AdditionalAccountID'));   // 1 = jurídica, 2 = natural
    return { nit, nombre, ciudad, correo, resp, persona: tipo === '1' ? 'J' : tipo === '2' ? 'N' : '' };
  }

  // ---------- documento principal ----------
  // Devuelve { factura, lineas, avisos } o lanza Error.
  function procesar(texto, archivo) {
    const externo = parsearXML(texto, 'archivo');
    let raiz = externo.documentElement;
    let validacion = { estado: '', obs: '', fecha: '' };

    if (raiz.localName === 'AttachedDocument') {
      const descr = ruta(raiz, 'Attachment/ExternalReference/Description');
      if (!descr) throw new Error('No se encontró el documento embebido en el AttachedDocument (formato inesperado)');
      raiz = parsearXML(txt(descr), 'documento interno').documentElement;

      // Validación DIAN
      const res = desc(externo.documentElement, 'ResultOfVerification');
      const cod = txt(hijo(res, 'ValidationResultCode'));
      validacion.estado = /^0*2$/.test(cod) ? 'Validado DIAN' : cod ? `Código ${cod}` : 'Sin información';
      validacion.fecha = fecha(txt(hijo(res, 'ValidationDate')));

      // ApplicationResponse embebida (observación de la DIAN)
      const ref = desc(externo.documentElement, 'ParentDocumentLineReference');
      const rdesc = ref && ruta(hijo(ref, 'DocumentReference'), 'Attachment/ExternalReference/Description');
      if (rdesc) {
        try {
          const resp = parsearXML(txt(rdesc), 'respuesta DIAN');
          const dr = desc(resp.documentElement, 'DocumentResponse');
          validacion.obs = txt(ruta(dr, 'Response/Description'));
        } catch { /* la respuesta es opcional */ }
      }
    } else {
      validacion.estado = 'Sin información';
    }

    const def = TIPOS[raiz.localName];
    if (!def) {
      // ApplicationResponse (eventos de aceptación/acuse), etc.: no son facturas, se omiten sin error.
      const e = new Error(`No es factura ni nota (<${raiz.localName}>)`);
      e.omitir = true;
      throw e;
    }

    const emisor = parte(hijo(raiz, 'AccountingSupplierParty'));
    const adq = parte(hijo(raiz, 'AccountingCustomerParty'));
    const numero = txt(hijo(raiz, 'ID'));
    if (!numero) throw new Error('El documento no tiene número (cbc:ID)');
    if (!emisor.nit) throw new Error('El documento no tiene NIT del emisor');

    const totales = hijo(raiz, def.total) || hijo(raiz, 'LegalMonetaryTotal');
    const imp = resumirImpuestos(hijos(raiz, 'TaxTotal'));
    const ret = resumirImpuestos(hijos(raiz, 'WithholdingTaxTotal'));
    // Retenciones separadas por tipo (catálogo DIAN: 05 ReteIVA, 06 ReteRenta/ReteFuente, 07 ReteICA)
    const retTipo = { reteiva: 0, retefuente: 0, reteica: 0, otras: 0 };
    for (const tt of hijos(raiz, 'WithholdingTaxTotal')) {
      for (const st of hijos(tt, 'TaxSubtotal')) {
        const id = nombreTributo(st).id, m = num(hijo(st, 'TaxAmount'));
        if (id === '05') retTipo.reteiva += m; else if (id === '06') retTipo.retefuente += m;
        else if (id === '07') retTipo.reteica += m; else retTipo.otras += m;
      }
    }
    Object.keys(retTipo).forEach(k => { retTipo[k] = red(retTipo[k]); });
    const pago = hijo(raiz, 'PaymentMeans');
    const idForma = txt(hijo(pago, 'ID'));
    const codMedio = txt(hijo(pago, 'PaymentMeansCode'));
    const clave = `${emisor.nit.toUpperCase()}|${numero.toUpperCase()}`;

    // Descuentos y cargos a nivel de factura (hijos directos del documento).
    // Los de cada línea se suman más abajo.
    const global = descuentosYCargos(hijos(raiz, 'AllowanceCharge'));
    const descGlobal = num(hijo(totales, 'AllowanceTotalAmount')) || global.descuento;
    const cargoGlobal = num(hijo(totales, 'ChargeTotalAmount')) || global.cargo;

    const factura = {
      clave, archivo,
      tipo: def.tipo,
      numero,
      cufe: txt(hijo(raiz, 'UUID')),
      fecha: fecha(txt(hijo(raiz, 'IssueDate'))),
      hora: txt(hijo(raiz, 'IssueTime')),
      emisorNit: emisor.nit, emisorNombre: emisor.nombre, emisorCiudad: emisor.ciudad, emisorCorreo: emisor.correo,
      emisorResp: emisor.resp, emisorPersona: emisor.persona,
      adqNit: adq.nit, adqNombre: adq.nombre, adqCiudad: adq.ciudad, adqCorreo: adq.correo, adqResp: adq.resp,
      moneda: txt(hijo(raiz, 'DocumentCurrencyCode')),
      subtotal: num(hijo(totales, 'LineExtensionAmount')),   // ya neto de descuentos por línea
      // bruto, descuentos, descuentosLinea, cargos y diferencia se completan después de leer las líneas
      descuentoGlobal: red(descGlobal),
      cargoGlobal: red(cargoGlobal),
      motivosDescuento: global.motivos,
      anticipos: num(hijo(totales, 'PrepaidAmount')),
      redondeo: num(hijo(totales, 'PayableRoundingAmount')),
      base: num(hijo(totales, 'TaxExclusiveAmount')),
      iva: imp.iva,
      otros: imp.otros,
      otrosDetalle: imp.detalle,              // corrección: antes se calculaba y no se guardaba
      totalImpuestos: red(imp.iva + imp.otros),
      retenciones: red(ret.iva + ret.otros),  // nuevo: ReteFuente / ReteIVA / ReteICA
      retencionesDetalle: [ret.iva ? `IVA retenido: ${fmtNum(ret.iva)}` : '', ret.detalle].filter(Boolean).join('; '),
      retencionesTipo: retTipo,
      total: num(hijo(totales, 'PayableAmount')),
      formaPago: FORMA_PAGO[idForma] || (idForma ? `Código ${idForma}` : 'Sin información'),
      medioPago: MEDIO_PAGO[codMedio] || (codMedio ? `Código ${codMedio}` : 'Sin información'),
      vencimiento: fecha(txt(hijo(pago, 'PaymentDueDate')) || txt(hijo(raiz, 'DueDate'))),
      numLineas: num(hijo(raiz, 'LineCountNumeric')),
      // Notas crédito/débito: factura que afectan y motivo (cac:BillingReference / cac:DiscrepancyResponse)
      facturaRef: txt(ruta(raiz, 'BillingReference/InvoiceDocumentReference/ID')),
      facturaRefCufe: txt(ruta(raiz, 'BillingReference/InvoiceDocumentReference/UUID')),
      motivoNota: txt(ruta(raiz, 'DiscrepancyResponse/Description')),
      estadoDian: validacion.estado,
      obsDian: validacion.obs,
      fechaValidacion: validacion.fecha,
      importado: new Date().toISOString(),
    };

    // Líneas de producto. Un error en una línea no detiene la factura, pero se reporta.
    const lineas = [], avisos = [];
    hijos(raiz, def.linea).forEach((ln, i) => {
      try {
        const li = resumirImpuestos(hijos(ln, 'TaxTotal'));
        const item = hijo(ln, 'Item');
        const cantNodo = hijo(ln, def.cantidad);
        const valor = num(hijo(ln, 'LineExtensionAmount'));
        const totalImp = red(li.iva + li.otros);
        // En UBL el LineExtensionAmount ya viene NETO (después del descuento de la línea).
        // El valor bruto se reconstruye desde el propio XML para que siempre cuadre,
        // sin depender de cómo cada proveedor llena Price/BaseQuantity.
        const dc = descuentosYCargos(hijos(ln, 'AllowanceCharge'));
        const bruto = red(valor + dc.descuento - dc.cargo);
        lineas.push({
          clave, archivo, numero, fecha: factura.fecha, tipo: factura.tipo,
          emisorNit: emisor.nit, emisorNombre: emisor.nombre,   // corrección: antes no se guardaba el emisor
          item: txt(hijo(ln, 'ID')) || String(i + 1),
          codigo: txt(ruta(item, 'SellersItemIdentification/ID')) || txt(ruta(item, 'StandardItemIdentification/ID')),
          descripcion: txt(hijo(item, 'Description')),
          marca: txt(hijo(item, 'BrandName')),
          cantidad: num(cantNodo),
          unidad: cantNodo ? cantNodo.getAttribute('unitCode') || '' : '',
          precio: num(ruta(ln, 'Price/PriceAmount')),
          bruto,
          descuento: dc.descuento,
          descuentoPct: bruto && dc.descuento ? red(dc.descuento / bruto * 100) : 0,
          motivoDescuento: dc.motivos,
          cargo: dc.cargo,
          subtotal: valor,
          ivaPct: li.ivaPct,
          iva: li.iva,
          otrosDetalle: li.detalle,
          otros: li.otros,
          totalImpuestos: totalImp,
          total: red(valor + totalImp),
        });
      } catch (e) {
        avisos.push(`Línea ${i + 1}: ${e.message}`);
      }
    });
    if (!factura.numLineas) factura.numLineas = lineas.length;

    // Consolidado de descuentos: por línea + global
    const descLineas = red(lineas.reduce((a, l) => a + l.descuento, 0));
    const cargoLineas = red(lineas.reduce((a, l) => a + l.cargo, 0));
    factura.descuentosLinea = descLineas;
    factura.descuentos = red(descLineas + factura.descuentoGlobal);
    factura.cargos = red(cargoLineas + factura.cargoGlobal);
    factura.bruto = red(factura.subtotal + descLineas - cargoLineas);
    factura.motivosDescuento = [...new Set([factura.motivosDescuento, ...lineas.map(l => l.motivoDescuento)]
      .join('; ').split('; ').filter(Boolean))].join('; ');
    // Control de cuadre: lo que el XML dice que se paga vs. lo que resulta de sus componentes
    factura.diferencia = red(factura.total - (factura.subtotal - factura.descuentoGlobal + factura.cargoGlobal
      + factura.iva + factura.otros - factura.anticipos + factura.redondeo));

    return { factura, lineas, avisos };
  }

  return { procesar, decodificar };
})();
