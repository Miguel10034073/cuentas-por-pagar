# Facturas por cancelar

Página web local para llevar las **cuentas por pagar de Inversiones Mindala SAS y Dora Helena Mejía Alzate**: facturas de proveedores (desde el XML de la DIAN o manuales), vencimientos, retenciones, pagos, anticipos y notas crédito, con sus PDF y comprobantes adjuntos.

No necesita internet ni instalar nada: se abre con doble clic en `index.html` en Chrome o Edge. Los datos se guardan en el navegador del computador y en la carpeta de copias; no se envían a ningún lado.

## Organización

```
003. Cuentas por pagar Inv Mindala - Dora Mejia\
    Facturas por cancelar\       ← este repositorio: la página y lo que necesita para usarse
        index.html
        styles.css
        js\
        lib\
        README.md
        .gitignore
    Copias de seguridad\         ← copias con los datos y adjuntos. NO va al repositorio
```

## Uso

- **Importar XML (+ PDF)**: seleccione los XML de la DIAN (y, si quiere, los PDF: se asocian por el número de factura del nombre del archivo). También puede arrastrarlos a la página. **Nueva manual** registra un documento sin XML.
- **Pendientes**: lo que falta por pagar, con filtros por empresa, centro, estado y fechas, y la opción **Agrupar por proveedor**. Seleccione facturas y use **Marcar como pagadas…** para registrar el pago o un anticipo.
- **Histórico**: lo pagado, con la fecha y la empresa que pagó.
- **Proveedores**: NIT, responsabilidades y ficha de cada proveedor.
- **Excel / PDF** exportan lo que se ve en la pestaña, separado por empresa.

La barra azul de arriba tiene Importar, Nueva manual, **Guardar copia**, **Deshacer / Rehacer**, el estado de la copia y el menú **⋯** (carpeta de copias, guardar copia en otro lugar, restaurar copia, empresas compradoras y borrar todos los datos).

## Copias de seguridad y Deshacer

- **Copia automática**: la primera vez, clic en **Sin carpeta de copias** (arriba a la derecha) o en **⋯ → Carpeta de copias de seguridad…**, y elija `003. Cuentas por pagar Inv Mindala - Dora Mejia\Copias de seguridad`. Desde entonces, unos segundos después de cada cambio, se escribe la copia del día `Facturas por cancelar AAAA-MM-DD.json` con todos los datos y adjuntos. Se conservan las 7 más recientes. La barra azul muestra «Copia al día» con la hora.
- **Actualizar la página (F5)**: con la carpeta elegida no se borra nada; si hay cambios sin copiar, primero se guarda la copia y luego se actualiza. Sin carpeta, la página conserva su comportamiento anterior: al recargar se borran los datos del navegador y antes ofrece descargar la copia.
- **Navegador o computador nuevo**: elija la misma carpeta de copias y los datos más recientes se cargan solos.
- **Copia más nueva desde otro computador**: si este navegador no tiene cambios sin copiar, se carga sola. Si los tiene, un aviso pregunta qué datos usar; la versión que no se elige queda guardada aparte en la carpeta.
- **Volver a una copia anterior**: **⋯ → Restaurar copia de seguridad** y elija el archivo. Antes de restaurar se ofrece guardar una copia de los datos actuales.
- **Borrar todos los datos** guarda antes una copia aparte en la carpeta (`… (antes de borrar).json`).
- **Deshacer / Rehacer**: los botones de la barra azul (o Ctrl+Z y Ctrl+Y; en Mac ⌘Z y ⌘Y) vuelven atrás o adelante cualquier cambio: registrar, editar o eliminar facturas, pagos, anticipos, adjuntos, NIT y nombres de proveedores. Un adjunto eliminado vuelve con Deshacer. Al pasar el mouse dicen qué cambio deshacen. Se guardan los últimos 30 cambios, también si se cierra la pestaña.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `index.html` | La página. |
| `styles.css` | Apariencia (mismo diseño que «Expediente laboral» y «Conciliador integral»). |
| `js/app.js` | Pantallas, formularios, pagos, copias de seguridad y Deshacer / Rehacer. |
| `js/db.js` | Almacenamiento en el navegador (IndexedDB) e historial de Deshacer. |
| `js/parser.js` | Lector de facturas electrónicas XML de la DIAN. |
| `js/retenciones.js` | Conceptos y tarifas de retención. |
| `js/export.js` | Exportación a Excel y PDF. |
| `js/proveedores-semilla.js` | NIT de proveedores conocidos para completar facturas sin NIT. |
| `lib/` | Librerías de terceros: SheetJS (Excel), jsPDF y AutoTable (PDF), JSZip (copias antiguas en .zip). |

## Privacidad

La página no envía nada a internet. Las copias traen facturas, valores y adjuntos: se guardan en `Copias de seguridad`, fuera de este repositorio, y el `.gitignore` impide subir archivos `.json`, `.zip`, `.xml`, `.pdf` o de Excel por si acaso.

`js/app.js` (empresas compradoras) y `js/proveedores-semilla.js` traen nombres y NIT de las empresas y de proveedores. Por eso conviene que el repositorio en GitHub sea **privado**.
