// Exportación a Excel (SheetJS) y PDF (jsPDF + AutoTable), separada por empresa.
// Recibe los datos ya preparados por app.js:
//   { titulo, filtros, archivo, unidad, columnas: [{ h, k, tipo, pdf, ancho, suma }],
//     empresas: [{ nombre, filas: [{...}], n }] }
// tipo: 'fecha' (aaaa-mm-dd), 'dinero', 'pct' (0..1), 'num' o texto. pdf:false = solo en Excel.
// Una fila con _tipo 'subtotal' se resalta (subtotales por proveedor del reporte).
const Exportar = (() => {
  const pad = n => String(n).padStart(2, '0');
  const ahora = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`; };
  const generado = () => new Date().toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' });
  const esFecha = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const fechaTxt = v => esFecha(v) ? v.split('-').reverse().join('/') : (v ?? '');
  const serial = v => { const [y, m, d] = v.split('-').map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5; };
  const pesos = v => (v === '' || v == null) ? '' : '$ ' + Math.round(+v || 0).toLocaleString('es-CO');
  const pct = v => (v === '' || v == null) ? '' : (v * 100).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + ' %';

  const totalesDe = (d, e) => {
    const t = {};
    d.columnas.filter(c => c.suma).forEach(c => {
      t[c.k] = e.filas.filter(f => f._tipo !== 'subtotal').reduce((a, f) => a + (+f[c.k] || 0), 0);
    });
    return t;
  };
  const colPrincipal = d => d.columnas.find(c => c.suma);

  // ---------- Excel: hoja Resumen + una hoja por empresa ----------
  function excel(d) {
    const wb = XLSX.utils.book_new();
    const usados = new Set();
    const nombreHoja = s => {
      let base = String(s).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Hoja', n = base, i = 2;
      while (usados.has(n.toLowerCase())) n = `${base} ${i++}`;
      usados.add(n.toLowerCase());
      return n;
    };
    const principal = colPrincipal(d);

    // Resumen
    const res = [[`${d.titulo} — resumen por empresa`], [d.filtros], [`Generado: ${generado()}`], [],
      ['Empresa', d.unidad[0].toUpperCase() + d.unidad.slice(1), principal ? principal.h : '']];
    let gran = 0, granN = 0;
    d.empresas.forEach(e => { const t = principal ? totalesDe(d, e)[principal.k] : ''; gran += +t || 0; granN += e.n; res.push([e.nombre, e.n, t]); });
    res.push(['Total', granN, principal ? gran : '']);
    const wsR = XLSX.utils.aoa_to_sheet(res);
    for (let r = 5; r < res.length; r++) { const c = wsR['C' + (r + 1)]; if (c && c.t === 'n') c.z = '#,##0'; }
    wsR['!cols'] = [{ wch: 34 }, { wch: 12 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, wsR, nombreHoja('Resumen'));

    // Una hoja por empresa
    for (const e of d.empresas) {
      const aoa = [[`${d.titulo} — ${e.nombre}`], [d.filtros], [`Generado: ${generado()}`], [], d.columnas.map(c => c.h)];
      const inicio = aoa.length;
      for (const f of e.filas) {
        aoa.push(d.columnas.map(c => {
          const v = f[c.k];
          if (c.tipo === 'fecha' && esFecha(v)) return serial(v);
          if ((c.tipo === 'dinero' || c.tipo === 'num' || c.tipo === 'pct') && v !== '' && v != null) return +v;
          return v ?? '';
        }));
      }
      const t = totalesDe(d, e);
      aoa.push(d.columnas.map((c, i) => i === 0 ? `Total ${e.nombre} (${e.n} ${d.unidad})` : c.suma ? t[c.k] : ''));
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      for (let r = inicio; r < aoa.length; r++) {
        d.columnas.forEach((c, i) => {
          const cel = ws[XLSX.utils.encode_cell({ r, c: i })];
          if (!cel || cel.t !== 'n') return;
          if (c.tipo === 'fecha') cel.z = 'dd/mm/yyyy';
          else if (c.tipo === 'dinero') cel.z = '#,##0';
          else if (c.tipo === 'pct') cel.z = '0.0%';
        });
      }
      ws['!cols'] = d.columnas.map(c => ({ wch: c.ancho || (c.tipo === 'fecha' ? 12 : c.tipo === 'dinero' ? 15 : 14) }));
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: inicio - 1, c: 0 }, e: { r: aoa.length - 2, c: d.columnas.length - 1 } }) };
      XLSX.utils.book_append_sheet(wb, ws, nombreHoja(e.nombre));
    }
    XLSX.writeFile(wb, `${d.archivo}_por-empresa_${ahora()}.xlsx`);
  }

  // ---------- PDF: resumen + una sección (página nueva) por empresa ----------
  const TINTA = [28, 36, 48], GRIS = [102, 112, 133], AZUL = [31, 111, 235], FONDO = [240, 242, 245];

  function pdf(d) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
    const W = doc.internal.pageSize.getWidth(), M = 36;
    const cols = d.columnas.filter(c => c.pdf !== false);
    const principal = colPrincipal(d);
    const alinear = c => (c.tipo === 'dinero' || c.tipo === 'num' || c.tipo === 'pct') ? 'right' : 'left';
    const celda = (c, v) => c.tipo === 'fecha' ? fechaTxt(v) : c.tipo === 'dinero' ? pesos(v) : c.tipo === 'pct' ? pct(v)
      : c.tipo === 'num' ? (v === '' || v == null ? '' : (+v).toLocaleString('es-CO')) : String(v ?? '');
    const estilosCol = Object.fromEntries(cols.map((c, i) => [i, { halign: alinear(c) }]));
    const encabezado = (titulo, sub) => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...TINTA);
      doc.text(titulo, M, 44);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GRIS);
      doc.text(doc.splitTextToSize(sub, W - 2 * M), M, 60);
    };
    const tabla = (head, body, startY, extra = {}) => doc.autoTable({
      head: [head], body, startY, margin: { left: M, right: M, top: 50, bottom: 40 },
      styles: { fontSize: 8, cellPadding: 3.5, textColor: TINTA, lineColor: [223, 227, 232], lineWidth: 0.4, overflow: 'linebreak' },
      headStyles: { fillColor: FONDO, textColor: GRIS, fontStyle: 'bold' },
      ...extra,
    });

    // Página 1: resumen
    encabezado(`${d.titulo} — resumen por empresa`, `${d.filtros}  ·  Generado: ${generado()}`);
    let gran = 0, granN = 0;
    const filasRes = d.empresas.map(e => {
      const t = principal ? totalesDe(d, e)[principal.k] : 0; gran += t; granN += e.n;
      return [e.nombre, e.n.toLocaleString('es-CO'), principal ? pesos(t) : ''];
    });
    tabla(['Empresa', d.unidad[0].toUpperCase() + d.unidad.slice(1), principal ? principal.h : ''], filasRes, 78, {
      foot: [['Total', granN.toLocaleString('es-CO'), principal ? pesos(gran) : '']],
      footStyles: { fillColor: FONDO, textColor: TINTA, fontStyle: 'bold' },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
      didParseCell: data => { if (data.column.index > 0) data.cell.styles.halign = 'right'; },
      tableWidth: 420,
    });

    // Una sección por empresa
    for (const e of d.empresas) {
      doc.addPage();
      const t = totalesDe(d, e);
      encabezado(`${d.titulo} — ${e.nombre}`,
        `${e.n.toLocaleString('es-CO')} ${d.unidad}${principal ? ' · ' + principal.h + ': ' + pesos(t[principal.k]) : ''}  ·  ${d.filtros}`);
      const body = e.filas.map(f => cols.map(c => celda(c, f[c.k])));
      const foot = [cols.map((c, i) => i === 0 ? `Total ${e.nombre}` : c.suma ? pesos(t[c.k]) : '')];
      tabla(cols.map(c => c.h), body, 78, {
        foot, showFoot: 'lastPage',
        footStyles: { fillColor: FONDO, textColor: TINTA, fontStyle: 'bold' },
        columnStyles: estilosCol,
        didParseCell: data => {
          const c = cols[data.column.index];
          if (data.section === 'head' || data.section === 'foot') data.cell.styles.halign = alinear(c);
          if (data.section === 'body' && e.filas[data.row.index]?._tipo === 'subtotal') {
            data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = [230, 239, 253];
          }
        },
      });
    }

    // Pie de página en todas las hojas
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...GRIS);
      const H = doc.internal.pageSize.getHeight();
      doc.text(`Facturas por cancelar · ${d.titulo}`, M, H - 20);
      doc.text(`Página ${i} de ${n}`, W - M, H - 20, { align: 'right' });
      doc.setDrawColor(...AZUL); doc.setLineWidth(1.5); doc.line(M, 24, W - M, 24);
    }
    doc.save(`${d.archivo}_por-empresa_${ahora()}.pdf`);
  }

  return { excel, pdf };
})();
