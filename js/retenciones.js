// Conceptos de retención en la fuente a título de renta (pagos a residentes en Colombia).
// Fuente: Tabla de Retención en la Fuente 2026 (vigente desde el 1 de julio de 2026, Decreto 572 de 2025).
// uvt = base mínima en UVT (null = aplica desde $1). tarifa en %.
// Para actualizar el año: cambie UVT y revise tarifas/bases; las facturas ya guardadas conservan lo calculado.
window.RETENCIONES_RENTA = {
  anio: 2026,
  UVT: 52374,
  // Responsabilidades tributarias (códigos del RUT que viajan en la factura electrónica).
  // noRetener: al proveedor con esta responsabilidad no se le practica retención en la fuente por renta.
  responsabilidades: [
    { cod: 'O-13', nombre: 'Gran contribuyente' },
    { cod: 'O-15', nombre: 'Autorretenedor', noRetener: true },
    { cod: 'O-23', nombre: 'Agente de retención IVA' },
    { cod: 'O-47', nombre: 'Régimen simple de tributación (SIMPLE)', noRetener: true },
    { cod: 'R-99-PN', nombre: 'No aplica – otros' },
    { cod: 'ND', nombre: 'Persona natural no declarante de renta (marca interna, no es código DIAN)' },
  ],
  // Para proveedores no declarantes se usa la variante correspondiente del concepto
  noDeclarante: { '1': '2', '5': '6', '8': '9', '14': '15', '26': '27' },
  conceptos: [
    // Honorarios y consultoría
    { cod: '1', grupo: 'Honorarios y consultoría', nombre: 'Honorarios y comisiones – persona jurídica', uvt: null, tarifa: 11 },
    { cod: '2', grupo: 'Honorarios y consultoría', nombre: 'Honorarios y comisiones – persona natural no declarante (11% si supera 3.300 UVT)', uvt: null, tarifa: 10 },
    { cod: '3', grupo: 'Honorarios y consultoría', nombre: 'Licencias o derecho de uso de software', uvt: null, tarifa: 3.5 },
    { cod: '4', grupo: 'Honorarios y consultoría', nombre: 'Desarrollo de software, páginas web y consultoría informática', uvt: null, tarifa: 3.5 },
    { cod: '5', grupo: 'Honorarios y consultoría', nombre: 'Consultoría y administración delegada – persona jurídica', uvt: null, tarifa: 11 },
    { cod: '6', grupo: 'Honorarios y consultoría', nombre: 'Consultoría y administración delegada – persona natural no declarante', uvt: null, tarifa: 10 },
    { cod: '7', grupo: 'Honorarios y consultoría', nombre: 'Consultoría de obras públicas (factor multiplicador)', uvt: null, tarifa: 2 },
    { cod: '8', grupo: 'Honorarios y consultoría', nombre: 'Consultoría en ingeniería de infraestructura – declarantes', uvt: null, tarifa: 6 },
    { cod: '9', grupo: 'Honorarios y consultoría', nombre: 'Consultoría en ingeniería de infraestructura – no declarantes', uvt: null, tarifa: 10 },
    // Compras
    { cod: '14', grupo: 'Compras', nombre: 'Compras en general – declarante', uvt: 10, tarifa: 2.5 },
    { cod: '15', grupo: 'Compras', nombre: 'Compras en general – no declarante', uvt: 10, tarifa: 3.5 },
    { cod: '16', grupo: 'Compras', nombre: 'Bienes agrícolas o pecuarios sin procesamiento industrial', uvt: 70, tarifa: 1.5 },
    { cod: '17', grupo: 'Compras', nombre: 'Café pergamino o cereza', uvt: 70, tarifa: 0.5 },
    { cod: '18', grupo: 'Compras', nombre: 'Combustibles derivados del petróleo', uvt: null, tarifa: 0.1 },
    { cod: '19', grupo: 'Compras', nombre: 'Adquisición de vehículos', uvt: null, tarifa: 1 },
    { cod: '21', grupo: 'Compras', nombre: 'Bienes raíces para vivienda – primeras 10.000 UVT', uvt: null, tarifa: 1 },
    { cod: '22', grupo: 'Compras', nombre: 'Bienes raíces para vivienda – exceso sobre 10.000 UVT (base = excedente)', uvt: null, tarifa: 2.5 },
    { cod: '23', grupo: 'Compras', nombre: 'Bienes raíces de uso diferente a vivienda', uvt: 10, tarifa: 2.5 },
    { cod: '24', grupo: 'Compras', nombre: 'Enajenación de activos fijos de persona natural', uvt: null, tarifa: 1 },
    { cod: '25', grupo: 'Compras', nombre: 'Contratos de construcción y obra material de inmuebles', uvt: 10, tarifa: 2 },
    // Servicios
    { cod: '26', grupo: 'Servicios', nombre: 'Servicios en general – persona jurídica o natural declarante', uvt: 2, tarifa: 4 },
    { cod: '27', grupo: 'Servicios', nombre: 'Servicios en general – persona natural no declarante', uvt: 2, tarifa: 6 },
    { cod: '28', grupo: 'Servicios', nombre: 'Transporte nacional de carga', uvt: 2, tarifa: 1 },
    { cod: '29', grupo: 'Servicios', nombre: 'Transporte nacional terrestre de pasajeros', uvt: 10, tarifa: 3.5 },
    { cod: '30', grupo: 'Servicios', nombre: 'Transporte nacional aéreo o marítimo de pasajeros', uvt: 2, tarifa: 1 },
    { cod: '31', grupo: 'Servicios', nombre: 'Empresas temporales de empleo (base = AIU)', uvt: 2, tarifa: 1 },
    { cod: '32', grupo: 'Servicios', nombre: 'Aseo y vigilancia (base = AIU)', uvt: 2, tarifa: 2 },
    { cod: '32-1', grupo: 'Servicios', nombre: 'Servicios integrales de aseo, cafetería, vigilancia o temporales (base = AIU, mín. 10% del contrato)', uvt: 2, tarifa: 2 },
    { cod: '33', grupo: 'Servicios', nombre: 'Servicios integrales de salud prestados por IPS', uvt: 2, tarifa: 2 },
    { cod: '34', grupo: 'Servicios', nombre: 'Hoteles, restaurantes y hospedajes', uvt: 2, tarifa: 3.5 },
    // Arrendamientos
    { cod: '37', grupo: 'Arrendamientos', nombre: 'Arrendamiento de bienes muebles', uvt: null, tarifa: 4 },
    { cod: '38', grupo: 'Arrendamientos', nombre: 'Arrendamiento de bienes inmuebles', uvt: 10, tarifa: 3.5 },
    // Otros
    { cod: '43', grupo: 'Otros', nombre: 'Indemnizaciones diferentes a las salariales', uvt: null, tarifa: 20 },
    { cod: '45', grupo: 'Otros', nombre: 'Rendimientos financieros en general', uvt: null, tarifa: 7 },
    { cod: '48', grupo: 'Otros', nombre: 'Intereses de créditos o mutuos comerciales', uvt: null, tarifa: 2.5 },
    { cod: '51', grupo: 'Otros', nombre: 'Estudios de mercado y encuestas de opinión', uvt: null, tarifa: 4 },
  ],
};
