// Pruebas del importador de clientes (lectura, validación, plan, archivos maliciosos).
// Uso:  node scripts/test-customer-import.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const ROOT = path.join(__dirname, "..");
const imp = require(path.join(ROOT, "customerImport.js"));

const NOW = new Date("2026-10-12T15:00:00Z");
let fails = 0;
const ok = (cond, label, extra = "") => {
  if (!cond) fails++;
  console.log(cond ? "OK  " : "FAIL", label, extra);
};

function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("56")) digits = digits.slice(2);
  if (digits.length !== 9 || !digits.startsWith("9")) return null;
  return `+56${digits}`;
}
const isValidEmail = (e) => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(e || "").trim());

const EXISTING = [
  { id: "c-pedro", name: "Pedro Existente", phone: "987650001", email: null, rut: null, birth_date: null, notes: null },
  { id: "c-elena", name: "Elena Existente", phone: null, email: "elena.existente@correo.cl", rut: null, birth_date: null, notes: "nota vieja" },
];

async function expectReject(label, buf, name, codePart) {
  try {
    await imp.readImportFile(buf, name);
    ok(false, label, "(no rechazó)");
  } catch (e) {
    ok(e instanceof imp.ImportFileError && (!codePart || e.code === codePart), label, `→ ${e.code}: ${e.message}`);
  }
}

// --- zip helpers para armar archivos maliciosos
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files, { lieSize } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const comp = zlib.deflateRawSync(raw);
    const declared = lieSize !== undefined ? lieSize : raw.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(declared, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(declared, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

(async () => {
  console.log("== Archivo de prueba .xlsx");
  const xlsx = fs.readFileSync(path.join(ROOT, "samples", "importar-clientes-prueba.xlsx"));
  const file = await imp.readImportFile(xlsx, "importar-clientes-prueba.xlsx");
  ok(file.rows.length === 16, "lee 16 filas de datos", `(${file.rows.length})`);
  const mapping = imp.suggestMapping(file.headers);
  console.log("   mapeo detectado:", JSON.stringify(mapping));
  ok(
    mapping.name === 0 && mapping.last_name === 1 && mapping.phone === 2 && mapping.email === 3 && mapping.rut === 4 &&
      mapping.birth_date === 5 && mapping.last_visit === 6 && mapping.visit_count === 7 && mapping.notes === 8 &&
      mapping.full_name === null,
    "autodetecta todas las columnas"
  );
  const norm = imp.normalizeMapping(mapping, file.headers.length);
  ok(norm.problems.length === 0, "mapeo sin problemas");

  const plan = imp.buildImportPlan({ rows: file.rows, mapping: norm.mapping, existing: EXISTING, normalizePhone, isValidEmail, duplicateMode: "skip", now: NOW });
  console.log("   resumen skip:", JSON.stringify(plan.summary));
  const by = (n) => plan.rows.find((r) => r.row === n);
  ok(plan.summary.new_count === 8, "8 filas nuevas", `(${plan.summary.new_count})`);
  ok(plan.summary.error_count === 4, "4 con error", `(${plan.summary.error_count})`);
  ok(plan.summary.duplicate_file_count === 2, "2 repetidas en el archivo", `(${plan.summary.duplicate_file_count})`);
  ok(plan.summary.duplicate_existing_count === 2, "2 ya existen", `(${plan.summary.duplicate_existing_count})`);
  ok(by(2).data.phone === "+56912345678" && by(2).data.email === "maria.gonzalez@correo.cl", "teléfono normalizado a +569…");
  ok(by(2).data.imported_visit_count === 7 && by(2).data.imported_last_visit_at === "2026-09-20T12:00:00.000Z", "historial importado (7 visitas, 20-09-2026)");
  ok(by(2).data.birth_date === "1985-03-15", "fecha de nacimiento ISO");
  ok(by(3).data.phone === "+56987654321" && by(3).data.birth_date === "1990-07-22", "teléfono con +56 y espacios + fecha dd-mm-aaaa");
  ok(by(3).data.imported_last_visit_at === "2026-08-05T12:00:00.000Z" && by(3).data.imported_visit_count === 3, "última visita dd/mm/aaaa y visitas como texto");
  ok(by(4).data.phone === null && by(4).data.email === "camila.soto@correo.cl", "solo email es válido");
  ok(by(6).data.notes.startsWith("'="), "fórmula en notas neutralizada", by(6).data.notes);
  ok(by(7).data.name.startsWith("'-"), "nombre que parte con - neutralizado", by(7).data.name);
  ok(by(7).data.notes.startsWith("'+"), "nota que parte con + neutralizada");
  ok(by(7).data.phone === "+56945671234", "el teléfono no se altera con comilla");
  ok(by(8).warnings.length > 0 && by(8).data.imported_visit_count === 5 && by(8).data.imported_last_visit_at === null, "visitas sin fecha → aviso");
  ok(by(9).status === "new" && by(9).warnings.length === 2 && by(9).data.birth_date === null && by(9).data.imported_last_visit_at === null, "fechas inválidas/futuras se ignoran con aviso");
  ok(by(10).status === "error" && /nombre/i.test(by(10).reason), "error: falta nombre", by(10).reason);
  ok(by(11).status === "error" && /teléfono o el email/i.test(by(11).reason), "error: sin contacto", by(11).reason);
  ok(by(12).status === "error" && /celular chileno/i.test(by(12).reason), "error: teléfono fijo", by(12).reason);
  ok(by(13).status === "error" && /email/i.test(by(13).reason), "error: email inválido", by(13).reason);
  ok(by(14).status === "duplicate_file" && /fila 2/.test(by(14).reason), "duplicado en archivo por teléfono", by(14).reason);
  ok(by(15).status === "duplicate_file" && /fila 4/.test(by(15).reason), "duplicado en archivo por email (mayúsculas)", by(15).reason);
  ok(by(16).status === "duplicate_existing" && by(16).action === "skip", "existente por teléfono → omitir", by(16).reason);
  ok(by(17).status === "duplicate_existing" && by(17).action === "skip", "existente por email → omitir", by(17).reason);

  const planFill = imp.buildImportPlan({ rows: file.rows, mapping: norm.mapping, existing: EXISTING, normalizePhone, isValidEmail, duplicateMode: "fill_empty", now: NOW });
  const f16 = planFill.rows.find((r) => r.row === 16);
  const f17 = planFill.rows.find((r) => r.row === 17);
  ok(f16.action === "fill" && f16.fill.imported_visit_count === 4 && !("phone" in f16.fill) && !("name" in f16.fill), "completar vacíos: no pisa teléfono ni nombre", JSON.stringify(f16.fill));
  ok(f17.action === "fill" && f17.fill.rut === "11.111.111-1" && f17.fill.birth_date === "1979-11-02" && !("notes" in f17.fill), "completar vacíos: no pisa notas existentes", JSON.stringify(f17.fill));
  ok(planFill.summary.fill_count === 2, "2 filas se completan");

  console.log("== CSV (; y BOM)");
  const csvBuf = fs.readFileSync(path.join(ROOT, "samples", "importar-clientes-prueba.csv"));
  const csvFile = await imp.readImportFile(csvBuf, "x.csv");
  ok(csvFile.rows.length === 16 && csvFile.headers[6] === "Última visita", "CSV con ; y BOM se lee igual", `(${csvFile.rows.length} filas)`);
  const csvPlan = imp.buildImportPlan({ rows: csvFile.rows, mapping: imp.normalizeMapping(imp.suggestMapping(csvFile.headers), csvFile.headers.length).mapping, existing: EXISTING, normalizePhone, isValidEmail, now: NOW });
  ok(JSON.stringify(csvPlan.summary) === JSON.stringify(plan.summary), "CSV y XLSX dan el mismo resumen");

  console.log("== CSV Latin-1 (Windows-1252)");
  const latin = Buffer.from("Nombre;Teléfono;Correo\r\nJosé Muñoz;912345678;jose@correo.cl\r\n", "latin1");
  const lf = await imp.readImportFile(latin, "latin.csv");
  ok(lf.rows[0].cells[0] === "José Muñoz" && lf.headers[1] === "Teléfono", "decodifica Windows-1252 (tildes y ñ)");

  console.log("== Archivos rechazados");
  await expectReject(".xlsm por extensión", xlsx, "datos.xlsm", "bad_extension");
  await expectReject(".xls por extensión", xlsx, "datos.xls", "bad_extension");
  await expectReject(".exe", Buffer.from("MZ......"), "virus.exe", "bad_extension");
  await expectReject(".xlsx que en realidad es texto", Buffer.from("hola esto no es un excel"), "falso.xlsx", "not_xlsx");
  await expectReject(".xlsx que es un .xls antiguo (OLE)", Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]), "viejo.xlsx", "ole_file");
  await expectReject(".csv que en realidad es un zip/xlsx", xlsx, "falso.csv", "not_csv");
  await expectReject(".csv binario", Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x00, 0x10]), "bin.csv", "not_csv");
  await expectReject(".csv PDF", Buffer.from("%PDF-1.7\n...."), "doc.csv", "not_csv");
  await expectReject("vacío", Buffer.alloc(0), "a.csv", "empty");
  await expectReject("más de 5 MB", Buffer.alloc(5 * 1024 * 1024 + 1, 0x41), "grande.csv", "too_big");
  await expectReject("zip cualquiera renombrado .xlsx", makeZip([{ name: "hola.txt", data: "hola" }]), "zip.xlsx", "not_xlsx");
  await expectReject(
    "xlsx con macros (vbaProject.bin)",
    makeZip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "xl/workbook.xml", data: "<workbook/>" }, { name: "xl/vbaProject.bin", data: "macro" }]),
    "macro.xlsx",
    "has_macros"
  );
  const bomb = makeZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "xl/workbook.xml", data: "<workbook/>" },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(30 * 1024 * 1024, 0x41) },
  ]);
  ok(bomb.length < 5 * 1024 * 1024, "la bomba pesa poco comprimida", `(${bomb.length} bytes)`);
  await expectReject("zip bomb (30 MB en una parte)", bomb, "bomba.xlsx", "too_big");
  const liar = makeZip(
    [
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "xl/workbook.xml", data: "<workbook/>" },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(5 * 1024 * 1024, 0x41) },
    ],
    { lieSize: 100 }
  );
  await expectReject("zip que miente sobre su tamaño", liar, "miente.xlsx", "corrupt_file");

  const many = "Nombre;Celular\n" + Array.from({ length: 5001 }, (_, i) => `Cliente ${i};9${String(10000000 + i)}`).join("\n");
  await expectReject("más de 5.000 filas", Buffer.from(many), "muchas.csv", "too_many_rows");
  const exactly = "Nombre;Celular\n" + Array.from({ length: 5000 }, (_, i) => `Cliente ${i};9${String(10000000 + i)}`).join("\n");
  const exFile = await imp.readImportFile(Buffer.from(exactly), "justo.csv");
  ok(exFile.rows.length === 5000, "5.000 filas exactas sí se aceptan");

  console.log("== Mapeo");
  const m1 = imp.suggestMapping(["Nombre y Apellido", "Fono", "Correo electrónico", "Observaciones", "N° citas", "Última cita"]);
  ok(m1.full_name === 0 && m1.phone === 1 && m1.email === 2 && m1.notes === 3 && m1.visit_count === 4 && m1.last_visit === 5, "sinónimos en español", JSON.stringify(m1));
  const m2 = imp.suggestMapping(["First Name", "Last Name", "Mobile", "E-mail", "Birthday"]);
  ok(m2.name === 0 && m2.last_name === 1 && m2.phone === 2 && m2.email === 3 && m2.birth_date === 4, "sinónimos en inglés", JSON.stringify(m2));
  ok(imp.normalizeMapping({ name: 0, phone: 0 }, 3).problems.length >= 1, "una columna no puede ser dos datos");
  ok(imp.normalizeMapping({ name: 0 }, 3).problems.some((p) => /teléfono o el email/.test(p)), "exige contacto");
  ok(imp.normalizeMapping({ phone: 1 }, 3).problems.some((p) => /nombre/.test(p)), "exige nombre");
  ok(imp.normalizeMapping({ name: 9 }, 3).problems.length > 0, "índice fuera de rango");

  console.log(fails === 0 ? "\nTODO OK" : `\n${fails} FALLAS`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("ERROR en el test", e);
  process.exit(1);
});
