// Prueba de humo de dependencias: multer, sharp, axios (vía twilio), express /
// proxy-addr (trust proxy), express-rate-limit / ip-address.
// Arranca el server.js REAL con un Supabase falso, desde un directorio vacío y
// con credenciales de mentira (nada toca producción). Guarda un "snapshot" de
// lo observado para compararlo antes/después de actualizar cada librería.
//
//   node scripts/smoke-dependencies.js baseline        (ANTES de actualizar)
//   node scripts/smoke-dependencies.js after-multer    (compara contra baseline)
// Los snapshots quedan en el directorio temporal del sistema.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const Module = require("module");

const REPO = path.join(__dirname, "..").split(path.sep).join("/");
const LABEL = process.argv[2] || "run";
const SNAP_DIR = path.join(os.tmpdir(), "orbyx-smoke-snapshots");
fs.mkdirSync(SNAP_DIR, { recursive: true });

// --- entorno aislado
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
process.chdir(tmp); // sin .env ni token.json
Object.assign(process.env, {
  PORT: "3998",
  NODE_ENV: "test",
  SUPABASE_URL: "http://localhost",
  SUPABASE_SERVICE_ROLE_KEY: "x",
  RESEND_API_KEY: "re_dummy",
  TWILIO_ACCOUNT_SID: "ACtest0000000000000000000000000000",
  TWILIO_API_KEY_SID: "SKtest0000000000000000000000000000",
  TWILIO_API_KEY_SECRET: "secretsecret",
  TWILIO_WHATSAPP_NUMBER: "whatsapp:+56900000000",
});

const results = {};
let fails = 0;
const rec = (name, value) => {
  results[name] = value;
};
const ok = (cond, label, extra = "") => {
  if (!cond) fails++;
  console.log(`T| ${cond ? "OK  " : "FAIL"} ${label} ${extra}`);
};

// --- servidor mock de Twilio (lo que verá axios)
const twilioRequests = [];
const twilioMock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    twilioRequests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const params = new URLSearchParams(body);
    if ((params.get("To") || "").includes("+56911110000")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ code: 21211, message: "Invalid 'To' Phone Number", more_info: "https://www.twilio.com/docs/errors/21211", status: 400 }));
    }
    if (decodeURIComponent(req.url + body).includes("+56922220000")) {
      return; // no responde nunca → prueba de timeout
    }
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sid: "SM" + "a".repeat(32), status: "queued", to: params.get("To") }));
  });
});
const twilioPort = 4010;

// --- Supabase falso
const TENANT = { id: "11111111-1111-1111-1111-111111111111", slug: "demo", plan_slug: "business", plan: "business", is_active: true, name: "Demo" };
function makeBuilder(table) {
  const state = { single: false };
  const result = () => {
    if (table === "tenants") return { data: state.single ? TENANT : [TENANT], error: null, count: 1 };
    if (table === "tenant_users") return { data: { tenant_id: TENANT.id, role: "owner", is_active: true, permissions: null }, error: null };
    if (table === "customers") return { data: [], error: null };
    if (state.single) return { data: { id: "row-1", public_url: "https://example.test/img.webp" }, error: null };
    return { data: [], error: null, count: 0 };
  };
  const b = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (resolve, reject) => Promise.resolve(result()).then(resolve, reject);
      if (prop === "single" || prop === "maybeSingle") return () => { state.single = true; return Promise.resolve(result()); };
      if (prop === "range") return (from) => Promise.resolve(from === 0 ? result() : { data: [], error: null });
      return () => b;
    },
  });
  return b;
}
const uploaded = [];
const fakeSupabase = {
  from: (t) => makeBuilder(t),
  rpc: async () => ({ data: null, error: null }),
  auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }), admin: {} },
  storage: {
    from: (bucket) => ({
      upload: async (p, buf, opts) => {
        uploaded.push({ bucket, path: p, bytes: buf.length, contentType: opts?.contentType });
        return { data: { path: p }, error: null };
      },
      getPublicUrl: (p) => ({ data: { publicUrl: `https://example.test/${bucket}/${p}` } }),
      remove: async () => ({ data: null, error: null }),
    }),
  },
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@supabase/supabase-js") return { createClient: () => fakeSupabase };
  if (request === "express") {
    const express = origLoad.apply(this, arguments);
    const wrapped = function () {
      const app = express.apply(this, arguments);
      app.get("/__ip", (req, res) => res.json({ ip: req.ip, ips: req.ips }));
      return app;
    };
    return Object.assign(wrapped, express);
  }
  if (request === "twilio") {
    const real = origLoad.apply(this, arguments);
    const wrapped = function (...args) {
      const client = real(...args);
      client.api.baseUrl = `http://127.0.0.1:${twilioPort}`;
      return client;
    };
    Object.setPrototypeOf(wrapped, real);
    return Object.assign(wrapped, real);
  }
  return origLoad.apply(this, arguments);
};

function pngNoise(w, h, channels = 4, alphaHole = false) {
  const sharp = require(REPO + "/node_modules/sharp");
  const raw = Buffer.alloc(w * h * channels);
  let seed = 12345;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = (seed >> 16) & 0xff;
  }
  if (alphaHole && channels === 4) {
    for (let i = 0; i < w * h; i++) raw[i * 4 + 3] = i % w < w / 2 ? 0 : 255; // mitad transparente
  }
  return { sharp, raw };
}

async function main() {
  await new Promise((r) => twilioMock.listen(twilioPort, "127.0.0.1", r));
  require(REPO + "/server.js");
  await new Promise((r) => setTimeout(r, 2000));

  const BASE = "http://127.0.0.1:3998";
  const auth = { Authorization: "Bearer t" };
  const post = async (p, body, headers = auth) => {
    const res = await fetch(BASE + p, { method: "POST", headers, body });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  const filePart = (buf, name, type, extra = {}) => {
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type }), name);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return fd;
  };

  // ============ SHARP ============
  console.log("== sharp (imageCompression.js)");
  const { compressImage } = require(REPO + "/imageCompression.js");
  const sharp = require(REPO + "/node_modules/sharp");
  rec("sharp.version", sharp.versions.sharp);
  rec("sharp.vips", sharp.versions.vips);

  const { raw: rawJpg } = pngNoise(3000, 2000, 3);
  const jpg = await sharp(rawJpg, { raw: { width: 3000, height: 2000, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  const { raw: rawPng } = pngNoise(1200, 800, 4, true);
  const png = await sharp(rawPng, { raw: { width: 1200, height: 800, channels: 4 } }).png().toBuffer();
  const rotated = await sharp(rawJpg, { raw: { width: 1600, height: 900, channels: 3 } }).jpeg().withMetadata({ orientation: 6 }).toBuffer().catch(async () =>
    sharp({ create: { width: 1600, height: 900, channels: 3, background: "#336699" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer()
  );

  for (const [label, buf] of [["jpg", jpg], ["png", png]]) {
    for (const profile of ["avatar", "campana", "documento"]) {
      const out = await compressImage(buf, profile);
      const meta = await sharp(out.buffer).metadata();
      rec(`sharp.${label}.${profile}`, {
        format: meta.format, width: meta.width, height: meta.height, hasAlpha: !!meta.hasAlpha,
        contentType: out.contentType, extension: out.extension, bytes: out.buffer.length, smaller: out.buffer.length <= buf.length,
      });
      ok(["webp", "jpeg"].includes(meta.format) && meta.width <= 2200, `sharp ${label}→${profile}`, `${meta.format} ${meta.width}x${meta.height} ${out.buffer.length}B`);
    }
  }
  const pngAvatar = results["sharp.png.avatar"];
  ok(pngAvatar.hasAlpha === true, "PNG con transparencia conserva alfa en avatar (webp)");
  const rotOut = await compressImage(rotated, "documento");
  const rotMeta = await sharp(rotOut.buffer).metadata();
  rec("sharp.exif-rotate", { width: rotMeta.width, height: rotMeta.height });
  ok(rotMeta.height > rotMeta.width, "EXIF orientación 6 se corrige (queda vertical)", `${rotMeta.width}x${rotMeta.height}`);
  // entrada inválida debe fallar igual que antes
  let badErr = null;
  try { await compressImage(Buffer.from("no soy una imagen"), "avatar"); } catch (e) { badErr = e.message.slice(0, 60); }
  rec("sharp.invalid-input", { threw: !!badErr });
  ok(!!badErr, "entrada inválida lanza error", badErr || "");

  // ============ AXIOS (twilio) ============
  console.log("== axios vía twilio (whatsapp.js real contra mock)");
  const { sendWhatsAppTemplate } = require(REPO + "/whatsapp.js");
  twilioRequests.length = 0;
  const okRes = await sendWhatsAppTemplate({ to: "+56933330000", contentSid: "HX123", variables: { 1: "Ana", 2: "Demo" } });
  rec("twilio.send-ok", { ok: okRes.ok, hasSid: /^SM/.test(okRes.sid || "") });
  ok(okRes.ok && /^SM/.test(okRes.sid), "envío OK → { ok:true, sid }", JSON.stringify(okRes));
  const reqOk = twilioRequests[0];
  const params = new URLSearchParams(reqOk?.body || "");
  rec("twilio.request", {
    method: reqOk?.method,
    path: (reqOk?.url || "").replace(/AC[a-z0-9]+/i, "AC…"),
    contentType: reqOk?.headers["content-type"],
    authBasicOk: reqOk?.headers.authorization === "Basic " + Buffer.from("SKtest0000000000000000000000000000:secretsecret").toString("base64"),
    userAgentTwilio: /twilio-node/.test(reqOk?.headers["user-agent"] || ""),
    acceptJson: /json/.test(reqOk?.headers.accept || ""),
    fields: Object.fromEntries([...params.entries()].filter(([k]) => k !== "StatusCallback")),
    statusCallback: params.get("StatusCallback"),
  });
  ok(reqOk.method === "POST" && reqOk.headers["content-type"].startsWith("application/x-www-form-urlencoded"), "POST form-urlencoded", reqOk.headers["content-type"]);
  ok(results["twilio.request"].authBasicOk, "Authorization Basic (API Key) intacto");
  ok(params.get("From") === "whatsapp:+56900000000" && params.get("To") === "whatsapp:+56933330000" && params.get("ContentSid") === "HX123", "campos From/To/ContentSid");
  ok(JSON.parse(params.get("ContentVariables"))["1"] === "Ana", "ContentVariables JSON");

  const errRes = await sendWhatsAppTemplate({ to: "+56911110000", contentSid: "HX123", variables: {} });
  rec("twilio.send-400", { ok: errRes.ok, reason: errRes.reason, error: errRes.error });
  ok(errRes.ok === false && errRes.reason === "send_error" && /Invalid 'To'/.test(errRes.error), "error 400 → { ok:false, reason:'send_error' }", JSON.stringify(errRes));

  // Cliente HTTP de twilio directo: timeout configurado y errores de red
  const twilio = require(REPO + "/node_modules/twilio");
  const rc = new twilio.RequestClient({ timeout: 1000 });
  const t0 = Date.now();
  let timeoutErr = null;
  let timeoutRes = null;
  try {
    timeoutRes = await rc.request({ method: "POST", uri: `http://127.0.0.1:${twilioPort}/x?To=whatsapp:%2B56922220000`, timeout: 800 });
  } catch (e) { timeoutErr = e; }
  if (!timeoutErr) console.log("T| debug respuesta inesperada", JSON.stringify(timeoutRes).slice(0, 200), JSON.stringify(twilioRequests.at(-1)).slice(0, 300));
  const dt = Date.now() - t0;
  rec("twilio.timeout", { threw: !!timeoutErr, fastEnough: dt < 3000 });
  ok(!!timeoutErr && dt < 3000, "timeout del request se respeta", `${dt}ms ${timeoutErr?.code || timeoutErr?.message || ""}`);
  let refused = null;
  try { await rc.request({ method: "GET", uri: "http://127.0.0.1:1/nada" }); } catch (e) { refused = e; }
  rec("twilio.conn-refused", { threw: !!refused, code: refused?.code || null });
  ok(!!refused, "conexión rechazada lanza error", String(refused?.code || refused?.message).slice(0, 50));

  // ============ EXPRESS / proxy-addr ============
  console.log("== express: trust proxy / req.ip");
  const ipCases = [
    ["sin XFF", {}],
    ["XFF 1 hop", { "X-Forwarded-For": "5.5.5.5" }],
    ["XFF cliente falsea + proxy agrega", { "X-Forwarded-For": "9.9.9.9, 5.5.5.5" }],
    ["XFF cadena larga", { "X-Forwarded-For": "1.1.1.1, 2.2.2.2, 3.3.3.3" }],
    ["XFF IPv4-mapped IPv6", { "X-Forwarded-For": "::ffff:5.5.5.5" }],
    ["XFF IPv6", { "X-Forwarded-For": "2001:db8::1" }],
  ];
  for (const [name, headers] of ipCases) {
    const res = await fetch(BASE + "/__ip", { headers });
    const j = await res.json();
    rec(`ip.${name}`, { ip: j.ip, ips: j.ips });
    console.log(`T| info ip ${name}: ip=${j.ip} ips=${JSON.stringify(j.ips)}`);
  }
  ok(results["ip.XFF 1 hop"].ip === "5.5.5.5", "trust proxy=1: toma la IP que agregó el proxy");
  ok(results["ip.XFF cliente falsea + proxy agrega"].ip === "5.5.5.5", "una IP falsa a la izquierda no la reemplaza");
  ok(results["ip.XFF cadena larga"].ip === "3.3.3.3", "con 1 hop de confianza usa el último valor");

  // ============ RATE LIMIT ============
  console.log("== express-rate-limit / ip-address");
  const hit = (xff) => fetch(BASE + "/public/business/demo", { headers: { "X-Forwarded-For": xff } }).then((r) => r.status);
  let tooMany = 0;
  let firstLimited = null;
  for (let i = 1; i <= 110; i++) {
    const s = await hit("7.7.7.7");
    if (s === 429) {
      tooMany++;
      if (firstLimited === null) firstLimited = i;
    }
  }
  rec("rl.ipv4", { firstLimited, tooMany });
  ok(firstLimited === 101, "publicLimiter corta en la petición 101 (max 100/min)", `primera 429 = ${firstLimited}`);
  const other = await hit("8.8.8.8");
  rec("rl.other-ip", { status: other });
  ok(other !== 429, "otra IP no comparte el cupo");

  let v6first = null;
  for (let i = 1; i <= 105; i++) {
    const s = await hit("2001:db8:aaaa:bbbb::1");
    if (s === 429 && v6first === null) v6first = i;
  }
  const v6neighbor = await hit("2001:db8:aaaa:bbbb::2"); // misma subred /56
  const v6far = await hit("2001:db8:ffff:ffff::1"); // otra subred
  rec("rl.ipv6", { firstLimited: v6first, neighborLimited: v6neighbor === 429, farLimited: v6far === 429 });
  ok(v6first === 101 && v6neighbor === 429 && v6far !== 429, "IPv6: misma subred /56 comparte cupo, otra subred no", JSON.stringify(results["rl.ipv6"]));

  // ============ MULTER ============
  console.log("== multer: subida de imágenes");
  const smallPng = await sharp(pngNoise(300, 300, 3).raw, { raw: { width: 300, height: 300, channels: 3 } }).png().toBuffer();
  const smallJpg = await sharp(pngNoise(500, 400, 3).raw, { raw: { width: 500, height: 400, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
  uploaded.length = 0;

  let r = await post("/upload/campaign-image", filePart(smallPng, "a.png", "image/png", { slug: "demo" }));
  rec("multer.campaign.png", { status: r.status, hasImage: !!r.json?.image, uploadedContentType: uploaded.at(-1)?.contentType });
  ok(r.status === 200 && r.json?.image, "campaign-image PNG → 200", `(${r.status}) ${uploaded.at(-1)?.contentType}`);

  r = await post("/upload/campaign-image", filePart(smallJpg, "b.jpg", "image/jpeg", { slug: "demo" }));
  rec("multer.campaign.jpg", { status: r.status, hasImage: !!r.json?.image });
  ok(r.status === 200, "campaign-image JPG → 200");

  r = await post("/upload/campaign-image", filePart(Buffer.from("hola"), "x.txt", "text/plain", { slug: "demo" }));
  rec("multer.campaign.bad-mime", { status: r.status, error: r.json?.error });
  ok(r.status === 400 && r.json?.error === "Formato inválido", "campaign-image mime inválido → 400", r.json?.error);

  const big2 = Buffer.alloc(2 * 1024 * 1024 + 10, 7);
  r = await post("/upload/campaign-image", filePart(big2, "big.png", "image/png", { slug: "demo" }));
  rec("multer.campaign.too-big", { status: r.status, body: (r.json?.error || r.text || "").slice(0, 80) });
  console.log(`T| info campaign >2MB → ${r.status} ${(r.json?.error || r.text || "").slice(0, 80)}`);
  ok(r.status >= 400, "campaign-image >2 MB se rechaza", `(${r.status})`);

  const fdNoFile = new FormData();
  fdNoFile.append("slug", "demo");
  r = await post("/upload/campaign-image", fdNoFile);
  rec("multer.campaign.no-file", { status: r.status, error: r.json?.error });
  ok(r.status === 400, "campaign-image sin archivo → 400", r.json?.error);

  r = await post("/upload/ticket-attachment", filePart(smallJpg, "t.jpg", "image/jpeg", { tenant_id: TENANT.id }));
  rec("multer.ticket.jpg", { status: r.status, hasUrl: !!r.json?.url });
  ok(r.status === 200 && r.json?.url, "ticket-attachment JPG → 200", `(${r.status}) ${r.text.slice(0, 60)}`);

  const big1 = Buffer.alloc(1 * 1024 * 1024 + 10, 7);
  r = await post("/upload/ticket-attachment", filePart(big1, "big.jpg", "image/jpeg", { tenant_id: TENANT.id }));
  rec("multer.ticket.too-big", { status: r.status, body: (r.json?.error || r.text || "").slice(0, 80) });
  console.log(`T| info ticket >1MB → ${r.status} ${(r.json?.error || r.text || "").slice(0, 80)}`);
  ok(r.status >= 400, "ticket-attachment >1 MB se rechaza", `(${r.status})`);

  r = await post("/upload/ticket-attachment", filePart(Buffer.from("hola"), "x.txt", "text/plain", { tenant_id: TENANT.id }));
  rec("multer.ticket.bad-mime", { status: r.status, error: r.json?.error });
  ok(r.status === 400, "ticket-attachment mime inválido → 400");

  console.log("== multer: importador de clientes (xlsx/csv)");
  const xlsx = fs.readFileSync(REPO + "/samples/importar-clientes-prueba.xlsx");
  const csv = fs.readFileSync(REPO + "/samples/importar-clientes-prueba.csv");
  r = await post("/customers/import/demo/preview", filePart(xlsx, "importar-clientes-prueba.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
  rec("multer.import.xlsx", { status: r.status, new: r.json?.summary?.new_count, errors: r.json?.summary?.error_count });
  ok(r.status === 200 && r.json.summary.new_count === 10, "import xlsx → 200 (10 nuevas sin existentes)", JSON.stringify(r.json?.summary || r.json));
  r = await post("/customers/import/demo/preview", filePart(csv, "importar-clientes-prueba.csv", "text/csv"));
  rec("multer.import.csv", { status: r.status, new: r.json?.summary?.new_count });
  ok(r.status === 200 && r.json.summary.new_count === 10, "import csv → 200");
  const big5 = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41);
  r = await post("/customers/import/demo/preview", filePart(big5, "grande.csv", "text/csv"));
  rec("multer.import.too-big", { status: r.status, code: r.json?.code, error: r.json?.error });
  ok(r.status === 400 && r.json?.code === "too_big", "import >5 MB → 400 too_big", r.json?.error);
  r = await post("/customers/import/demo/preview", filePart(xlsx, "datos.xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12"));
  rec("multer.import.xlsm", { status: r.status });
  ok(r.status === 400, "import .xlsm → 400");
  const manyFields = new FormData();
  manyFields.append("file", new Blob([csv], { type: "text/csv" }), "a.csv");
  for (let i = 0; i < 15; i++) manyFields.append("campo" + i, "x");
  r = await post("/customers/import/demo/preview", manyFields);
  rec("multer.import.too-many-fields", { status: r.status });
  console.log(`T| info import con 15 campos → ${r.status}`);

  // ============ snapshot ============
  const snapFile = path.join(SNAP_DIR, `${LABEL}.json`);
  fs.writeFileSync(snapFile, JSON.stringify(results, null, 2));
  console.log(`\nSnapshot: ${snapFile}`);

  const basePath = path.join(SNAP_DIR, "baseline.json");
  if (LABEL !== "baseline" && fs.existsSync(basePath)) {
    const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
    const diffs = [];
    const norm = (v) => JSON.stringify(v, (k, x) => (k === "bytes" ? undefined : x));
    for (const key of new Set([...Object.keys(base), ...Object.keys(results)])) {
      if (key.startsWith("sharp.version") || key === "sharp.vips") continue;
      if (norm(base[key]) !== norm(results[key])) diffs.push(`${key}: ${norm(base[key])} → ${norm(results[key])}`);
      if (base[key]?.bytes && results[key]?.bytes) {
        const ratio = results[key].bytes / base[key].bytes;
        if (ratio < 0.9 || ratio > 1.1) diffs.push(`${key}.bytes: ${base[key].bytes} → ${results[key].bytes}`);
      }
    }
    console.log(diffs.length === 0 ? "COMPARACIÓN vs baseline: SIN DIFERENCIAS" : "COMPARACIÓN vs baseline: DIFERENCIAS\n  " + diffs.join("\n  "));
    if (diffs.length) fails++;
  }
  console.log(fails === 0 ? "\nRESULTADO: TODO OK" : `\nRESULTADO: ${fails} FALLAS`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("ERROR en la prueba", e);
  process.exit(1);
});
