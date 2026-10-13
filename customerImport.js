"use strict";

/**
 * Importador de clientes (Excel .xlsx / CSV) — lectura, validación y plan.
 *
 * Funciones puras (sin base de datos ni Express): leen el archivo, detectan
 * columnas, normalizan cada fila y arman el "plan" (qué se crea, qué se
 * omite y por qué). server.js hace la autenticación, carga los clientes
 * existentes y ejecuta el plan con una función SQL atómica.
 *
 * Seguridad:
 * - El archivo se valida por extensión Y por contenido real (firma ZIP /
 *   texto), con tope de tamaño, de filas y de columnas.
 * - Un .xlsx es un ZIP: antes de leerlo se revisa su índice y se descomprime
 *   cada parte con tope de salida (protección contra "zip bombs"), y se
 *   rechaza si trae macros (vbaProject.bin).
 * - Solo se lee la PRIMERA hoja y solo valores. Fórmulas, macros, imágenes y
 *   objetos incrustados no se ejecutan ni se interpretan.
 * - Todo el contenido es texto plano. El tenant_id NUNCA sale del archivo.
 */

const zlib = require("zlib");
const { parse: parseCsv } = require("csv-parse/sync");
const { readSheet } = require("read-excel-file/node");

const LIMITS = Object.freeze({
  MAX_BYTES: 5 * 1024 * 1024,
  MAX_ROWS: 5000,
  MAX_COLUMNS: 60,
  MAX_CELL_CHARS: 2000,
  MAX_ZIP_ENTRIES: 1000,
  MAX_ENTRY_BYTES: 25 * 1024 * 1024,
  MAX_TOTAL_UNCOMPRESSED_BYTES: 40 * 1024 * 1024,
});

const FILE_TYPE_MESSAGE = "Este archivo no se puede importar. Guarda el archivo como .xlsx o .csv.";

class ImportFileError extends Error {
  constructor(message, code = "invalid_file") {
    super(message);
    this.name = "ImportFileError";
    this.code = code;
  }
}

/* ======================================================
   Definición de campos y sinónimos de encabezados
====================================================== */
const FIELDS = [
  {
    key: "full_name",
    label: "Nombre completo",
    exact: [
      "nombre completo", "nombre y apellido", "nombres y apellidos", "nombre y apellidos",
      "nombre apellido", "cliente", "paciente", "nombre cliente", "nombre del cliente",
      "nombre paciente", "full name", "fullname", "apellido y nombre",
    ],
    contains: ["nombre completo", "nombre y apellido", "full name"],
  },
  {
    key: "name",
    label: "Nombre",
    exact: ["nombre", "nombres", "primer nombre", "first name", "firstname", "name", "nombre de pila"],
    contains: ["nombre"],
  },
  {
    key: "last_name",
    label: "Apellido",
    exact: ["apellido", "apellidos", "last name", "lastname", "surname", "apellido paterno"],
    contains: ["apellido", "surname", "last name"],
  },
  {
    key: "phone",
    label: "Teléfono / celular",
    exact: [
      "telefono", "celular", "fono", "movil", "whatsapp", "phone", "mobile", "cell", "tel",
      "telefono movil", "telefono celular", "numero de telefono", "numero telefono", "numero de celular",
      "n telefono", "nro telefono", "cel", "telefono 1", "phone number", "cellphone",
    ],
    contains: ["telefono", "celular", "fono", "movil", "whatsapp", "phone", "mobile"],
    words: ["cel", "tel"],
  },
  {
    key: "email",
    label: "Email",
    exact: ["email", "e mail", "correo", "correo electronico", "mail", "email address", "e-mail", "correo e", "direccion de correo"],
    contains: ["email", "mail", "correo"],
  },
  {
    key: "rut",
    label: "RUT",
    exact: ["rut", "run", "rut cliente", "rut paciente", "identificacion", "documento", "dni", "rut o dni"],
    contains: [],
    words: ["rut", "run", "dni"],
  },
  {
    key: "birth_date",
    label: "Fecha de nacimiento",
    exact: [
      "fecha de nacimiento", "fecha nacimiento", "nacimiento", "cumpleanos", "birth date",
      "birthdate", "birthday", "fecha nac", "f nacimiento", "fec nacimiento", "date of birth", "dob",
    ],
    contains: ["nacimiento", "cumple", "birth"],
  },
  {
    key: "notes",
    label: "Notas / observaciones",
    exact: ["notas", "nota", "observaciones", "observacion", "comentarios", "comentario", "notes", "comments", "detalle", "anotaciones"],
    contains: ["nota", "observ", "coment", "anotaci"],
  },
  {
    key: "last_visit",
    label: "Última visita",
    exact: [
      "ultima visita", "ultima cita", "fecha ultima visita", "fecha ultima cita", "ultima atencion",
      "fecha de ultima visita", "fecha de la ultima visita", "ultima reserva", "last visit",
      "last appointment", "fecha ultima atencion",
    ],
    contains: ["ultima visita", "ultima cita", "ultima atencion", "last visit", "last appointment", "ultima reserva"],
  },
  {
    key: "visit_count",
    label: "Cantidad de visitas",
    exact: [
      "cantidad de visitas", "cantidad de citas", "numero de visitas", "numero de citas",
      "n visitas", "n citas", "nro visitas", "nro citas", "visitas", "citas", "total visitas",
      "total citas", "total de visitas", "total de citas", "visit count", "visits", "cantidad visitas",
      "cantidad citas", "numero visitas", "numero citas", "atenciones", "total atenciones",
    ],
    contains: ["cantidad de visita", "cantidad de cita", "numero de visita", "numero de cita", "total de visita", "total visita", "total cita", "visit count"],
  },
];

const FIELD_KEYS = FIELDS.map((f) => f.key);

// Orden en que se asignan columnas (lo más específico primero).
const MAPPING_PRIORITY = [
  "full_name", "last_visit", "visit_count", "birth_date", "phone", "email", "rut", "notes", "last_name", "name",
];

function normalizeHeader(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function columnLetter(index) {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/* ======================================================
   Texto: limpieza y anti-inyección de fórmulas
====================================================== */
// Quita caracteres de control y de ancho cero; no toca saltos de línea.
function stripControlChars(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/ /g, " ");
}

function cleanSingleLine(text) {
  return stripControlChars(text).replace(/\s+/g, " ").trim();
}

function cleanMultiLine(text) {
  const lines = stripControlChars(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim());
  const out = [];
  for (const line of lines) {
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

// Un texto que empieza con = + - @ (o tab/CR) puede ejecutarse como fórmula
// al abrirlo/exportarlo en Excel: se antepone una comilla simple.
function neutralizeFormula(text) {
  if (!text) return text;
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function cellToText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  return String(value).slice(0, LIMITS.MAX_CELL_CHARS);
}

/* ======================================================
   Fechas
====================================================== */
function validYmd(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { y, m, d };
}

// Acepta Date, serial de Excel, "2026-09-20", "20/09/2026", "20-09-26", etc.
// Formato chileno: día/mes/año. Devuelve {y,m,d} o null.
function parseDateParts(value, { now = new Date() } = {}) {
  if (value === null || value === undefined || value === "") return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return validYmd(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }

  if (typeof value === "number") {
    // Serial de Excel (días desde 1899-12-30) cuando la celda no venía con formato fecha.
    if (value >= 20000 && value <= 80000) {
      const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
      return validYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    return null;
  }

  const text = cleanSingleLine(value);
  if (!text) return null;

  let m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]));

  m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T\s].*)?$/);
  if (m) return validYmd(Number(m[3]), Number(m[2]), Number(m[1]));

  m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
  if (m) {
    const yy = Number(m[3]);
    const currentYY = now.getUTCFullYear() % 100;
    const year = yy <= currentYY ? 2000 + yy : 1900 + yy;
    return validYmd(year, Number(m[2]), Number(m[1]));
  }

  return null;
}

function partsToIsoDate(p) {
  return `${String(p.y).padStart(4, "0")}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

// Mediodía UTC: cae el mismo día calendario en Chile (UTC-3/-4) sin corrimientos.
function partsToNoonIso(p) {
  return `${partsToIsoDate(p)}T12:00:00.000Z`;
}

function todayKey(now) {
  return now.toISOString().slice(0, 10);
}

/* ======================================================
   Lectura del archivo
====================================================== */
function getExtension(fileName) {
  const name = String(fileName || "").trim().toLowerCase();
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1) : "";
}

function isZipSignature(buf) {
  return (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    ((buf[2] === 0x03 && buf[3] === 0x04) || (buf[2] === 0x05 && buf[3] === 0x06) || (buf[2] === 0x07 && buf[3] === 0x08))
  );
}

function isOleSignature(buf) {
  return (
    buf.length >= 8 &&
    buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0 &&
    buf[4] === 0xa1 && buf[5] === 0xb1 && buf[6] === 0x1a && buf[7] === 0xe1
  );
}

// Índice (directorio central) de un ZIP. Lanza ImportFileError si es inválido.
function readZipEntries(buf) {
  const corrupt = () => new ImportFileError("El archivo parece dañado. Vuelve a guardarlo como .xlsx o .csv.", "corrupt_file");

  const minPos = Math.max(0, buf.length - (22 + 65535));
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw corrupt();

  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) throw corrupt(); // zip64: no se espera en un Excel normal
  if (total > LIMITS.MAX_ZIP_ENTRIES) {
    throw new ImportFileError("El archivo tiene una estructura demasiado compleja. Guárdalo como .xlsx o .csv simple.", "too_complex");
  }

  const entries = [];
  let pos = cdOffset;
  for (let n = 0; n < total; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw corrupt();
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    if (pos + 46 + nameLen > buf.length) throw corrupt();
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    entries.push({ name, method, compSize, size, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Valida que sea un .xlsx real (no .xlsm, no ZIP cualquiera) y que ninguna
// parte se expanda más de lo declarado. No guarda el contenido descomprimido.
function assertSafeXlsx(buf) {
  const entries = readZipEntries(buf);
  const names = new Set(entries.map((e) => e.name));

  if (!names.has("[Content_Types].xml") || !names.has("xl/workbook.xml")) {
    throw new ImportFileError(FILE_TYPE_MESSAGE, "not_xlsx");
  }

  for (const e of entries) {
    const lower = e.name.toLowerCase();
    if (e.name.includes("..") || e.name.startsWith("/") || e.name.includes("\\")) {
      throw new ImportFileError("El archivo parece dañado. Vuelve a guardarlo como .xlsx o .csv.", "corrupt_file");
    }
    if (lower.endsWith("vbaproject.bin") || lower.startsWith("xl/macrosheets/") || lower.startsWith("xl/vbadata")) {
      throw new ImportFileError(
        "Este archivo tiene macros y no se puede importar. Guarda el archivo como .xlsx o .csv.",
        "has_macros"
      );
    }
  }

  let totalBytes = 0;
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    if (e.method !== 0 && e.method !== 8) {
      throw new ImportFileError("El archivo parece dañado. Vuelve a guardarlo como .xlsx o .csv.", "corrupt_file");
    }
    if (e.size > LIMITS.MAX_ENTRY_BYTES) {
      throw new ImportFileError("El archivo es demasiado grande para procesarlo. Divídelo en partes más pequeñas.", "too_big");
    }
    totalBytes += e.size;
    if (totalBytes > LIMITS.MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new ImportFileError("El archivo es demasiado grande para procesarlo. Divídelo en partes más pequeñas.", "too_big");
    }

    // Encabezado local → inicio real de los datos.
    const lo = e.localOffset;
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) {
      throw new ImportFileError("El archivo parece dañado. Vuelve a guardarlo como .xlsx o .csv.", "corrupt_file");
    }
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const data = buf.subarray(start, start + e.compSize);

    if (e.method === 8) {
      try {
        // Tope de salida = tamaño declarado: si la parte se expande más, falla.
        zlib.inflateRawSync(data, { maxOutputLength: Math.max(e.size, 1) });
      } catch {
        throw new ImportFileError("El archivo parece dañado. Vuelve a guardarlo como .xlsx o .csv.", "corrupt_file");
      }
    } else if (data.length > Math.max(e.size, 0) + 0) {
      throw new ImportFileError("El archivo parece dañado. Vuelve a guardarlo como .xlsx o .csv.", "corrupt_file");
    }
  }
}

function decodeCsvBuffer(buf) {
  let slice = buf;
  let encoding = "utf-8";

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    slice = buf.subarray(3);
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    slice = buf.subarray(2);
    encoding = "utf-16le";
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE: se invierte a LE.
    const body = Buffer.from(buf.subarray(2));
    for (let i = 0; i + 1 < body.length; i += 2) {
      const t = body[i];
      body[i] = body[i + 1];
      body[i + 1] = t;
    }
    slice = body;
    encoding = "utf-16le";
  } else if (buf.includes(0)) {
    throw new ImportFileError(FILE_TYPE_MESSAGE, "not_csv");
  }

  try {
    return new TextDecoder(encoding, { fatal: true }).decode(slice);
  } catch {
    // Excel en Windows suele guardar CSV en Windows-1252 (tildes y ñ).
    return new TextDecoder("windows-1252").decode(slice);
  }
}

function detectCsvDelimiter(text) {
  const firstLine = (text.split(/\r?\n/).find((l) => l.trim() !== "") || "").slice(0, 4000);
  const counts = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && counts[ch] !== undefined) counts[ch]++;
  }
  let best = ",";
  let bestCount = 0;
  for (const [d, c] of Object.entries(counts)) {
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

function looksLikeBinaryText(text) {
  const sample = text.slice(0, 20000);
  if (!sample) return false;
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) control++;
  }
  return control / sample.length > 0.01;
}

/**
 * Lee un archivo subido y devuelve { kind, headers, rows, firstDataRowNumber }.
 * rows = filas de datos (sin encabezado, sin filas totalmente vacías), cada
 * una { number, cells } con `number` = número de fila en el archivo.
 */
async function readImportFile(buffer, fileName) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ImportFileError("El archivo está vacío.", "empty");
  }
  if (buffer.length > LIMITS.MAX_BYTES) {
    throw new ImportFileError("El archivo pesa más de 5 MB. Divídelo en partes más pequeñas.", "too_big");
  }

  const ext = getExtension(fileName);
  if (ext !== "xlsx" && ext !== "csv") {
    throw new ImportFileError(FILE_TYPE_MESSAGE, "bad_extension");
  }

  let table; // array de arrays con valores crudos

  if (ext === "xlsx") {
    if (isOleSignature(buffer)) {
      throw new ImportFileError(
        "Este archivo es de un formato antiguo o está protegido con contraseña. Guarda el archivo como .xlsx o .csv.",
        "ole_file"
      );
    }
    if (!isZipSignature(buffer)) {
      throw new ImportFileError(FILE_TYPE_MESSAGE, "not_xlsx");
    }
    assertSafeXlsx(buffer);

    try {
      // Solo la primera hoja, solo valores (las fórmulas llegan como su valor
      // guardado; nunca se evalúan).
      table = await readSheet(buffer);
    } catch {
      throw new ImportFileError("No pudimos leer el archivo. Vuelve a guardarlo como .xlsx o .csv.", "unreadable");
    }
  } else {
    if (isZipSignature(buffer) || isOleSignature(buffer) || buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
      throw new ImportFileError(FILE_TYPE_MESSAGE, "not_csv");
    }
    const text = decodeCsvBuffer(buffer);
    if (looksLikeBinaryText(text)) {
      throw new ImportFileError(FILE_TYPE_MESSAGE, "not_csv");
    }
    try {
      table = parseCsv(text, {
        delimiter: detectCsvDelimiter(text),
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: true,
        bom: true,
        trim: false,
      });
    } catch {
      throw new ImportFileError("No pudimos leer el archivo. Revisa que sea un CSV válido.", "unreadable");
    }
  }

  if (!Array.isArray(table) || table.length === 0) {
    throw new ImportFileError("El archivo no tiene datos.", "empty");
  }

  const isRowEmpty = (row) => !Array.isArray(row) || row.every((c) => cellToText(c).trim() === "");

  // Encabezado = primera fila con contenido.
  const headerIndex = table.findIndex((row) => !isRowEmpty(row));
  if (headerIndex < 0) throw new ImportFileError("El archivo no tiene datos.", "empty");

  const headerRow = table[headerIndex];
  const width = Math.max(headerRow.length, ...table.slice(headerIndex + 1, headerIndex + 200).map((r) => (Array.isArray(r) ? r.length : 0)));
  if (width > LIMITS.MAX_COLUMNS) {
    throw new ImportFileError(`El archivo tiene demasiadas columnas (máximo ${LIMITS.MAX_COLUMNS}).`, "too_wide");
  }

  const headers = [];
  for (let i = 0; i < width; i++) {
    const label = cleanSingleLine(cellToText(headerRow[i])).slice(0, 80);
    headers.push(label || `Columna ${columnLetter(i)}`);
  }

  const rows = [];
  for (let i = headerIndex + 1; i < table.length; i++) {
    const row = table[i];
    if (isRowEmpty(row)) continue;
    rows.push({ number: i + 1, cells: row });
    if (rows.length > LIMITS.MAX_ROWS) {
      throw new ImportFileError(
        `El archivo tiene más de ${LIMITS.MAX_ROWS.toLocaleString("es-CL")} filas. Divídelo en archivos más pequeños.`,
        "too_many_rows"
      );
    }
  }

  if (rows.length === 0) {
    throw new ImportFileError("El archivo solo tiene los encabezados, no hay clientes para importar.", "empty");
  }

  return { kind: ext, headers, rows };
}

/* ======================================================
   Mapeo de columnas
====================================================== */
// Devuelve { [field]: columnIndex | null }
function suggestMapping(headers) {
  const normalized = headers.map(normalizeHeader);
  const mapping = Object.fromEntries(FIELD_KEYS.map((k) => [k, null]));
  const used = new Set();

  const assign = (key, predicate) => {
    for (let i = 0; i < normalized.length; i++) {
      if (used.has(i) || !normalized[i]) continue;
      if (predicate(normalized[i])) {
        mapping[key] = i;
        used.add(i);
        return true;
      }
    }
    return false;
  };

  // Pasada 1: coincidencia exacta con un sinónimo.
  for (const key of MAPPING_PRIORITY) {
    const def = FIELDS.find((f) => f.key === key);
    assign(key, (h) => def.exact.includes(h));
  }

  // Pasada 2: el encabezado contiene una palabra clave.
  for (const key of MAPPING_PRIORITY) {
    if (mapping[key] !== null) continue;
    const def = FIELDS.find((f) => f.key === key);
    assign(key, (h) => {
      if (def.contains.some((token) => h.includes(token))) return true;
      const padded = ` ${h} `;
      return (def.words || []).some((w) => padded.includes(` ${w} `));
    });
  }

  return mapping;
}

// Valida un mapeo recibido del cliente. Devuelve { mapping, problems }.
function normalizeMapping(rawMapping, columnCount) {
  const mapping = Object.fromEntries(FIELD_KEYS.map((k) => [k, null]));
  const problems = [];
  const used = new Map();

  for (const key of FIELD_KEYS) {
    const raw = rawMapping ? rawMapping[key] : null;
    if (raw === null || raw === undefined || raw === "") continue;
    const idx = Number(raw);
    if (!Number.isInteger(idx) || idx < 0 || idx >= columnCount) {
      problems.push("El mapeo de columnas no es válido. Vuelve a seleccionar las columnas.");
      continue;
    }
    if (used.has(idx)) {
      const label = FIELDS.find((f) => f.key === used.get(idx)).label;
      const label2 = FIELDS.find((f) => f.key === key).label;
      problems.push(`Una misma columna no puede ser "${label}" y "${label2}" a la vez.`);
      continue;
    }
    used.set(idx, key);
    mapping[key] = idx;
  }

  if (mapping.full_name === null && mapping.name === null) {
    problems.push("Falta indicar qué columna tiene el nombre del cliente.");
  }
  if (mapping.phone === null && mapping.email === null) {
    problems.push("Falta indicar qué columna tiene el teléfono o el email.");
  }

  return { mapping, problems };
}

/* ======================================================
   Normalización de filas + plan de importación
====================================================== */
const FILLABLE_FIELDS = ["email", "phone", "rut", "birth_date", "notes", "imported_last_visit_at", "imported_visit_count"];

function isEmptyExisting(field, value) {
  if (field === "imported_visit_count") return value === null || value === undefined || Number(value) === 0;
  return value === null || value === undefined || String(value).trim() === "";
}

/**
 * Arma el plan de importación.
 * @param {object} p
 * @param {Array<{number:number,cells:any[]}>} p.rows
 * @param {object} p.mapping  { field: columnIndex|null }
 * @param {Array<object>} p.existing clientes ya existentes del tenant
 * @param {(raw:any)=>string|null} p.normalizePhone  → "+569XXXXXXXX" | null
 * @param {(raw:any)=>boolean} p.isValidEmail
 * @param {"skip"|"fill_empty"} p.duplicateMode
 * @param {Date} p.now
 */
function buildImportPlan({ rows, mapping, existing = [], normalizePhone, isValidEmail, duplicateMode = "skip", now = new Date() }) {
  const mode = duplicateMode === "fill_empty" ? "fill_empty" : "skip";
  const today = todayKey(now);

  // Índices de clientes existentes por teléfono normalizado y por email.
  const existingByPhone = new Map();
  const existingByEmail = new Map();
  for (const c of existing) {
    const phone = c.phone ? normalizePhone(c.phone) : null;
    if (phone && !existingByPhone.has(phone)) existingByPhone.set(phone, c);
    const email = c.email ? String(c.email).trim().toLowerCase() : "";
    if (email && !existingByEmail.has(email)) existingByEmail.set(email, c);
  }

  const seenPhone = new Map(); // phone -> fila
  const seenEmail = new Map();

  const result = [];
  const cell = (cells, key) => {
    const idx = mapping[key];
    return idx === null || idx === undefined ? undefined : cells[idx];
  };

  for (const row of rows) {
    const warnings = [];
    const cells = row.cells || [];

    // ---- Nombre
    let rawName = "";
    const fullNameRaw = cell(cells, "full_name");
    if (fullNameRaw !== undefined && cleanSingleLine(cellToText(fullNameRaw))) {
      rawName = cleanSingleLine(cellToText(fullNameRaw));
    } else {
      const first = cleanSingleLine(cellToText(cell(cells, "name")));
      const last = cleanSingleLine(cellToText(cell(cells, "last_name")));
      rawName = [first, last].filter(Boolean).join(" ");
    }
    const name = neutralizeFormula(rawName);

    // ---- Teléfono / email
    const rawPhone = cleanSingleLine(cellToText(cell(cells, "phone")));
    const rawEmail = cleanSingleLine(cellToText(cell(cells, "email"))).toLowerCase();
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    const email = rawEmail && isValidEmail(rawEmail) ? rawEmail : null;

    const display = { name: name || "(sin nombre)", phone: phone || rawPhone || "", email: email || rawEmail || "" };

    const fail = (reason) => result.push({ row: row.number, status: "error", reason, warnings, display });

    if (!name) {
      fail("Falta el nombre.");
      continue;
    }
    if (name.length > 200) {
      fail("El nombre es demasiado largo (máximo 200 letras).");
      continue;
    }
    if (!phone && !email) {
      if (!rawPhone && !rawEmail) {
        fail("Falta el teléfono o el email.");
      } else if (rawPhone && !phone && (!rawEmail || !email)) {
        fail(
          rawEmail && !email
            ? "El teléfono no es un celular chileno válido y el email no es válido."
            : "El teléfono no es un celular chileno válido (debe tener 9 dígitos y partir con 9)."
        );
      } else {
        fail("El email no es válido.");
      }
      continue;
    }
    if (rawPhone && !phone) warnings.push("El teléfono no es válido: se importó sin él.");
    if (rawEmail && !email) warnings.push("El email no es válido: se importó sin él.");

    // ---- Datos opcionales
    let rut = cleanSingleLine(cellToText(cell(cells, "rut")));
    if (rut.length > 20) {
      warnings.push("El RUT es demasiado largo: se importó sin él.");
      rut = "";
    }
    rut = neutralizeFormula(rut);

    let notes = cleanMultiLine(cellToText(cell(cells, "notes")));
    if (notes.length > 1000) {
      notes = notes.slice(0, 1000);
      warnings.push("Las notas eran muy largas: se cortaron en 1.000 letras.");
    }
    notes = neutralizeFormula(notes);

    let birthDate = null;
    const rawBirth = cell(cells, "birth_date");
    if (rawBirth !== undefined && cellToText(rawBirth).trim() !== "") {
      const p = parseDateParts(rawBirth, { now });
      if (!p || p.y < 1900 || partsToIsoDate(p) > today) {
        warnings.push("La fecha de nacimiento no es válida: se importó sin ella.");
      } else {
        birthDate = partsToIsoDate(p);
      }
    }

    let lastVisit = null;
    const rawLast = cell(cells, "last_visit");
    if (rawLast !== undefined && cellToText(rawLast).trim() !== "") {
      const p = parseDateParts(rawLast, { now });
      if (!p || p.y < 1990 || partsToIsoDate(p) > today) {
        warnings.push("La fecha de última visita no es válida o es futura: se importó sin ella.");
      } else {
        lastVisit = partsToNoonIso(p);
      }
    }

    let visitCount = null;
    const rawCount = cell(cells, "visit_count");
    if (rawCount !== undefined && cellToText(rawCount).trim() !== "") {
      const t = cleanSingleLine(cellToText(rawCount));
      if (/^\d{1,4}$/.test(t)) {
        visitCount = Number(t);
      } else if (/^\d{1,4}[.,]0+$/.test(t)) {
        visitCount = Number(t.split(/[.,]/)[0]);
      } else {
        warnings.push("La cantidad de visitas no es un número válido: se importó sin ella.");
      }
    }
    if (lastVisit && (visitCount === null || visitCount === 0)) visitCount = 1;
    if (!lastVisit && visitCount && visitCount > 0) {
      warnings.push("Trae la cantidad de visitas pero no la fecha de la última: el cliente no se podrá clasificar por antigüedad.");
    }

    const data = {
      name,
      phone,
      email,
      rut: rut || null,
      birth_date: birthDate,
      notes: notes || null,
      imported_last_visit_at: lastVisit,
      imported_visit_count: visitCount && visitCount > 0 ? visitCount : null,
    };

    // ---- Duplicado dentro del archivo
    let dupRow = null;
    if (phone && seenPhone.has(phone)) dupRow = seenPhone.get(phone);
    else if (email && seenEmail.has(email)) dupRow = seenEmail.get(email);
    if (dupRow !== null) {
      result.push({
        row: row.number,
        status: "duplicate_file",
        reason: `Está repetido en el archivo (igual que la fila ${dupRow}).`,
        warnings,
        display,
      });
      continue;
    }
    if (phone) seenPhone.set(phone, row.number);
    if (email) seenEmail.set(email, row.number);

    // ---- Duplicado con clientes que ya existen
    const byPhone = phone ? existingByPhone.get(phone) : undefined;
    const byEmail = email ? existingByEmail.get(email) : undefined;

    if (byPhone && byEmail && byPhone.id !== byEmail.id) {
      result.push({
        row: row.number,
        status: "duplicate_existing",
        action: "conflict",
        reason: "El teléfono y el email corresponden a dos clientes distintos que ya tienes. Revísalo a mano.",
        warnings,
        display,
      });
      continue;
    }

    const match = byPhone || byEmail;
    if (match) {
      const matchInfo = { customer_id: match.id, customer_name: match.name || "" };
      if (mode === "skip") {
        result.push({
          row: row.number,
          status: "duplicate_existing",
          action: "skip",
          reason: `Ya existe en tus clientes (${match.name || "sin nombre"}).`,
          warnings,
          display,
          match: matchInfo,
        });
        continue;
      }

      const fill = {};
      for (const field of FILLABLE_FIELDS) {
        const incoming = data[field];
        if (incoming === null || incoming === undefined || incoming === "") continue;
        if (isEmptyExisting(field, match[field])) fill[field] = incoming;
      }
      if (Object.keys(fill).length === 0) {
        result.push({
          row: row.number,
          status: "duplicate_existing",
          action: "nothing_new",
          reason: `Ya existe en tus clientes (${match.name || "sin nombre"}) y no trae datos nuevos.`,
          warnings,
          display,
          match: matchInfo,
        });
      } else {
        result.push({
          row: row.number,
          status: "duplicate_existing",
          action: "fill",
          reason: `Ya existe (${match.name || "sin nombre"}): se completarán sus datos vacíos.`,
          warnings,
          display,
          match: matchInfo,
          fill,
        });
      }
      continue;
    }

    result.push({ row: row.number, status: "new", warnings, display, data });
  }

  const count = (pred) => result.filter(pred).length;
  const summary = {
    total_rows: result.length,
    new_count: count((r) => r.status === "new"),
    error_count: count((r) => r.status === "error"),
    duplicate_file_count: count((r) => r.status === "duplicate_file"),
    duplicate_existing_count: count((r) => r.status === "duplicate_existing"),
    fill_count: count((r) => r.action === "fill"),
    skipped_count: count(
      (r) => r.status === "error" || r.status === "duplicate_file" || (r.status === "duplicate_existing" && r.action !== "fill")
    ),
    with_history_count: count((r) => r.status === "new" && r.data.imported_last_visit_at),
    warning_count: count((r) => r.warnings && r.warnings.length > 0),
  };

  return { rows: result, summary };
}

module.exports = {
  LIMITS,
  FILE_TYPE_MESSAGE,
  FIELDS,
  ImportFileError,
  readImportFile,
  suggestMapping,
  normalizeMapping,
  buildImportPlan,
  // expuestos para pruebas
  normalizeHeader,
  neutralizeFormula,
  parseDateParts,
  assertSafeXlsx,
};
