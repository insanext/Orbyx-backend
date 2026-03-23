// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const crypto = require("crypto");
const { supabase } = require("./supabaseClient");
const { sendBookingEmail } = require("./email");

const app = express();

function getPlanCapabilities(plan) {
  const plans = {
    starter: { max_staff: 1, max_services: 3 },
    pro: { max_staff: 3, max_services: 10 },
    premium: { max_staff: 10, max_services: 999 },
    vip: { max_staff: 999, max_services: 999 },
  };

  return plans[plan] || plans.starter;
}

async function getStaffCount(tenant_id) {
  const { count, error } = await supabase
    .from("staff")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenant_id);

  if (error) throw error;

  return count || 0;
}

async function getPlan(tenant_id) {
  const { data, error } = await supabase
    .from("tenants")
    .select("plan_slug, plan")
    .eq("id", tenant_id)
    .single();

  if (error) throw error;

  return (data?.plan_slug || data?.plan || "starter").toLowerCase();
}

async function getServicesCount(tenant_id) {
  const { count, error } = await supabase
    .from("services")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenant_id);

  if (error) throw error;

  return count || 0;
}

/* ======================================================
   ✅ CORS (ROBUSTO)
====================================================== */
const ALLOWED_ORIGINS = new Set([
  "https://app.orbyx.cl",
  "https://orbyx-dashboard.vercel.app",
  "https://www.orbyx.cl",
  "https://orbyx.cl",
  "https://orbyx-web.vercel.app",
]);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);

    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);

    if (/^https:\/\/.*\.vercel\.app$/.test(origin)) return cb(null, true);

    return cb(new Error("Not allowed by CORS: " + origin));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 🔐 Credenciales OAuth
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

// ✅ Compatibilidad
const CLIENTE_FIJO = "cliente_demo";
const CAL_FIJO = "principal";

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

async function getMainBranchByTenantId(tenant_id) {
  const { data, error } = await supabase
    .from("branches")
    .select("id, tenant_id, name, slug, is_active, created_at")
    .eq("tenant_id", tenant_id)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (error || !data) {
    throw new Error(`No se encontró sucursal activa para tenant_id=${tenant_id}`);
  }

  return data;
}

async function getBranchById(branch_id) {
  const { data, error } = await supabase
    .from("branches")
    .select("id, tenant_id, name, slug, address, phone, is_active, created_at")
    .eq("id", branch_id)
    .single();

  if (error || !data) {
    throw new Error(`Sucursal no encontrada para branch_id=${branch_id}`);
  }

  return data;
}

async function resolveBranchId({ tenant_id, branch_id }) {
  if (branch_id) {
    const branch = await getBranchById(branch_id);

    if (branch.tenant_id !== tenant_id) {
      throw new Error("La sucursal no pertenece al tenant enviado");
    }

    if (!branch.is_active) {
      throw new Error("La sucursal está inactiva");
    }

    return branch.id;
  }

  const mainBranch = await getMainBranchByTenantId(tenant_id);
  return mainBranch.id;
}

console.log("✅ Iniciado sin token.json. Tokens se leerán desde Supabase.");
console.log("🔥 VERSION: SAAS_TOKEN_BY_CALENDAR_ID + OAUTH REDIRECT TO FRONTEND");

/* ======================================================
   ✅ HELPERS GENERALES
====================================================== */
function parseDateToWeekday(dateStr) {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay();
}

function timeToMinutes(value) {
  if (!value) return null;
  const [h, m] = String(value).slice(0, 5).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function isoToMinutesInDate(iso, dateStr) {
  const d = new Date(iso);

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const localDate = `${yyyy}-${mm}-${dd}`;

  if (localDate !== dateStr) return null;

  return d.getHours() * 60 + d.getMinutes();
}

function subtractRange(windows, blockStart, blockEnd) {
  const result = [];

  for (const window of windows) {
    const start = window.start;
    const end = window.end;

    if (blockEnd <= start || blockStart >= end) {
      result.push(window);
      continue;
    }

    if (blockStart > start) {
      result.push({ start, end: blockStart });
    }

    if (blockEnd < end) {
      result.push({ start: blockEnd, end });
    }
  }

  return result.filter((w) => w.end > w.start);
}

function intersectWindows(a, b) {
  const result = [];

  for (const wa of a || []) {
    for (const wb of b || []) {
      const start = Math.max(wa.start, wb.start);
      const end = Math.min(wa.end, wb.end);

      if (end > start) {
        result.push({ start, end });
      }
    }
  }

  return result.sort((x, y) => x.start - y.start);
}

function buildSlotsFromWindows(windows, date, slotMinutes) {
  const slots = [];

  for (const window of windows || []) {
    let cursor = window.start;

    while (cursor + slotMinutes <= window.end) {
      const startHour = String(Math.floor(cursor / 60)).padStart(2, "0");
      const startMinute = String(cursor % 60).padStart(2, "0");

      const endCursor = cursor + slotMinutes;
      const endHour = String(Math.floor(endCursor / 60)).padStart(2, "0");
      const endMinute = String(endCursor % 60).padStart(2, "0");

      const startDate = new Date(`${date}T${startHour}:${startMinute}:00-03:00`);
      const endDate = new Date(`${date}T${endHour}:${endMinute}:00-03:00`);

      slots.push({
        slot_start: startDate.toISOString(),
        slot_end: endDate.toISOString(),
      });

      cursor += slotMinutes;
    }
  }

  return slots;
}

async function getStaffAvailabilityWindows({
  tenant_id,
  branch_id,
  staff_id,
  date,
}) {
  const weekday = parseDateToWeekday(date);

  const { data: staffRow, error: staffError } = await supabase
    .from("staff")
    .select("id, tenant_id, branch_id, use_business_hours, is_active")
    .eq("tenant_id", tenant_id)
    .eq("branch_id", branch_id)
    .eq("id", staff_id)
    .single();

  if (staffError) throw staffError;

  if (!staffRow || !staffRow.is_active) {
    return [];
  }

  let windows = [];

  if (staffRow.use_business_hours) {
    const businessWindows = await getBusinessAvailabilityWindows({
      tenant_id,
      branch_id,
      date,
    });

    windows = businessWindows;
  } else {
    const { data: weeklyRows, error: weeklyError } = await supabase
      .from("staff_hours")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("branch_id", branch_id)
      .eq("staff_id", staff_id)
      .eq("day_of_week", weekday);

    if (weeklyError) throw weeklyError;

    const weekly = weeklyRows?.[0] || null;

    if (weekly?.enabled && weekly.start_time && weekly.end_time) {
      const weeklyStart = timeToMinutes(weekly.start_time);
      const weeklyEnd = timeToMinutes(weekly.end_time);

      if (
        weeklyStart !== null &&
        weeklyEnd !== null &&
        weeklyEnd > weeklyStart
      ) {
        windows = [{ start: weeklyStart, end: weeklyEnd }];
      }
    }
  }

  const { data: specialRows, error: specialError } = await supabase
    .from("staff_special_dates")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("branch_id", branch_id)
    .eq("staff_id", staff_id)
    .eq("date", date)
    .order("created_at", { ascending: true });

  if (specialError) throw specialError;

  const specialDates = specialRows || [];

  const fullDayClosed = specialDates.some(
    (row) => row.is_closed && !row.start_time && !row.end_time
  );

  if (fullDayClosed) {
    return [];
  }

  const openWindows = specialDates
    .filter((row) => !row.is_closed && row.start_time && row.end_time)
    .map((row) => ({
      start: timeToMinutes(row.start_time),
      end: timeToMinutes(row.end_time),
    }))
    .filter(
      (row) => row.start !== null && row.end !== null && row.end > row.start
    );

  if (openWindows.length > 0) {
    windows = openWindows;
  }

  const partialClosedWindows = specialDates
    .filter((row) => row.is_closed && row.start_time && row.end_time)
    .map((row) => ({
      start: timeToMinutes(row.start_time),
      end: timeToMinutes(row.end_time),
    }))
    .filter(
      (row) => row.start !== null && row.end !== null && row.end > row.start
    );

  for (const blocked of partialClosedWindows) {
    windows = subtractRange(windows, blocked.start, blocked.end);
  }

  return windows.sort((a, b) => a.start - b.start);
}

async function subtractAppointmentsFromWindows({
  tenant_id,
  branch_id,
  staff_id,
  date,
  windows,
}) {
  const start = `${date}T00:00:00`;
  const end = `${date}T23:59:59`;

  let query = supabase
    .from("appointments")
    .select("id, start_at, end_at, staff_id, status")
    .eq("tenant_id", tenant_id)
    .eq("branch_id", branch_id)
    .eq("status", "booked")
    .gte("start_at", start)
    .lte("start_at", end)
    .order("start_at", { ascending: true });

  if (staff_id) {
    query = query.eq("staff_id", staff_id);
  }

  const { data: appointments, error } = await query;

  if (error) throw error;

  let result = [...(windows || [])];

  for (const appt of appointments || []) {
    const apptStart = isoToMinutesInDate(appt.start_at, date);
    const apptEnd = isoToMinutesInDate(appt.end_at, date);

    if (apptStart === null || apptEnd === null) continue;

    result = subtractRange(result, apptStart, apptEnd);
  }

  return result;
}

async function getServiceStaffIds({ tenant_id, branch_id, service_id }) {
  const { data, error } = await supabase
    .from("staff_services")
    .select("staff_id")
    .eq("tenant_id", tenant_id)
    .eq("branch_id", branch_id)
    .eq("service_id", service_id);

  if (error) throw error;

  return [...new Set((data || []).map((row) => row.staff_id).filter(Boolean))];
}

async function getBusinessAvailabilityWindows({ tenant_id, branch_id, date }) {
  const weekday = parseDateToWeekday(date);

  const { data: weeklyRows, error: weeklyError } = await supabase
    .from("business_hours")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("branch_id", branch_id)
    .eq("day_of_week", weekday);

  if (weeklyError) throw weeklyError;

  const weekly = weeklyRows?.[0] || null;

  let windows = [];

  if (weekly?.enabled && weekly.start_time && weekly.end_time) {
    const weeklyStart = timeToMinutes(weekly.start_time);
    const weeklyEnd = timeToMinutes(weekly.end_time);

    if (
      weeklyStart !== null &&
      weeklyEnd !== null &&
      weeklyEnd > weeklyStart
    ) {
      windows = [{ start: weeklyStart, end: weeklyEnd }];
    }
  }

  const { data: specialRows, error: specialError } = await supabase
    .from("business_special_dates")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("branch_id", branch_id)
    .eq("date", date)
    .order("created_at", { ascending: true });

  if (specialError) throw specialError;

  const specialDates = specialRows || [];

  const fullDayClosed = specialDates.some(
    (row) => row.is_closed && !row.start_time && !row.end_time
  );

  if (fullDayClosed) {
    return [];
  }

  const openWindows = specialDates
    .filter((row) => !row.is_closed && row.start_time && row.end_time)
    .map((row) => ({
      start: timeToMinutes(row.start_time),
      end: timeToMinutes(row.end_time),
    }))
    .filter(
      (row) => row.start !== null && row.end !== null && row.end > row.start
    );

  if (openWindows.length > 0) {
    windows = openWindows;
  }

  const partialClosedWindows = specialDates
    .filter((row) => row.is_closed && row.start_time && row.end_time)
    .map((row) => ({
      start: timeToMinutes(row.start_time),
      end: timeToMinutes(row.end_time),
    }))
    .filter(
      (row) => row.start !== null && row.end !== null && row.end > row.start
    );

  for (const blocked of partialClosedWindows) {
    windows = subtractRange(windows, blocked.start, blocked.end);
  }

  return windows.sort((a, b) => a.start - b.start);
}

function filterPastSlots(slots, minNoticeMinutes = 0) {
  if (!Array.isArray(slots) || slots.length === 0) return [];

  const now = new Date();
  const limit = new Date(now.getTime() + minNoticeMinutes * 60 * 1000);

  return slots.filter((slot) => {
    const start = new Date(slot.slot_start);
    return start.getTime() >= limit.getTime();
  });
}
/* ======================================================
   ✅ Helper: obtener Google Calendar desde calendar_tokens usando calendar_id
====================================================== */
async function getGoogleCalendarClientByCalendarId(calendar_id) {
  const { data: tokenRow, error: tokErr } = await supabase
    .from("calendar_tokens")
    .select("refresh_token, google_calendar_id")
    .eq("calendar_id", calendar_id)
    .single();

  if (tokErr) throw tokErr;

  if (!tokenRow?.refresh_token) {
    throw new Error(
      "⚠️ Este calendar_id no tiene token Google. Debes autorizarlo primero en /auth?calendar_id=..."
    );
  }

  oAuth2Client.setCredentials({ refresh_token: tokenRow.refresh_token });

  const calendar = google.calendar({ version: "v3", auth: oAuth2Client });
  const googleCalendarId = tokenRow.google_calendar_id || "primary";

  return { calendar, googleCalendarId };
}

/* ======================================================
   ✅ Helper (fallback): buscar token por CLIENTE_FIJO/CAL_FIJO
====================================================== */
async function getGoogleCalendarClientFixed() {
  const { data: tokenRow, error: tokErr } = await supabase
    .from("calendar_tokens")
    .select("*")
    .eq("client_id", CLIENTE_FIJO)
    .eq("calendar_name", CAL_FIJO)
    .single();

  if (tokErr) throw tokErr;

  if (!tokenRow?.refresh_token) {
    throw new Error("⚠️ No hay refresh_token en Supabase. Entra a /auth primero.");
  }

  oAuth2Client.setCredentials({ refresh_token: tokenRow.refresh_token });

  const calendar = google.calendar({ version: "v3", auth: oAuth2Client });
  const googleCalendarId = tokenRow.google_calendar_id || "primary";

  return { calendar, googleCalendarId };
}

/* ======================================================
   🔹 ENDPOINT: /auth
====================================================== */
app.get("/auth", async (req, res) => {
  try {
    const { calendar_id } = req.query;

    const stateObj = calendar_id
      ? { calendar_id: String(calendar_id) }
      : { calendar_id: null, fixed: true };

    const state = Buffer.from(JSON.stringify(stateObj)).toString("base64url");

    const url = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
      state,
    });

    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Conectar Google Calendar - Orbyx</title>

<style>
body{
  margin:0;
  font-family: system-ui, -apple-system, Segoe UI, Roboto;
  background:#f1f5f9;
  display:flex;
  align-items:center;
  justify-content:center;
  height:100vh;
}

.card{
  background:white;
  padding:40px;
  border-radius:16px;
  box-shadow:0 10px 30px rgba(0,0,0,0.1);
  width:420px;
  text-align:center;
}

h1{
  margin-bottom:10px;
  font-size:22px;
}

p{
  color:#64748b;
  font-size:14px;
  margin-bottom:25px;
}

.btn{
  display:inline-block;
  background:#111827;
  color:white;
  padding:12px 18px;
  border-radius:10px;
  text-decoration:none;
  font-weight:500;
}

.btn:hover{
  background:#374151;
}

.small{
  margin-top:20px;
  font-size:12px;
  color:#94a3b8;
}
</style>
</head>

<body>

<div class="card">

<h1>Conectar Google Calendar</h1>

<p>
Orbyx necesita acceso a tu Google Calendar para crear automáticamente
las reservas cuando un cliente agenda una cita.
</p>

<a class="btn" href="${url}">
Autorizar con Google
</a>

<div class="small">
Modo: ${calendar_id ? "SaaS" : "Compatibilidad"}
</div>

</div>

</body>
</html>
`);
  } catch (e) {
    res.status(500).send("Error en /auth: " + e.message);
  }
});

/* ======================================================
   🔹 ENDPOINT: /oauth2callback
====================================================== */
app.get("/oauth2callback", async (req, res) => {
  try {
    const code = req.query.code;
    const stateRaw = req.query.state;

    let state = {};
    try {
      if (stateRaw) {
        state = JSON.parse(
          Buffer.from(String(stateRaw), "base64url").toString("utf8")
        );
      }
    } catch (_) {
      state = {};
    }

    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    if (!tokens.refresh_token) {
      return res
        .status(400)
        .send(
          "⚠️ No vino refresh_token. Revoca acceso a la app en tu cuenta Google y reautoriza en /auth."
        );
    }

    // ✅ SaaS: guardar por calendar_id
    if (state?.calendar_id) {
      const calendar_id = state.calendar_id;

const { data: cal, error: calErr } = await supabase
  .from("calendars")
  .select("tenant_id")
  .eq("id", calendar_id)
  .single();

      if (calErr || !cal) {
        return res
          .status(404)
          .send("Calendario no encontrado en tu tabla calendars para calendar_id=" + calendar_id);
      }

      const { error } = await supabase.from("calendar_tokens").upsert(
        {
          tenant_id: cal.tenant_id,
          calendar_id,
          google_calendar_id: "primary",
          refresh_token: tokens.refresh_token,
          access_token: tokens.access_token ?? null,
          token_type: tokens.token_type ?? null,
          scope: tokens.scope ?? null,
          expiry_date: tokens.expiry_date ?? null,
        },
        { onConflict: "calendar_id" }
      );

      if (error) throw error;

      const { data: tenantData, error: tenantErr } = await supabase
        .from("tenants")
        .select("slug")
        .eq("id", cal.tenant_id)
        .single();

      if (tenantErr || !tenantData?.slug) {
        return res
          .status(500)
          .send("No se pudo obtener el slug del negocio después de conectar Google Calendar.");
      }

      const frontendUrl = "https://www.orbyx.cl";
      return res.redirect(
        `${frontendUrl}/dashboard/${tenantData.slug}?google_connected=1`
      );
    }

    // ✅ Compatibilidad: modo fijo
    const { error } = await supabase.from("calendar_tokens").upsert(
      {
        client_id: CLIENTE_FIJO,
        calendar_name: CAL_FIJO,
        google_calendar_id: "primary",
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token ?? null,
        token_type: tokens.token_type ?? null,
        scope: tokens.scope ?? null,
        expiry_date: tokens.expiry_date ?? null,
      },
      { onConflict: "client_id,calendar_name" }
    );

    if (error) throw error;

    res.send("✅ Autorizado y guardado en Supabase (modo fijo). Ahora entra a /test-event");
  } catch (error) {
    console.error(error);
    res.status(500).send("Error en OAuth callback: " + error.message);
  }
});

/* ======================================================
   🔹 ENDPOINT: /test-event
====================================================== */
app.get("/test-event", async (req, res) => {
  try {
    const { calendar_id } = req.query;

    const { calendar, googleCalendarId } = calendar_id
      ? await getGoogleCalendarClientByCalendarId(calendar_id)
      : await getGoogleCalendarClientFixed();

    const start = new Date(Date.now() + 5 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    const event = {
      summary: "Prueba Proyecto Independizar (Supabase)",
      description: calendar_id
        ? `Evento de prueba (SaaS) calendar_id=${calendar_id}`
        : "Evento de prueba (modo fijo)",
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    };

    const response = await calendar.events.insert({
      calendarId: googleCalendarId,
      requestBody: event,
    });

    res.send(`✅ Evento creado: <a href="${response.data.htmlLink}" target="_blank">Ver evento</a>`);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error creando evento: " + error.message);
  }
});

/* ======================================================
   ✅ GET /business-hours
====================================================== */
app.get("/business-hours", async (req, res) => {
  try {
    const { tenant_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    const { data, error } = await supabase
      .from("business_hours")
      .select("*")
      .eq("tenant_id", tenant_id)
      .order("day_of_week", { ascending: true });

    if (error) throw error;

    return res.json({ hours: data || [] });
  } catch (err) {
    console.error("GET /business-hours error:", err.message);
    return res.status(500).json({ error: "Error obteniendo horarios" });
  }
});

/* ======================================================
   ✅ PUT /business-hours
====================================================== */
app.put("/business-hours", async (req, res) => {
  try {
    const { tenant_id, hours } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!Array.isArray(hours)) {
      return res.status(400).json({ error: "hours debe ser un arreglo" });
    }

    const payload = hours.map((item) => ({
      tenant_id,
      day_of_week: Number(item.day_of_week),
      enabled: !!item.enabled,
      start_time: item.enabled ? item.start_time || null : null,
      end_time: item.enabled ? item.end_time || null : null,
      updated_at: new Date().toISOString(),
    }));

    const { data, error } = await supabase
      .from("business_hours")
      .upsert(payload, { onConflict: "tenant_id,day_of_week" })
      .select("*");

    if (error) throw error;

    return res.json({
      ok: true,
      message: "Horarios guardados correctamente",
      hours: data || [],
    });
  } catch (err) {
    console.error("PUT /business-hours error:", err.message);
    return res.status(500).json({ error: "Error guardando horarios" });
  }
});

/* ======================================================
   ✅ GET /business-special-dates
====================================================== */
app.get("/business-special-dates", async (req, res) => {
  try {
    const { tenant_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    const { data, error } = await supabase
      .from("business_special_dates")
      .select("*")
      .eq("tenant_id", tenant_id)
      .order("date", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) throw error;

    return res.json({ special_dates: data || [] });
  } catch (err) {
    console.error("GET /business-special-dates error:", err.message);
    return res.status(500).json({ error: "Error obteniendo fechas especiales" });
  }
});

/* ======================================================
   ✅ POST /business-special-dates
====================================================== */
app.post("/business-special-dates", async (req, res) => {
  try {
    const {
      tenant_id,
      date,
      label,
      is_closed,
      start_time,
      end_time,
    } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!date) {
      return res.status(400).json({ error: "date es obligatorio" });
    }

    const payload = {
      tenant_id,
      date,
      label: label || null,
      is_closed: !!is_closed,
      start_time: is_closed ? (start_time || null) : (start_time || null),
      end_time: is_closed ? (end_time || null) : (end_time || null),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("business_special_dates")
      .insert(payload)
      .select("*")
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      message: "Fecha especial creada correctamente",
      item: data,
    });
  } catch (err) {
    console.error("POST /business-special-dates error:", err.message);
    return res.status(500).json({ error: "Error creando fecha especial" });
  }
});

/* ======================================================
   ✅ PUT /business-special-dates/:id
====================================================== */
app.put("/business-special-dates/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      label,
      date,
      is_closed,
      start_time,
      end_time,
    } = req.body;

    const payload = {
      label: label || null,
      date,
      is_closed: !!is_closed,
      start_time: start_time || null,
      end_time: end_time || null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("business_special_dates")
      .update(payload)
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      message: "Fecha especial actualizada correctamente",
      item: data,
    });
  } catch (err) {
    console.error("PUT /business-special-dates/:id error:", err.message);
    return res.status(500).json({ error: "Error actualizando fecha especial" });
  }
});

/* ======================================================
   ✅ DELETE /business-special-dates/:id
====================================================== */
app.delete("/business-special-dates/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("business_special_dates")
      .delete()
      .eq("id", id);

    if (error) throw error;

    return res.json({
      ok: true,
      message: "Fecha especial eliminada correctamente",
    });
  } catch (err) {
    console.error("DELETE /business-special-dates/:id error:", err.message);
    return res.status(500).json({ error: "Error eliminando fecha especial" });
  }
});


/* ======================================================
   ✅ HELPERS STAFF
====================================================== */
function isValidDayOfWeek(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 6;
}

function normalizeNullableText(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function normalizeColor(value) {
  const color = String(value || "").trim();
  if (!color) return "#0f172a";
  return color;
}

/* ======================================================
   ✅ GET /staff
====================================================== */
app.get("/staff", async (req, res) => {
  try {
    const { tenant_id, branch_id, active } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    const resolvedBranchId = await resolveBranchId({
      tenant_id,
      branch_id: branch_id || null,
    });

    let query = supabase
      .from("staff")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("branch_id", resolvedBranchId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (active === "true") query = query.eq("is_active", true);
    if (active === "false") query = query.eq("is_active", false);

    const { data, error } = await query;

    if (error) throw error;

    return res.json({
      total: data?.length || 0,
      branch_id: resolvedBranchId,
      staff: data || [],
    });
  } catch (err) {
    console.error("GET /staff error:", err.message);
    return res.status(500).json({ error: err.message || "Error obteniendo staff" });
  }
});

/* ======================================================
   ✅ POST /staff
====================================================== */

app.post("/staff", async (req, res) => {
  try {
    const {
      tenant_id,
      branch_id,
      name,
      role,
      email,
      phone,
      color = "#0f172a",
      is_active = true,
      sort_order = 0,
      use_business_hours = true,
    } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "name es obligatorio" });
    }

    const resolvedBranchId = await resolveBranchId({
      tenant_id,
      branch_id: branch_id || null,
    });

    const plan = await getPlan(tenant_id);
    const caps = getPlanCapabilities(plan);
    const staffCount = await getStaffCount(tenant_id);

    if (staffCount >= caps.max_staff) {
      return res.status(403).json({
        error: "Límite de staff alcanzado",
        upgrade_required: true,
      });
    }

    const payload = {
      tenant_id,
      branch_id: resolvedBranchId,
      name: String(name).trim(),
      role: normalizeNullableText(role),
      email: normalizeNullableText(email),
      phone: normalizeNullableText(phone),
      color: normalizeColor(color),
      is_active: Boolean(is_active),
      sort_order: Number(sort_order || 0),
      use_business_hours: Boolean(use_business_hours),
    };

    const { data, error } = await supabase
      .from("staff")
      .insert(payload)
      .select("*")
      .single();

    if (error) throw error;

    return res.status(201).json({
      ok: true,
      staff: data,
    });
  } catch (err) {
    console.error("POST /staff error:", err.message);
    return res.status(500).json({ error: err.message || "Error creando staff" });
  }
});

/* ======================================================
   ✅ PUT /staff/:id
====================================================== */

app.put("/staff/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      tenant_id,
      branch_id,
      name,
      role,
      email,
      phone,
      color,
      is_active,
      sort_order,
      use_business_hours,
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }

    const { data: existingStaff, error: existingError } = await supabase
      .from("staff")
      .select("id, tenant_id, branch_id")
      .eq("id", id)
      .single();

    if (existingError || !existingStaff) {
      return res.status(404).json({ error: "Staff no encontrado" });
    }

    const effectiveTenantId = tenant_id || existingStaff.tenant_id;

    const updateData = {};

    if (branch_id !== undefined) {
      const resolvedBranchId = await resolveBranchId({
        tenant_id: effectiveTenantId,
        branch_id: branch_id || null,
      });

      updateData.branch_id = resolvedBranchId;
    }

    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({ error: "name no puede estar vacío" });
      }
      updateData.name = String(name).trim();
    }

    if (role !== undefined) updateData.role = normalizeNullableText(role);
    if (email !== undefined) updateData.email = normalizeNullableText(email);
    if (phone !== undefined) updateData.phone = normalizeNullableText(phone);
    if (color !== undefined) updateData.color = normalizeColor(color);
    if (is_active !== undefined) updateData.is_active = Boolean(is_active);
    if (sort_order !== undefined) updateData.sort_order = Number(sort_order || 0);
    if (use_business_hours !== undefined) {
      updateData.use_business_hours = Boolean(use_business_hours);
    }

    const { data, error } = await supabase
      .from("staff")
      .update(updateData)
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      staff: data,
    });
  } catch (err) {
    console.error("PUT /staff/:id error:", err.message);
    return res.status(500).json({ error: err.message || "Error actualizando staff" });
  }
});

/* ======================================================
   ✅ DELETE /staff/:id
====================================================== */
app.delete("/staff/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("staff")
      .delete()
      .eq("id", id);

    if (error) throw error;

    return res.json({
      ok: true,
      message: "Staff eliminado correctamente",
    });
  } catch (err) {
    console.error("DELETE /staff/:id error:", err.message);
    return res.status(500).json({ error: "Error eliminando staff" });
  }
});

/* ======================================================
   ✅ GET /staff-services
====================================================== */
app.get("/staff-services", async (req, res) => {
  try {
    const { tenant_id, staff_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    let query = supabase
      .from("staff_services")
      .select("*")
      .eq("tenant_id", tenant_id)
      .order("created_at", { ascending: true });

    if (staff_id) {
      query = query.eq("staff_id", staff_id);
    }

    const { data, error } = await query;

    if (error) throw error;

    return res.json({
      total: data?.length || 0,
      staff_services: data || [],
    });
  } catch (err) {
    console.error("GET /staff-services error:", err.message);
    return res.status(500).json({ error: "Error obteniendo staff_services" });
  }
});

/* ======================================================
   ✅ PUT /staff-services
   Reemplaza todas las relaciones de un staff
====================================================== */
app.put("/staff-services", async (req, res) => {
  try {
    const { tenant_id, staff_id, service_ids } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!staff_id) {
      return res.status(400).json({ error: "staff_id es obligatorio" });
    }

    if (!Array.isArray(service_ids)) {
      return res.status(400).json({ error: "service_ids debe ser un arreglo" });
    }

    const uniqueServiceIds = [...new Set(service_ids.filter(Boolean))];

    const { error: deleteError } = await supabase
      .from("staff_services")
      .delete()
      .eq("tenant_id", tenant_id)
      .eq("staff_id", staff_id);

    if (deleteError) throw deleteError;

    if (uniqueServiceIds.length === 0) {
      return res.json({
        ok: true,
        staff_services: [],
      });
    }

    const payload = uniqueServiceIds.map((service_id) => ({
      tenant_id,
      staff_id,
      service_id,
    }));

    const { data, error } = await supabase
      .from("staff_services")
      .insert(payload)
      .select("*");

    if (error) throw error;

    return res.json({
      ok: true,
      staff_services: data || [],
    });
  } catch (err) {
    console.error("PUT /staff-services error:", err.message);
    return res.status(500).json({ error: "Error guardando staff_services" });
  }
});

/* ======================================================
   ✅ DELETE /staff-services/:id
====================================================== */
app.delete("/staff-services/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("staff_services")
      .delete()
      .eq("id", id);

    if (error) throw error;

    return res.json({
      ok: true,
      message: "Relación staff-servicio eliminada correctamente",
    });
  } catch (err) {
    console.error("DELETE /staff-services/:id error:", err.message);
    return res.status(500).json({ error: "Error eliminando relación staff-servicio" });
  }
});

/* ======================================================
   ✅ GET /staff-hours
====================================================== */
app.get("/staff-hours", async (req, res) => {
  try {
    const { tenant_id, staff_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    let query = supabase
      .from("staff_hours")
      .select("*")
      .eq("tenant_id", tenant_id)
      .order("staff_id", { ascending: true })
      .order("day_of_week", { ascending: true });

    if (staff_id) {
      query = query.eq("staff_id", staff_id);
    }

    const { data, error } = await query;

    if (error) throw error;

    return res.json({
      total: data?.length || 0,
      hours: data || [],
    });
  } catch (err) {
    console.error("GET /staff-hours error:", err.message);
    return res.status(500).json({ error: "Error obteniendo staff_hours" });
  }
});

/* ======================================================
   ✅ PUT /staff-hours
   Reemplaza horarios semanales de un staff
====================================================== */
app.put("/staff-hours", async (req, res) => {
  try {
    const { tenant_id, staff_id, hours } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!staff_id) {
      return res.status(400).json({ error: "staff_id es obligatorio" });
    }

    if (!Array.isArray(hours)) {
      return res.status(400).json({ error: "hours debe ser un arreglo" });
    }

    for (const item of hours) {
      if (!isValidDayOfWeek(item.day_of_week)) {
        return res.status(400).json({ error: "day_of_week inválido" });
      }
    }

    const payload = hours.map((item) => ({
      tenant_id,
      staff_id,
      day_of_week: Number(item.day_of_week),
      enabled: Boolean(item.enabled),
      start_time: item.enabled ? item.start_time || null : null,
      end_time: item.enabled ? item.end_time || null : null,
      updated_at: new Date().toISOString(),
    }));

    const { data, error } = await supabase
      .from("staff_hours")
      .upsert(payload, { onConflict: "staff_id,day_of_week" })
      .select("*");

    if (error) throw error;

    return res.json({
      ok: true,
      hours: data || [],
    });
  } catch (err) {
    console.error("PUT /staff-hours error:", err.message);
    return res.status(500).json({ error: "Error guardando staff_hours" });
  }
});

/* ======================================================
   ✅ GET /staff-special-dates
====================================================== */
app.get("/staff-special-dates", async (req, res) => {
  try {
    const { tenant_id, staff_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    let query = supabase
      .from("staff_special_dates")
      .select("*")
      .eq("tenant_id", tenant_id)
      .order("date", { ascending: true })
      .order("created_at", { ascending: true });

    if (staff_id) {
      query = query.eq("staff_id", staff_id);
    }

    const { data, error } = await query;

    if (error) throw error;

    return res.json({
      total: data?.length || 0,
      special_dates: data || [],
    });
  } catch (err) {
    console.error("GET /staff-special-dates error:", err.message);
    return res.status(500).json({ error: "Error obteniendo staff_special_dates" });
  }
});

/* ======================================================
   ✅ POST /staff-special-dates
====================================================== */
app.post("/staff-special-dates", async (req, res) => {
  try {
    const {
      tenant_id,
      staff_id,
      date,
      label,
      is_closed,
      start_time,
      end_time,
    } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!staff_id) {
      return res.status(400).json({ error: "staff_id es obligatorio" });
    }

    if (!date) {
      return res.status(400).json({ error: "date es obligatorio" });
    }

    const payload = {
      tenant_id,
      staff_id,
      date,
      label: normalizeNullableText(label),
      is_closed: Boolean(is_closed),
      start_time: start_time || null,
      end_time: end_time || null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("staff_special_dates")
      .insert(payload)
      .select("*")
      .single();

    if (error) throw error;

    return res.status(201).json({
      ok: true,
      item: data,
    });
  } catch (err) {
    console.error("POST /staff-special-dates error:", err.message);
    return res.status(500).json({ error: "Error creando staff_special_date" });
  }
});

/* ======================================================
   ✅ PUT /staff-special-dates/:id
====================================================== */
app.put("/staff-special-dates/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      staff_id,
      date,
      label,
      is_closed,
      start_time,
      end_time,
    } = req.body;

    const payload = {
      updated_at: new Date().toISOString(),
    };

    if (staff_id !== undefined) payload.staff_id = staff_id;
    if (date !== undefined) payload.date = date;
    if (label !== undefined) payload.label = normalizeNullableText(label);
    if (is_closed !== undefined) payload.is_closed = Boolean(is_closed);
    if (start_time !== undefined) payload.start_time = start_time || null;
    if (end_time !== undefined) payload.end_time = end_time || null;

    const { data, error } = await supabase
      .from("staff_special_dates")
      .update(payload)
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      item: data,
    });
  } catch (err) {
    console.error("PUT /staff-special-dates/:id error:", err.message);
    return res.status(500).json({ error: "Error actualizando staff_special_date" });
  }
});

/* ======================================================
   ✅ DELETE /staff-special-dates/:id
====================================================== */
app.delete("/staff-special-dates/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("staff_special_dates")
      .delete()
      .eq("id", id);

    if (error) throw error;

    return res.json({
      ok: true,
      message: "Fecha especial de staff eliminada correctamente",
    });
  } catch (err) {
    console.error("DELETE /staff-special-dates/:id error:", err.message);
    return res.status(500).json({ error: "Error eliminando staff_special_date" });
  }
});

/* ======================================================
   🔹 ENDPOINT: /slots
====================================================== */

app.get("/slots", async (req, res) => {
  try {
    const { calendar_id, branch_id, service_id, date } = req.query;

    if (!calendar_id || !date) {
      return res.status(400).json({
        error: "Faltan parámetros: calendar_id y date (YYYY-MM-DD)",
      });
    }

    const { data: cal, error: calErr } = await supabase
      .from("calendars")
      .select("id, tenant_id, slot_minutes, is_active")
      .eq("id", calendar_id)
      .single();

    if (calErr || !cal) {
      return res.status(404).json({ error: "Calendario no encontrado" });
    }

    if (!cal.is_active) {
      return res.status(400).json({ error: "Calendario inactivo" });
    }

    const resolvedBranchId = await resolveBranchId({
      tenant_id: cal.tenant_id,
      branch_id: branch_id || null,
    });

    let service = null;

    if (service_id) {
      const { data: serviceData, error: serviceError } = await supabase
        .from("services")
        .select("*")
        .eq("id", service_id)
        .eq("tenant_id", cal.tenant_id)
        .eq("branch_id", resolvedBranchId)
        .is("deleted_at", null)
        .single();

      if (serviceError || !serviceData) {
        return res.status(404).json({ error: "Servicio no encontrado" });
      }

      service = serviceData;
    }

    const { data, error } = await supabase.rpc("get_available_slots", {
      _calendar_id: calendar_id,
      _day: date,
    });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const windows = await getBusinessAvailabilityWindows({
      tenant_id: cal.tenant_id,
      branch_id: resolvedBranchId,
      date,
    });

    let slots = filterSlotsByWindows(data || [], windows, date);

    const windowsWithoutAppointments = await subtractAppointmentsFromWindows({
      tenant_id: cal.tenant_id,
      branch_id: resolvedBranchId,
      staff_id: null,
      date,
      windows: windows,
    });

    slots = buildSlotsFromWindows(
      windowsWithoutAppointments,
      date,
      cal.slot_minutes || 30
    );

    if (service && slots.length > 0) {
      const totalMinutes =
        (service.duration_minutes || 0) +
        (service.buffer_before_minutes || 0) +
        (service.buffer_after_minutes || 0);

      const baseSlotMinutes = cal.slot_minutes || 30;

      slots = filterSlotsForServiceDuration(
        slots,
        totalMinutes,
        baseSlotMinutes
      );
    }

    return res.json({
      calendar_id,
      branch_id: resolvedBranchId,
      service_id: service_id || null,
      service,
      date,
      total: slots.length,
      slots,
    });
  } catch (err) {
    console.error("GET /slots error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ POST /appointments/slot
====================================================== */
app.post("/appointments/slot", async (req, res) => {
  let apptCreated = null;

  try {
const {
  calendar_id,
  branch_id,
  service_id,
  staff_id,
  date,
  slot_start,
  customer_name,
  customer_phone,
  customer_email,
  source = "whatsapp",
} = req.body;

    function normalizeChileanPhone(rawPhone) {
      if (!rawPhone) return null;

      let digits = String(rawPhone).replace(/\D/g, "");

      if (digits.startsWith("56")) {
        digits = digits.slice(2);
      }

      if (digits.length !== 9) return null;
      if (!digits.startsWith("9")) return null;

      return `+56${digits}`;
    }

    function isValidEmail(email) {
      if (!email) return false;

      const normalized = String(email).trim().toLowerCase();
      const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

      if (!emailRegex.test(normalized)) return false;

      const domain = normalized.split("@")[1];
      if (!domain) return false;
      if (domain.startsWith(".") || domain.endsWith(".")) return false;
      if (domain.includes("..")) return false;

      return true;
    }

    const normalizedEmail = String(customer_email || "").trim().toLowerCase();
    const normalizedPhone = normalizeChileanPhone(customer_phone);

    if (
      !calendar_id ||
      !date ||
      !slot_start ||
      !customer_name ||
      !customer_phone ||
      !customer_email
    ) {
      return res.status(400).json({
        error:
          "Faltan campos: calendar_id, date (YYYY-MM-DD), slot_start (ISO), customer_name, customer_phone, customer_email",
      });
    }

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({
        error: "El email ingresado no es válido.",
      });
    }

    if (!normalizedPhone) {
      return res.status(400).json({
        error:
          "El teléfono debe ser un número móvil chileno válido de 9 dígitos. Ejemplo: 912345678",
      });
    }

    
const { data: cal, error: calErr } = await supabase
  .from("calendars")
  .select("tenant_id, slot_minutes, buffer_minutes, timezone, is_active")
  .eq("id", calendar_id)
  .single();

if (calErr || !cal) {
  return res.status(404).json({ error: "Calendario no encontrado" });
}

if (!cal.is_active) {
  return res.status(400).json({ error: "Calendario inactivo" });
}

const resolvedBranchId = await resolveBranchId({
  tenant_id: cal.tenant_id,
  branch_id: branch_id || null,
});

const { data: tenantConfig, error: tenantConfigError } = await supabase
  .from("tenants")
  .select("min_booking_notice_minutes, max_booking_days_ahead")
  .eq("id", cal.tenant_id)
  .single();

if (tenantConfigError || !tenantConfig) {
  return res.status(404).json({ error: "Negocio no encontrado" });
}

const minBookingNoticeMinutes = Number(
  tenantConfig.min_booking_notice_minutes || 0
);

const maxBookingDaysAhead = Number(
  tenantConfig.max_booking_days_ahead || 60
);

const start = new Date(slot_start);

const minAllowedStart = new Date(
  Date.now() + minBookingNoticeMinutes * 60 * 1000
);

if (start.getTime() < minAllowedStart.getTime()) {
  return res.status(409).json({
    error: `Este negocio permite reservas con al menos ${minBookingNoticeMinutes} minutos de anticipación.`,
  });
}

const maxAllowedBookingStart = new Date();
maxAllowedBookingStart.setHours(23, 59, 59, 999);
maxAllowedBookingStart.setDate(
  maxAllowedBookingStart.getDate() + maxBookingDaysAhead
);

if (start.getTime() > maxAllowedBookingStart.getTime()) {
  return res.status(409).json({
    error: `Este negocio permite reservas con hasta ${maxBookingDaysAhead} días de anticipación.`,
  });
}

// 🔒 Anti doble reserva
const startIso = start.toISOString();

let doubleBookingQuery = supabase
  .from("appointments")
  .select("id")
  .eq("tenant_id", cal.tenant_id)
  .eq("start_at", startIso)
  .eq("status", "booked");

if (staff_id) {
  doubleBookingQuery = doubleBookingQuery.eq("staff_id", staff_id);
}

const { data: existingSlot } = await doubleBookingQuery.limit(1);

if (existingSlot && existingSlot.length > 0) {
  return res.status(409).json({
    error: "Este horario acaba de ser reservado por otro cliente.",
  });
}

    const { data: existingAppointments, error: existingErr } = await supabase
      .from("appointments")
      .select("id, start_at, status")
      .eq("tenant_id", cal.tenant_id)
      .eq("customer_email", normalizedEmail)
      .eq("status", "booked")
      .gte("start_at", new Date().toISOString())
      .order("start_at", { ascending: true })
      .limit(1);

    if (existingErr) {
      return res.status(500).json({ error: existingErr.message });
    }

    const existingAppointment = existingAppointments?.[0] || null;

    if (existingAppointment) {
      return res.status(409).json({
        error:
          "Este email ya tiene una reserva futura activa. Revisa tu correo o cancela la reserva actual antes de tomar otra.",
      });
    }

    const slotMinutes = cal.slot_minutes ?? 30;
    const timeZone = cal.timezone || "America/Santiago";

    let duration = slotMinutes;
    let bufferBefore = 0;
    let bufferAfter = 0;
    let serviceName = null;

    if (service_id) {
      const { data: service, error: serviceErr } = await supabase
        .from("services")
        .select("*")
        .eq("id", service_id)
        .is("deleted_at", null)
        .single();

      if (serviceErr || !service) {
        return res.status(404).json({ error: "Servicio no encontrado" });
      }

      duration = service.duration_minutes;
      bufferBefore = service.buffer_before_minutes || 0;
      bufferAfter = service.buffer_after_minutes || 0;
      serviceName = service.name;
    }

    const totalMinutes = duration + bufferBefore + bufferAfter;

    const slotDateObj = new Date(slot_start);
    const slotDateStr = formatDateForServer(slotDateObj);

    let validSlots = [];

    if (staff_id) {
      const businessWindows = await getBusinessAvailabilityWindows({
        tenant_id: cal.tenant_id,
        date: slotDateStr,
      });

      const staffWindows = await getStaffAvailabilityWindows({
        tenant_id: cal.tenant_id,
        staff_id,
        date: slotDateStr,
      });

      let finalWindows = intersectWindows(businessWindows, staffWindows);

      finalWindows = await subtractAppointmentsFromWindows({
        tenant_id: cal.tenant_id,
        staff_id,
        date: slotDateStr,
        windows: finalWindows,
      });

      validSlots = buildSlotsFromWindows(finalWindows, slotDateStr, slotMinutes);

      validSlots = filterSlotsForServiceDuration(
        validSlots,
        totalMinutes,
        slotMinutes
      ).map((slot) => ({
        ...slot,
        staff_id,
      }));
    } else {
      const { data: rawSlots, error: slotsErr } = await supabase.rpc("get_available_slots", {
        _calendar_id: calendar_id,
        _day: date,
      });

      if (slotsErr) {
        return res.status(500).json({ error: slotsErr.message });
      }

      const windows = await getBusinessAvailabilityWindows({
        tenant_id: cal.tenant_id,
        date,
      });

      validSlots = filterSlotsByWindows(rawSlots || [], windows, date);

      validSlots = filterSlotsForServiceDuration(
        validSlots,
        totalMinutes,
        slotMinutes
      );
    }

    const wantedStartIso = new Date(slot_start).toISOString();

    const ok = validSlots.some(
      (s) => new Date(s.slot_start).toISOString() === wantedStartIso
    );

    if (!ok) {
      return res.status(409).json({ error: "Ese horario ya no está disponible." });
    }

    const end = new Date(
      start.getTime() + (duration + bufferBefore + bufferAfter) * 60 * 1000
    );
    const cancelToken = crypto.randomBytes(24).toString("hex");

    const { data: apptRows, error: insErr } = await supabase
      .from("appointments")
      .insert({
  tenant_id: cal.tenant_id,
  branch_id: resolvedBranchId,
  calendar_id,
  service_id,
  staff_id: staff_id || null,
        service_name_snapshot: serviceName,
        duration_minutes_snapshot: duration,
        customer_name: String(customer_name).trim(),
        customer_phone: normalizedPhone,
        customer_email: normalizedEmail,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        source,
        status: "booked",
        cancel_token: cancelToken,
      })
      .select("*");

    if (insErr) {
      return res.status(500).json({ error: insErr.message });
    }

    const appt = apptRows?.[0] || null;

    if (!appt) {
      return res.status(500).json({
        error: "No se pudo crear la reserva.",
      });
    }

    apptCreated = appt;

    const { calendar, googleCalendarId } =
      await getGoogleCalendarClientByCalendarId(calendar_id);

    const event = {
      summary: `Cita - ${String(customer_name).trim()}`,
      description: `Cliente: ${String(customer_name).trim()}\nTeléfono: ${normalizedPhone}\nEmail: ${normalizedEmail}\ncalendar_id: ${calendar_id}\nappointment_id: ${appt.id}\nstaff_id: ${staff_id || "no_asignado"}`,
      start: { dateTime: start.toISOString(), timeZone },
      end: { dateTime: end.toISOString(), timeZone },
    };

    const response = await calendar.events.insert({
      calendarId: googleCalendarId,
      requestBody: event,
    });

    const eventId = response?.data?.id || null;

    const { data: apptUpdated, error: updErr } = await supabase
      .from("appointments")
      .update({ event_id: eventId })
      .eq("id", appt.id)
      .select("*")
      .single();

    if (updErr) {
      try {
        if (eventId) {
          await calendar.events.delete({ calendarId: googleCalendarId, eventId });
        }
      } catch (_) {}

      await supabase
        .from("appointments")
        .update({ status: "canceled", canceled_at: new Date().toISOString() })
        .eq("id", appt.id);

      return res.status(500).json({
        error: "Se creó evento, pero falló guardar event_id en DB.",
      });
    }

    const { data: tenantData } = await supabase
      .from("tenants")
      .select("slug")
      .eq("id", cal.tenant_id)
      .single();

    const bookingUrl = tenantData?.slug
      ? `https://www.orbyx.cl/${tenantData.slug}`
      : "https://www.orbyx.cl";

    const cancelUrl =
      `https://www.orbyx.cl/cancel/${apptUpdated.id}?token=${cancelToken}` +
      `&redirect=${encodeURIComponent(bookingUrl)}`;

    if (normalizedEmail) {
      await sendBookingEmail({
        email: normalizedEmail,
        customerName: String(customer_name).trim(),
        serviceName: serviceName || "Reserva",
        startAt: start.toISOString(),
        cancelUrl,
      });
    }

    return res.status(201).json({
      ok: true,
      appointment: apptUpdated,
      cancel_url: cancelUrl,
      google: {
        calendarId: googleCalendarId,
        event_id: eventId,
        htmlLink: response?.data?.htmlLink,
      },
    });
  } catch (err) {
    try {
      if (apptCreated?.id) {
        await supabase
          .from("appointments")
          .update({ status: "canceled", canceled_at: new Date().toISOString() })
          .eq("id", apptCreated.id);
      }
    } catch (_) {}

    return res.status(500).json({ error: err.message });
  }
});

function formatDateForServer(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/* ======================================================
   ✅ GET /appointments/by-day/:slug/:date
====================================================== */
app.get("/appointments/by-day/:slug/:date", async (req, res) => {
  try {
    const { slug, date } = req.params;

const { data: tenant, error: tenantError } = await supabase
  .from("tenants")
  .select("id, name, slug, min_booking_notice_minutes")
  .eq("slug", slug)
  .eq("is_active", true)
  .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const start = `${date}T00:00:00`;
    const end = `${date}T23:59:59`;

    const { data: appointments, error: appointmentsError } = await supabase
      .from("appointments")
      .select("*")
      .eq("tenant_id", tenant.id)
      .gte("start_at", start)
      .lte("start_at", end)
      .order("start_at", { ascending: true });

    if (appointmentsError) {
      return res.status(500).json({ error: appointmentsError.message });
    }

    return res.json({
      appointments: appointments || [],
    });
  } catch (error) {
    console.error("Error en /appointments/by-day/:slug/:date", error);
    return res.status(500).json({ error: "Error obteniendo agenda" });
  }
});

/* ======================================================
   ✅ GET /appointments/by-range/:slug
====================================================== */
app.get("/appointments/by-range/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        error: "Se requieren los parámetros from y to en formato YYYY-MM-DD",
      });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const start = `${from}T00:00:00`;
    const end = `${to}T23:59:59`;

    const { data: appointments, error: appointmentsError } = await supabase
      .from("appointments")
      .select("*")
      .eq("tenant_id", tenant.id)
      .gte("start_at", start)
      .lte("start_at", end)
      .order("start_at", { ascending: true });

    if (appointmentsError) {
      return res.status(500).json({ error: appointmentsError.message });
    }

    return res.json({
      appointments: appointments || [],
    });
  } catch (error) {
    console.error("Error en /appointments/by-range/:slug", error);
    return res.status(500).json({ error: "Error obteniendo agenda semanal" });
  }
});

/* ======================================================
   ✅ GET /appointments
====================================================== */
app.get("/appointments", async (req, res) => {
  try {
    const { calendar_id, from, to, status } = req.query;

    if (!calendar_id) {
      return res.status(400).json({ error: "calendar_id es obligatorio" });
    }

    let query = supabase
      .from("appointments")
      .select("*")
      .eq("calendar_id", calendar_id)
      .order("start_at", { ascending: true });

    if (status) query = query.eq("status", status);
    if (from) query = query.gte("start_at", from);
    if (to) query = query.lte("start_at", to);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ total: data?.length || 0, appointments: data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ PATCH /appointments/:id/status
====================================================== */
app.patch("/appointments/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowed = ["booked", "completed", "no_show", "canceled"];

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Estado inválido" });
    }

    const { data, error } = await supabase
      .from("appointments")
      .update({
        status,
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      appointment: data,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ CANCEL (DELETE y POST compat)
====================================================== */
async function cancelById(id, token, res) {
  const { data: appt, error: apptErr } = await supabase
    .from("appointments")
    .select("*")
    .eq("id", id)
    .single();

  if (apptErr || !appt) {
    return res.status(404).json({ error: "Appointment no encontrado" });
  }

  if (!token || !appt.cancel_token || token !== appt.cancel_token) {
    return res.status(403).json({
      error: "Token inválido para cancelar esta reserva",
    });
  }

  const st = String(appt.status).toLowerCase();

  if (st === "canceled" || st === "cancelled") {
    return res.json({ ok: true, canceled: true, appointment: appt });
  }

  if (appt.event_id) {
    try {
      const { calendar, googleCalendarId } =
        await getGoogleCalendarClientByCalendarId(appt.calendar_id);

      await calendar.events.delete({
        calendarId: googleCalendarId,
        eventId: appt.event_id,
      });
    } catch (e) {
      console.error("⚠️ Error borrando evento en Google:", e.message);
    }
  }

  const { data: updated, error: updErr } = await supabase
    .from("appointments")
    .update({
      status: "canceled",
      canceled_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();

  if (updErr) return res.status(500).json({ error: updErr.message });

  return res.json({ ok: true, canceled: true, appointment: updated });
}

app.post("/appointments/:id", async (req, res) => {
  try {
    return await cancelById(req.params.id, req.query.token, res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/appointments/:id", async (req, res) => {
  try {
    return await cancelById(req.params.id, req.query.token, res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   🔎 GET /appointments/:id (info pública para cancelación)
====================================================== */
app.get("/appointments/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { token } = req.query;

    const { data: appt, error } = await supabase
      .from("appointments")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !appt) {
      return res.status(404).json({ error: "Reserva no encontrada" });
    }

    if (!token || token !== appt.cancel_token) {
      return res.status(403).json({ error: "Token inválido" });
    }

    return res.json({
      service: appt.service_name_snapshot,
      start_at: appt.start_at,
      location: appt.location_text || null,
      status: appt.status,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   🔹 HEALTHCHECK
====================================================== */
app.get("/_ping", (req, res) => {
  res.send("pong ✅");
});

/* ======================================================
   ✅ SAAS: Provision tenant + owner user + main calendar
====================================================== */
app.post("/tenants/provision", async (req, res) => {
  try {
    const { user_id, email, plan } = req.body;

    if (!user_id || !email || !plan) {
      return res.status(400).json({ error: "Faltan campos: user_id, email, plan" });
    }

    const baseSlug = String(email).split("@")[0] || "tenant";
    const cleanBase =
      baseSlug
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30) || "tenant";

    const suffix = Math.random().toString(16).slice(2, 8);
    const slug = `${cleanBase}-${suffix}`;

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .insert({
        name: email,
        slug,
        plan,
      })
      .select()
      .single();

    if (tenantError) throw tenantError;

    const { error: userError } = await supabase.from("tenant_users").insert({
      user_id,
      tenant_id: tenant.id,
      role: "owner",
    });

    if (userError) throw userError;

    const { data: calendar, error: calendarError } = await supabase
      .from("calendars")
      .insert({
        tenant_id: tenant.id,
        name: "Agenda Principal",
        timezone: "America/Santiago",
        is_active: true,
        slot_minutes: 30,
        buffer_minutes: 0,
      })
      .select()
      .single();

    if (calendarError) throw calendarError;

    return res.json({
      ok: true,
      tenant_id: tenant.id,
      calendar_id: calendar.id,
    });
  } catch (err) {
    console.error("Provision failed:", err);
    return res.status(500).json({ error: "Provision failed", detail: err.message });
  }
});

/* ======================================================
   ✅ PATCH /tenants/:id
====================================================== */

app.patch("/tenants/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      name,
      phone,
      address,
      email,
      whatsapp,
      instagram_url,
      facebook_url,
      description,
      min_booking_notice_minutes,
      max_booking_days_ahead,
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "name es obligatorio" });
    }

    const normalizedMinBookingNoticeMinutes = Math.max(
      0,
      Number(min_booking_notice_minutes || 0)
    );

    const normalizedMaxBookingDaysAhead = Math.max(
      1,
      Number(max_booking_days_ahead || 60)
    );

    const { data, error } = await supabase
      .from("tenants")
      .update({
        name: String(name).trim(),
        phone: phone ? String(phone).trim() : null,
        address: address ? String(address).trim() : null,
        email: email ? String(email).trim() : null,
        whatsapp: whatsapp ? String(whatsapp).trim() : null,
        instagram_url: instagram_url ? String(instagram_url).trim() : null,
        facebook_url: facebook_url ? String(facebook_url).trim() : null,
        description: description ? String(description).trim() : null,
        min_booking_notice_minutes: normalizedMinBookingNoticeMinutes,
        max_booking_days_ahead: normalizedMaxBookingDaysAhead,
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      ok: true,
      tenant: data,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


/* ======================================================
   ✅ GET /services
====================================================== */

app.get("/services", async (req, res) => {
  try {
    const { tenant_id, branch_id, active } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    const resolvedBranchId = await resolveBranchId({
      tenant_id,
      branch_id: branch_id || null,
    });

    let query = supabase
      .from("services")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("branch_id", resolvedBranchId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });

    if (active === "true") {
      query = query.eq("active", true);
    }

    if (active === "false") {
      query = query.eq("active", false);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      total: data?.length || 0,
      branch_id: resolvedBranchId,
      services: data || [],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ POST /services
====================================================== */

app.post("/services", async (req, res) => {
  try {
    const {
      tenant_id,
      branch_id,
      name,
      description,
      duration_minutes,
      buffer_before_minutes = 0,
      buffer_after_minutes = 0,
      price = 0,
      active = true,
    } = req.body;

    if (!tenant_id || !name || !duration_minutes) {
      return res.status(400).json({
        error: "Faltan campos obligatorios: tenant_id, name, duration_minutes",
      });
    }

    const resolvedBranchId = await resolveBranchId({
      tenant_id,
      branch_id: branch_id || null,
    });

    const plan = await getPlan(tenant_id);
    const caps = getPlanCapabilities(plan);
    const servicesCount = await getServicesCount(tenant_id);

    if (servicesCount >= (caps.max_services || 3)) {
      return res.status(403).json({
        error: "Límite de servicios alcanzado",
        upgrade_required: true,
      });
    }

    const { data, error } = await supabase
      .from("services")
      .insert({
        tenant_id,
        branch_id: resolvedBranchId,
        name: String(name).trim(),
        description: description ? String(description).trim() : null,
        duration_minutes: Number(duration_minutes),
        buffer_before_minutes: Number(buffer_before_minutes || 0),
        buffer_after_minutes: Number(buffer_after_minutes || 0),
        price: Number(price || 0),
        active: Boolean(active),
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json({
      ok: true,
      service: data,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


/* ======================================================
   ✏️ PATCH /services/:id
====================================================== */

app.patch("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      tenant_id,
      branch_id,
      name,
      description,
      duration_minutes,
      price,
      buffer_before_minutes = 0,
      buffer_after_minutes = 0,
      active,
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }

    const { data: existingService, error: existingError } = await supabase
      .from("services")
      .select("id, tenant_id, branch_id")
      .eq("id", id)
      .single();

    if (existingError || !existingService) {
      return res.status(404).json({ error: "Servicio no encontrado" });
    }

    const effectiveTenantId = tenant_id || existingService.tenant_id;

    const updateData = {};

    if (branch_id !== undefined) {
      const resolvedBranchId = await resolveBranchId({
        tenant_id: effectiveTenantId,
        branch_id: branch_id || null,
      });

      updateData.branch_id = resolvedBranchId;
    }

    if (name !== undefined) updateData.name = String(name).trim();
    if (description !== undefined)
      updateData.description =
        description === null ? null : String(description).trim();
    if (duration_minutes !== undefined)
      updateData.duration_minutes = Number(duration_minutes);
    if (price !== undefined) updateData.price = Number(price);
    if (buffer_before_minutes !== undefined)
      updateData.buffer_before_minutes = Number(buffer_before_minutes);
    if (buffer_after_minutes !== undefined)
      updateData.buffer_after_minutes = Number(buffer_after_minutes);
    if (active !== undefined) updateData.active = Boolean(active);

    const { data, error } = await supabase
      .from("services")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      ok: true,
      service: data,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


/* ======================================================
   🗑️ DELETE /services/:id
====================================================== */
app.delete("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }

    const { data, error } = await supabase
      .from("services")
      .update({
        deleted_at: new Date().toISOString(),
        active: false,
      })
      .eq("id", id)
      .is("deleted_at", null)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: "Servicio no encontrado" });
    }

    return res.json({
      ok: true,
      service: data,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   🌐 PUBLIC: servicios por slug
====================================================== */
app.get("/public/services/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("*")
      .eq("slug", slug)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const { data: calendar, error: calendarError } = await supabase
      .from("calendars")
      .select("id")
      .eq("tenant_id", tenant.id)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (calendarError || !calendar) {
      return res.status(404).json({ error: "Calendario no encontrado" });
    }

    const { data: services, error: servicesError } = await supabase
      .from("services")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("active", true)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });

    if (servicesError) {
      return res.status(500).json({ error: servicesError.message });
    }

    return res.json({
      business: tenant,
      calendar_id: calendar.id,
      services: services || [],
    });
  } catch (error) {
    console.error("Error en /public/services/:slug", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

/* ======================================================
   🌐 PUBLIC: negocio por slug
====================================================== */
app.get("/public/business/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    if (!slug) {
      return res.status(400).json({ error: "slug requerido" });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
.select(`
  id,
  name,
  slug,
  phone,
  address,
  email,
  whatsapp,
  instagram_url,
  facebook_url,
  description,
  min_booking_notice_minutes,
  max_booking_days_ahead,
  is_active,
  plan_slug
`)
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "negocio no encontrado" });
    }

    const { data: calendar } = await supabase
      .from("calendars")
      .select("id")
      .eq("tenant_id", tenant.id)
      .eq("is_active", true)
      .limit(1)
      .single();

    return res.json({
      business: {
        ...tenant,
        min_booking_notice_minutes: tenant.min_booking_notice_minutes || 0,
        max_booking_days_ahead: tenant.max_booking_days_ahead || 60,
      },
      calendar_id: calendar?.id,
      google_connected: false,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
/* ======================================================
   🌐 PUBLIC: staff por slug + service_id
====================================================== */
app.get("/public/staff/:slug/:service_id", async (req, res) => {
  try {
    const { slug, service_id } = req.params;

    if (!slug || !service_id) {
      return res.status(400).json({
        error: "Se requiere slug y service_id",
      });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, slug, name")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "negocio no encontrado" });
    }

    const { data: service, error: serviceError } = await supabase
      .from("services")
      .select("id, tenant_id, active, deleted_at")
      .eq("id", service_id)
      .eq("tenant_id", tenant.id)
      .eq("active", true)
      .is("deleted_at", null)
      .single();

    if (serviceError || !service) {
      return res.status(404).json({ error: "servicio no encontrado" });
    }

    const { data: relations, error: relationsError } = await supabase
      .from("staff_services")
      .select("staff_id")
      .eq("tenant_id", tenant.id)
      .eq("service_id", service_id);

    if (relationsError) {
      return res.status(500).json({ error: relationsError.message });
    }

    const staffIds = [...new Set((relations || []).map((row) => row.staff_id).filter(Boolean))];

    if (staffIds.length === 0) {
      return res.json({
        business: {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
        },
        service_id,
        total: 0,
        staff: [],
      });
    }

    const { data: staffRows, error: staffError } = await supabase
      .from("staff")
      .select("id, name, role, color, is_active, sort_order")
      .eq("tenant_id", tenant.id)
      .eq("is_active", true)
      .in("id", staffIds)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (staffError) {
      return res.status(500).json({ error: staffError.message });
    }

    return res.json({
      business: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
      },
      service_id,
      total: staffRows?.length || 0,
      staff: staffRows || [],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   🌐 PUBLIC: slots por slug + service_id + date
====================================================== */

app.get("/public/slots/:slug/:service_id", async (req, res) => {
  try {
    const { slug, service_id } = req.params;
    const { date, staff_id } = req.query;

    if (!slug || !service_id || !date) {
      return res.status(400).json({
        error: "Se requiere slug, service_id y date (YYYY-MM-DD)",
      });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select(
        "id, name, slug, min_booking_notice_minutes, max_booking_days_ahead"
      )
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "negocio no encontrado" });
    }

    const minBookingNoticeMinutes = Number(
      tenant.min_booking_notice_minutes || 0
    );
    const maxBookingDaysAhead = Number(tenant.max_booking_days_ahead || 60);

    const requestedDate = new Date(`${date}T00:00:00-03:00`);
    const maxAllowedDate = new Date();
    maxAllowedDate.setHours(0, 0, 0, 0);
    maxAllowedDate.setDate(maxAllowedDate.getDate() + maxBookingDaysAhead);

    if (requestedDate.getTime() > maxAllowedDate.getTime()) {
      return res.json({
        business: {
          name: tenant.name,
          slug: tenant.slug,
        },
        calendar_id: null,
        service: null,
        date,
        total: 0,
        slots: [],
      });
    }

    const { data: service, error: serviceError } = await supabase
      .from("services")
      .select("*")
      .eq("id", service_id)
      .eq("tenant_id", tenant.id)
      .eq("active", true)
      .is("deleted_at", null)
      .single();

    if (serviceError || !service) {
      return res.status(404).json({ error: "servicio no encontrado" });
    }

    const { data: calendar, error: calendarError } = await supabase
      .from("calendars")
      .select("id, slot_minutes")
      .eq("tenant_id", tenant.id)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (calendarError || !calendar) {
      return res.status(404).json({ error: "calendario no encontrado" });
    }

    const serviceStaffIds = await getServiceStaffIds({
      tenant_id: tenant.id,
      service_id,
    });

    const requestedStaffId = staff_id ? String(staff_id) : null;

    let candidateStaffIds = requestedStaffId
      ? serviceStaffIds.filter((id) => id === requestedStaffId)
      : serviceStaffIds;

    if (requestedStaffId && candidateStaffIds.length === 0) {
      return res.status(400).json({
        error: "El staff seleccionado no realiza este servicio",
      });
    }

    const businessWindows = await getBusinessAvailabilityWindows({
      tenant_id: tenant.id,
      date,
    });

    if (!candidateStaffIds.length) {
      let slots = buildSlotsFromWindows(
        businessWindows,
        date,
        calendar.slot_minutes || 30
      );

      const totalMinutes =
        (service.duration_minutes || 0) +
        (service.buffer_before_minutes || 0) +
        (service.buffer_after_minutes || 0);

      slots = filterSlotsForServiceDuration(
        slots,
        totalMinutes,
        calendar.slot_minutes || 30
      );

      slots = filterPastSlots(slots, minBookingNoticeMinutes);

      return res.json({
        business: {
          name: tenant.name,
          slug: tenant.slug,
        },
        calendar_id: calendar.id,
        service,
        date,
        total: slots.length,
        slots,
      });
    }

    let mergedSlots = [];

    for (const currentStaffId of candidateStaffIds) {
      const staffWindows = await getStaffAvailabilityWindows({
        tenant_id: tenant.id,
        staff_id: currentStaffId,
        date,
      });

      let finalWindows = intersectWindows(businessWindows, staffWindows);

      finalWindows = await subtractAppointmentsFromWindows({
        tenant_id: tenant.id,
        staff_id: currentStaffId,
        date,
        windows: finalWindows,
      });

      let staffSlots = buildSlotsFromWindows(
        finalWindows,
        date,
        calendar.slot_minutes || 30
      );

      const totalMinutes =
        (service.duration_minutes || 0) +
        (service.buffer_before_minutes || 0) +
        (service.buffer_after_minutes || 0);

      staffSlots = filterSlotsForServiceDuration(
        staffSlots,
        totalMinutes,
        calendar.slot_minutes || 30
      ).map((slot) => ({
        ...slot,
        staff_id: currentStaffId,
      }));

      mergedSlots.push(...staffSlots);
    }

    const uniqueMap = new Map();

    for (const slot of mergedSlots) {
      const key = slot.slot_start;

      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, slot);
      }
    }

    let slots = Array.from(uniqueMap.values()).sort(
      (a, b) =>
        new Date(a.slot_start).getTime() - new Date(b.slot_start).getTime()
    );

    slots = filterPastSlots(slots, minBookingNoticeMinutes);

    return res.json({
      business: {
        name: tenant.name,
        slug: tenant.slug,
      },
      calendar_id: calendar.id,
      service,
      date,
      total: slots.length,
      slots,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


/* ======================================================
   🔔 RECORDATORIOS 24H
====================================================== */
app.get("/jobs/send-reminders", async (req, res) => {
  try {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const { data: appointments, error } = await supabase
      .from("appointments")
      .select("*")
      .eq("status", "booked")
      .gte("start_at", in24h.toISOString())
      .lte("start_at", new Date(in24h.getTime() + 60 * 60 * 1000).toISOString());

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    let sent = 0;

    for (const appt of appointments) {
      if (!appt.customer_email) continue;

      const { data: tenantData } = await supabase
        .from("tenants")
        .select("slug")
        .eq("id", appt.tenant_id)
        .single();

      const bookingUrl = tenantData?.slug
        ? `https://www.orbyx.cl/${tenantData.slug}`
        : "https://www.orbyx.cl";

      const cancelUrl =
        `https://www.orbyx.cl/cancel/${appt.id}?token=${appt.cancel_token}` +
        `&redirect=${encodeURIComponent(bookingUrl)}`;

      await sendBookingEmail({
        email: appt.customer_email,
        customerName: appt.customer_name,
        serviceName: appt.service_name_snapshot || "Reserva",
        startAt: appt.start_at,
        cancelUrl,
      });

      sent++;
    }

    return res.json({
      ok: true,
      reminders_sent: sent,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ ONBOARDING SETUP
====================================================== */
app.post("/onboarding/setup", async (req, res) => {
  try {
    const {
      business,
      service,
      weekly_hours = [],
      special_dates = [],
    } = req.body;

    if (!business?.name || !business?.slug) {
      return res.status(400).json({
        error: "Faltan campos obligatorios del negocio: name y slug",
      });
    }

    const normalizedSlug = String(business.slug).trim().toLowerCase();

    const { data: existingTenantBySlug, error: slugCheckError } = await supabase
      .from("tenants")
      .select("id, slug")
      .eq("slug", normalizedSlug)
      .maybeSingle();

    if (slugCheckError) {
      return res.status(500).json({ error: slugCheckError.message });
    }

    if (existingTenantBySlug) {
      return res.status(400).json({
        error: "Este slug ya está en uso. Prueba con otro nombre de negocio.",
      });
    }

    const { data: createdTenant, error: tenantError } = await supabase
      .from("tenants")
      .insert({
        name: String(business.name).trim(),
        slug: normalizedSlug,
        phone: business.contact_phone
          ? String(business.contact_phone).trim()
          : null,
        address: business.address ? String(business.address).trim() : null,
      })
      .select()
      .single();

    if (tenantError) {
      return res.status(500).json({ error: tenantError.message });
    }

    const tenant_id = createdTenant.id;

    const { data: createdCalendar, error: calendarError } = await supabase
      .from("calendars")
      .insert({
        tenant_id,
        name: "Principal",
        timezone: "America/Santiago",
        is_active: true,
        slot_minutes: 30,
        buffer_minutes: 0,
      })
      .select()
      .single();

    if (calendarError) {
      return res.status(500).json({ error: calendarError.message });
    }

    const calendar_id = createdCalendar.id;

    let createdService = null;

    if (service?.name) {
      const { data: serviceInserted, error: serviceError } = await supabase
        .from("services")
        .insert({
          tenant_id,
          name: String(service.name).trim(),
          duration_minutes: Number(service.duration_minutes || 30),
          buffer_before_minutes: Number(service.buffer_before_minutes || 0),
          buffer_after_minutes: Number(service.buffer_after_minutes || 0),
          price: Number(service.price || 0),
          active: true,
        })
        .select()
        .single();

      if (serviceError) {
        return res.status(500).json({ error: serviceError.message });
      }

      createdService = serviceInserted;
    }

    if (Array.isArray(weekly_hours) && weekly_hours.length > 0) {
      const weeklyRows = weekly_hours.map((row) => ({
        tenant_id,
        day_of_week: Number(row.day_of_week),
        enabled: !!row.enabled,
        start_time: row.enabled ? row.start_time || null : null,
        end_time: row.enabled ? row.end_time || null : null,
      }));

      const { error: insertWeeklyError } = await supabase
        .from("business_hours")
        .upsert(weeklyRows, { onConflict: "tenant_id,day_of_week" });

      if (insertWeeklyError) {
        return res.status(500).json({ error: insertWeeklyError.message });
      }
    }

    if (Array.isArray(special_dates) && special_dates.length > 0) {
      const specialRows = special_dates.map((row) => ({
        tenant_id,
        date: row.date,
        label: row.label || "Configuración especial",
        is_closed: !!row.is_closed,
        start_time: row.start_time || null,
        end_time: row.end_time || null,
      }));

      const { error: insertSpecialError } = await supabase
        .from("business_special_dates")
        .insert(specialRows);

      if (insertSpecialError) {
        return res.status(500).json({ error: insertSpecialError.message });
      }
    }

    return res.json({
      ok: true,
      tenant_id,
      calendar_id,
      slug: createdTenant.slug,
      service: createdService,
    });
  } catch (err) {
    console.error("Onboarding setup failed:", err);
    return res.status(500).json({
      error: "Onboarding setup failed",
      detail: err.message,
    });
  }
});

/* ======================================================
   🚀 START
====================================================== */
app.listen(PORT, () => {
  console.log(`🚀 Servidor listo en http://localhost:${PORT}`);
});