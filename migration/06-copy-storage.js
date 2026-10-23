#!/usr/bin/env node
/*
 * Copia los archivos de Supabase Storage del proyecto VIEJO al NUEVO, con la misma ruta y el mismo contentType.
 *
 *   node migration/06-copy-storage.js                 -> SIMULACRO: lista lo que copiaria (solo lee)
 *   node migration/06-copy-storage.js --apply         -> crea buckets faltantes y copia (escribe en el NUEVO)
 *   node migration/06-copy-storage.js --verify        -> compara viejo vs nuevo (solo lee); sale con error si difieren
 *   opciones: --buckets business-logos,staff-photos   (por defecto: todos los buckets del viejo)
 *
 * Es idempotente: omite lo que ya existe en el nuevo con el mismo tamano. Sirve para el ensayo y para la pasada final.
 * El proyecto VIEJO solo se LEE. Las rutas no cambian, asi que file_path / deposit_receipt_path en la base siguen valiendo
 * (las URLs publicas guardadas se reescriben aparte con 07-rewrite-urls.sh).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// --- variables: del entorno o de ~/orbyx-migration.env (mismo archivo que usan los .sh) ---
const envFile = process.env.ORBYX_MIGRATION_ENV || path.join(os.homedir(), "orbyx-migration.env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
const OLD_REF = process.env.OLD_REF || "vmxjqhndepvgoexajtfc";
const NEW_REF = process.env.NEW_REF || "fqmdcbvtrgcnftlwcojc";
const need = (k) => { if (!process.env[k]) { console.error(`Falta ${k} en ${envFile}`); process.exit(2); } return process.env[k]; };
const OLD_URL = need("OLD_SUPABASE_URL"), OLD_KEY = need("OLD_SERVICE_ROLE_KEY");
const NEW_URL = need("NEW_SUPABASE_URL"), NEW_KEY = need("NEW_SERVICE_ROLE_KEY");
if (!OLD_URL.includes(OLD_REF) || OLD_URL.includes(NEW_REF)) { console.error("OLD_SUPABASE_URL no corresponde al proyecto viejo"); process.exit(2); }
if (!NEW_URL.includes(NEW_REF) || NEW_URL.includes(OLD_REF)) { console.error("NEW_SUPABASE_URL no corresponde al proyecto nuevo"); process.exit(2); }

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const VERIFY = args.includes("--verify");
const bIdx = args.indexOf("--buckets");
const ONLY = bIdx >= 0 ? (args[bIdx + 1] || "").split(",").filter(Boolean) : null;
const CONCURRENCY = 4;

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const oldC = createClient(OLD_URL, OLD_KEY, opts);
const newC = createClient(NEW_URL, NEW_KEY, opts);

// Lista recursiva: devuelve Map ruta -> { size, mimetype, cacheControl }
async function listAll(client, bucket) {
  const out = new Map();
  const queue = [""];
  while (queue.length) {
    const prefix = queue.shift();
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await client.storage.from(bucket).list(prefix, {
        limit: 1000, offset, sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const it of data) {
        const full = prefix ? `${prefix}/${it.name}` : it.name;
        if (it.id === null || it.id === undefined) queue.push(full); // carpeta
        else out.set(full, {
          size: Number(it.metadata?.size ?? -1),
          mimetype: it.metadata?.mimetype || "application/octet-stream",
          cacheControl: it.metadata?.cacheControl || null,
        });
      }
      if (data.length < 1000) break;
    }
  }
  return out;
}

async function pool(items, worker) {
  let i = 0, failures = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try { await worker(item); } catch (e) { failures++; console.error(`   FALLA ${item[0]}: ${e.message}`); }
    }
  }));
  return failures;
}

const fmt = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : (n / 1024).toFixed(1) + " KB");

async function main() {
  console.log(`\n== Storage: viejo ${OLD_REF} -> nuevo ${NEW_REF}   modo: ${VERIFY ? "VERIFICAR" : APPLY ? "COPIAR (--apply)" : "SIMULACRO"}`);
  const { data: oldBuckets, error: be } = await oldC.storage.listBuckets();
  if (be) throw new Error("listBuckets viejo: " + be.message);
  const { data: newBuckets, error: bn } = await newC.storage.listBuckets();
  if (bn) throw new Error("listBuckets nuevo: " + bn.message);
  const newById = new Map(newBuckets.map((b) => [b.id, b]));
  const buckets = oldBuckets.filter((b) => !ONLY || ONLY.includes(b.id));
  console.log("   buckets del viejo:", oldBuckets.map((b) => `${b.id}(${b.public ? "publico" : "privado"})`).join(", "));
  let problems = 0;

  for (const b of buckets) {
    console.log(`\n-- bucket ${b.id}  (${b.public ? "PUBLICO" : "PRIVADO"}, limite=${b.file_size_limit ?? "-"}, mime=${JSON.stringify(b.allowed_mime_types ?? null)})`);
    const nb = newById.get(b.id);

    if (!VERIFY) {
      const wanted = {
        public: b.public,
        ...(b.file_size_limit ? { fileSizeLimit: b.file_size_limit } : {}),
        ...(b.allowed_mime_types ? { allowedMimeTypes: b.allowed_mime_types } : {}),
      };
      // Los limites (tamano maximo / tipos MIME) se aplican DESPUES de copiar: hay archivos antiguos que los exceden
      // (p. ej. fotos de staff de 3 MB en un bucket con limite de 2 MB) y la subida fallaria.
      if (!nb) {
        if (!APPLY) console.log("   [SIMULACRO] crearia el bucket en el nuevo (sin limites hasta terminar la copia) y luego aplicaria", JSON.stringify(wanted));
        else {
          const { error } = await newC.storage.createBucket(b.id, { public: b.public });
          if (error) { console.error("   FALLA al crear bucket:", error.message); problems++; continue; }
          console.log("   bucket creado en el nuevo");
        }
      } else if (nb.public !== b.public) {
        if (!APPLY) console.log(`   [SIMULACRO] el bucket existe pero public difiere (viejo=${b.public}, nuevo=${nb.public}); lo corregiria`);
        else {
          const { error } = await newC.storage.updateBucket(b.id, wanted);
          if (error) { console.error("   FALLA al ajustar bucket:", error.message); problems++; } else console.log("   bucket ajustado");
        }
      } else console.log("   bucket ya existe en el nuevo con el mismo acceso");
    } else if (!nb) { console.error("   FALTA el bucket en el nuevo"); problems++; continue; }
    else if (nb.public !== b.public) { console.error(`   ACCESO DISTINTO: viejo public=${b.public}, nuevo public=${nb.public}`); problems++; }

    const oldFiles = await listAll(oldC, b.id);
    let newFiles = new Map();
    if (nb || APPLY) { try { newFiles = await listAll(newC, b.id); } catch (e) { if (APPLY) throw e; } }
    const totalBytes = [...oldFiles.values()].reduce((a, f) => a + Math.max(f.size, 0), 0);
    console.log(`   viejo: ${oldFiles.size} archivos (${fmt(totalBytes)})   nuevo: ${newFiles.size} archivos`);

    const todo = [...oldFiles.entries()].filter(([p, f]) => !(newFiles.has(p) && newFiles.get(p).size === f.size));

    if (VERIFY) {
      const missing = todo.filter(([p]) => !newFiles.has(p));
      const diff = todo.filter(([p]) => newFiles.has(p));
      const extra = [...newFiles.keys()].filter((p) => !oldFiles.has(p));
      console.log(`   faltan en el nuevo: ${missing.length}   tamano distinto: ${diff.length}   sobran en el nuevo: ${extra.length}`);
      missing.slice(0, 10).forEach(([p]) => console.error("   FALTA", p));
      diff.slice(0, 10).forEach(([p]) => console.error("   TAMANO DISTINTO", p));
      problems += missing.length + diff.length;
      continue;
    }

    console.log(`   por copiar: ${todo.length}   ya iguales: ${oldFiles.size - todo.length}`);
    if (!APPLY) { todo.slice(0, 5).forEach(([p, f]) => console.log(`   [SIMULACRO] copiaria ${p} (${fmt(Math.max(f.size, 0))})`)); if (todo.length > 5) console.log(`   ... y ${todo.length - 5} mas`); continue; }

    let done = 0;
    problems += await pool(todo, async ([p, f]) => {
      const { data: blob, error: de } = await oldC.storage.from(b.id).download(p);
      if (de) throw new Error("descarga: " + (de.message || de));
      const buf = Buffer.from(await blob.arrayBuffer());
      const cc = f.cacheControl && /max-age=(\d+)/.exec(f.cacheControl);
      const { error: ue } = await newC.storage.from(b.id).upload(p, buf, {
        contentType: f.mimetype || blob.type || "application/octet-stream",
        cacheControl: cc ? cc[1] : "3600",
        upsert: true,
      });
      if (ue) throw new Error("subida: " + ue.message);
      if (++done % 25 === 0) console.log(`   ... ${done}/${todo.length}`);
    });
    console.log(`   copiados: ${done}/${todo.length}`);
    // Recien ahora se fijan los limites del bucket (igual que el viejo).
    const finalOpts = {
      public: b.public,
      ...(b.file_size_limit ? { fileSizeLimit: b.file_size_limit } : {}),
      ...(b.allowed_mime_types ? { allowedMimeTypes: b.allowed_mime_types } : {}),
    };
    const { error: le } = await newC.storage.updateBucket(b.id, finalOpts);
    if (le) { console.error("   FALLA al fijar limites del bucket:", le.message); problems++; }
    else console.log("   limites del bucket aplicados:", JSON.stringify(finalOpts));
  }

  console.log(problems ? `\nRESULTADO: ${problems} problema(s). Revisa arriba.` : "\nRESULTADO: OK");
  if (!APPLY && !VERIFY) console.log("Era un simulacro. Para copiar de verdad agrega --apply.");
  process.exit(problems ? 1 : 0);
}
main().catch((e) => { console.error("\nERROR:", e.message); process.exit(1); });
