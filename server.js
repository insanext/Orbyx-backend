// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const crypto = require("crypto");
const { supabase } = require("./supabaseClient");
const { sendBookingEmail } = require("./email");

const app = express();

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

console.log("✅ Iniciado sin token.json. Tokens se leerán desde Supabase.");
console.log("🔥 VERSION: SAAS_TOKEN_BY_CALENDAR_ID + OAUTH REDIRECT TO FRONTEND");

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
   🔹 ENDPOINT: /slots
====================================================== */
app.get("/slots", async (req, res) => {
  try {
    const { calendar_id, service_id, date } = req.query;

    if (!calendar_id || !date) {
      return res.status(400).json({
        error: "Faltan parámetros: calendar_id y date (YYYY-MM-DD)",
      });
    }

    let service = null;

    if (service_id) {
      const { data: serviceData, error: serviceError } = await supabase
        .from("services")
        .select("*")
        .eq("id", service_id)
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

    let slots = data || [];

    if (service && slots.length > 0) {
      const totalMinutes =
        (service.duration_minutes || 0) +
        (service.buffer_before_minutes || 0) +
        (service.buffer_after_minutes || 0);

      const baseSlotMinutes = 30;
      const neededBlocks = Math.ceil(totalMinutes / baseSlotMinutes);

      slots = slots.filter((slot, index) => {
        for (let i = 1; i < neededBlocks; i++) {
          const current = slots[index + i - 1];
          const next = slots[index + i];

          if (!current || !next) return false;

          const currentEnd = new Date(current.slot_end).toISOString();
          const nextStart = new Date(next.slot_start).toISOString();

          if (currentEnd !== nextStart) return false;
        }

        return true;
      });
    }

    return res.json({
      calendar_id,
      service_id: service_id || null,
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
   ✅ POST /appointments/slot
====================================================== */
app.post("/appointments/slot", async (req, res) => {
  let apptCreated = null;

  try {
    const {
      calendar_id,
      service_id,
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

    const start = new Date(slot_start);

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

    const { data: slots, error: slotsErr } = await supabase.rpc("get_available_slots", {
      _calendar_id: calendar_id,
      _day: date,
    });

    if (slotsErr) {
      return res.status(500).json({ error: slotsErr.message });
    }

    let duration = slotMinutes;
    let bufferBefore = 0;
    let bufferAfter = 0;
    let serviceName = null;

    if (service_id) {
      const { data: service, error: serviceErr } = await supabase
        .from("services")
        .select("*")
        .eq("id", service_id)
        .single();

      if (serviceErr || !service) {
        return res.status(404).json({ error: "Servicio no encontrado" });
      }

      duration = service.duration_minutes;
      bufferBefore = service.buffer_before_minutes || 0;
      bufferAfter = service.buffer_after_minutes || 0;
      serviceName = service.name;
    }

    const wantedStartIso = new Date(slot_start).toISOString();
    let validSlots = slots || [];

    if (service_id && validSlots.length > 0) {
      const totalMinutes = duration + bufferBefore + bufferAfter;
      const baseSlotMinutes = slotMinutes;
      const neededBlocks = Math.ceil(totalMinutes / baseSlotMinutes);

      validSlots = validSlots.filter((slot, index) => {
        for (let i = 1; i < neededBlocks; i++) {
          const current = validSlots[index + i - 1];
          const next = validSlots[index + i];

          if (!current || !next) return false;

          const currentEnd = new Date(current.slot_end).toISOString();
          const nextStart = new Date(next.slot_start).toISOString();

          if (currentEnd !== nextStart) return false;
        }

        return true;
      });
    }

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
        calendar_id,
        service_id,
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
      const constraint = insErr.constraint || "";
      const msg = (insErr.message || "").toLowerCase();

      if (
        constraint === "no_overlapping_appointments" ||
        constraint === "appointments_calendar_start_unique" ||
        msg.includes("overlap") ||
        msg.includes("conflict") ||
        msg.includes("exclude") ||
        msg.includes("duplicate key") ||
        msg.includes("unique constraint") ||
        msg.includes("appointments_calendar_start_unique")
      ) {
        return res.status(409).json({
          error: "Ese horario ya fue reservado.",
        });
      }

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
      description: `Cliente: ${String(customer_name).trim()}\nTeléfono: ${normalizedPhone}\nEmail: ${normalizedEmail}\ncalendar_id: ${calendar_id}\nappointment_id: ${appt.id}`,
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
   ✅ GET /services
====================================================== */
app.get("/services", async (req, res) => {
  try {
    const { tenant_id, active } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    let query = supabase
      .from("services")
      .select("*")
      .eq("tenant_id", tenant_id)
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
      services: data || [],
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

    if (!slug) {
      return res.status(400).json({ error: "slug requerido" });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, name, slug, logo_url, brand_color, description, phone, address")
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
      .single();

    const { data: services, error: servicesError } = await supabase
      .from("services")
      .select("id, name, duration_minutes, buffer_before_minutes, buffer_after_minutes, price, location_type, location_text")
      .eq("tenant_id", tenant.id)
      .eq("active", true)
      .order("created_at", { ascending: true });

    if (servicesError) {
      return res.status(500).json({ error: servicesError.message });
    }

    return res.json({
      business: {
        name: tenant.name,
        slug: tenant.slug,
        calendar_id: calendar?.id || null,
        logo_url: tenant.logo_url,
        brand_color: tenant.brand_color,
        description: tenant.description,
        phone: tenant.phone,
        address: tenant.address,
      },
      total: services?.length || 0,
      services: services || [],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
      .select("id, name, slug")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "negocio no encontrado" });
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
      return res.status(404).json({ error: "calendario no encontrado" });
    }

    return res.json({
      business: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
      },
      calendar_id: calendar.id,
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
    const { date } = req.query;

    if (!slug || !service_id || !date) {
      return res.status(400).json({
        error: "Se requiere slug, service_id y date (YYYY-MM-DD)",
      });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, name, slug")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "negocio no encontrado" });
    }

    const { data: service, error: serviceError } = await supabase
      .from("services")
      .select("*")
      .eq("id", service_id)
      .eq("tenant_id", tenant.id)
      .eq("active", true)
      .single();

    if (serviceError || !service) {
      return res.status(404).json({ error: "servicio no encontrado" });
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
      return res.status(404).json({ error: "calendario no encontrado" });
    }

    const { data, error } = await supabase.rpc("get_available_slots", {
      _calendar_id: calendar.id,
      _day: date,
    });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    let slots = data || [];

    if (slots.length > 0) {
      const totalMinutes =
        (service.duration_minutes || 0) +
        (service.buffer_before_minutes || 0) +
        (service.buffer_after_minutes || 0);

      const baseSlotMinutes = 30;
      const neededBlocks = Math.ceil(totalMinutes / baseSlotMinutes);

      slots = slots.filter((slot, index) => {
        for (let i = 1; i < neededBlocks; i++) {
          const current = slots[index + i - 1];
          const next = slots[index + i];

          if (!current || !next) return false;

          const currentEnd = new Date(current.slot_end).toISOString();
          const nextStart = new Date(next.slot_start).toISOString();

          if (currentEnd !== nextStart) return false;
        }

        return true;
      });
    }

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

    // 1) validar slug único
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

    // 2) crear tenant / negocio
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

    // 3) crear calendario principal
    const { data: createdCalendar, error: calendarError } = await supabase
      .from("calendars")
      .insert({
        tenant_id,
        name: "Principal",
      })
      .select()
      .single();

    if (calendarError) {
      return res.status(500).json({ error: calendarError.message });
    }

    const calendar_id = createdCalendar.id;

    // 4) crear primer servicio
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

    // 5) guardar horarios semanales
    if (Array.isArray(weekly_hours) && weekly_hours.length > 0) {
      const weeklyRows = weekly_hours
        .filter((row) => row.is_open)
        .map((row) => ({
          tenant_id,
          calendar_id,
          weekday: Number(row.day_of_week),
          start_time: row.start_time,
          end_time: row.end_time,
        }));

      const { error: insertWeeklyError } = await supabase
        .from("working_hours")
        .insert(weeklyRows);

      if (insertWeeklyError) {
        return res.status(500).json({ error: insertWeeklyError.message });
      }
    }

    // 6) guardar fechas especiales
    if (Array.isArray(special_dates) && special_dates.length > 0) {
      const specialRows = special_dates.map((row) => ({
        tenant_id,
        calendar_id,
        type: row.is_open ? "open" : "block",
        start_at: row.start_time ? `${row.date}T${row.start_time}:00` : `${row.date}T00:00:00`,
        end_at: row.end_time ? `${row.date}T${row.end_time}:00` : `${row.date}T23:59:59`,
        reason: "Configuración especial",
      }));

      const { error: insertSpecialError } = await supabase
        .from("availability_exceptions")
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