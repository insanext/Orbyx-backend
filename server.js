// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const { supabase } = require("./supabaseClient");

const app = express();

/* ======================================================
   ✅ CORS (SOLUCIÓN)
   - Permite llamadas desde tu Vercel + dominio
   - Responde preflight (OPTIONS) siempre
====================================================== */
app.use(
  cors({
    origin: [
      "https://app.orbyx.cl",
      "https://orbyx-dashboard.vercel.app",
    ],
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);
app.options("*", cors()); // ✅ preflight

app.use(express.json());

const PORT = process.env.PORT || 3000;

// 🔐 Credenciales OAuth (TU app, únicas)
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

// ✅ (Compatibilidad) si entras a /auth sin calendar_id
const CLIENTE_FIJO = "cliente_demo";
const CAL_FIJO = "principal";

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

console.log("✅ Iniciado sin token.json. Tokens se leerán desde Supabase.");
console.log("🔥 VERSION: SAAS_TOKEN_BY_CALENDAR_ID + HISTORY DEPLOYED");

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
      <h2>Autorizar Google Calendar</h2>
      <p>
        Modo: <b>${calendar_id ? "SaaS por calendar_id" : "Fijo (compatibilidad)"}</b><br/>
        ${
          calendar_id
            ? `calendar_id: <b>${calendar_id}</b>`
            : `Cliente: <b>${CLIENTE_FIJO}</b> | Calendario: <b>${CAL_FIJO}</b>`
        }
      </p>
      <a href="${url}">Haz clic aquí para autorizar</a>
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
        state = JSON.parse(Buffer.from(String(stateRaw), "base64url").toString("utf8"));
      }
    } catch (_) {
      state = {};
    }

    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    if (!tokens.refresh_token) {
      return res
        .status(400)
        .send("⚠️ No vino refresh_token. Revoca acceso a la app en tu cuenta Google y reautoriza en /auth.");
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

      const { error } = await supabase
        .from("calendar_tokens")
        .upsert(
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

      return res.send(
        `✅ Autorizado y guardado en Supabase para calendar_id=${calendar_id}.<br/>` +
          `Ahora prueba: <a href="/test-event?calendar_id=${calendar_id}">/test-event?calendar_id=${calendar_id}</a>`
      );
    }

    // ✅ Compatibilidad: modo fijo
    const { error } = await supabase
      .from("calendar_tokens")
      .upsert(
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
    const { calendar_id, date } = req.query;

    if (!calendar_id || !date) {
      return res.status(400).json({
        error: "Faltan parámetros: calendar_id y date (YYYY-MM-DD)",
      });
    }

    const { data, error } = await supabase.rpc("get_available_slots", {
      _calendar_id: calendar_id,
      _day: date,
    });

    if (error) return res.status(500).json({ error: error.message });

    return res.json({
      calendar_id,
      date,
      total: data?.length || 0,
      slots: data || [],
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
      date,
      slot_start,
      customer_name,
      customer_phone,
      source = "whatsapp",
    } = req.body;

    if (!calendar_id || !date || !slot_start || !customer_name || !customer_phone) {
      return res.status(400).json({
        error:
          "Faltan campos: calendar_id, date (YYYY-MM-DD), slot_start (ISO), customer_name, customer_phone",
      });
    }

    const { data: cal, error: calErr } = await supabase
      .from("calendars")
      .select("tenant_id, slot_minutes, buffer_minutes, timezone, is_active")
      .eq("id", calendar_id)
      .single();

    if (calErr || !cal) return res.status(404).json({ error: "Calendario no encontrado" });
    if (!cal.is_active) return res.status(400).json({ error: "Calendario inactivo" });

    const slotMinutes = cal.slot_minutes ?? 30;
    const bufferMinutes = cal.buffer_minutes ?? 0;
    const timeZone = cal.timezone || "America/Santiago";

    const { data: slots, error: slotsErr } = await supabase.rpc("get_available_slots", {
      _calendar_id: calendar_id,
      _day: date,
    });
    if (slotsErr) return res.status(500).json({ error: slotsErr.message });

    const wantedStartIso = new Date(slot_start).toISOString();
    const ok = (slots || []).some((s) => new Date(s.slot_start).toISOString() === wantedStartIso);
    if (!ok) return res.status(409).json({ error: "Ese horario ya no está disponible." });

    const start = new Date(slot_start);
    const end = new Date(start.getTime() + (slotMinutes + bufferMinutes) * 60 * 1000);

    const { data: appt, error: insErr } = await supabase
      .from("appointments")
      .insert({
        tenant_id: cal.tenant_id,
        calendar_id,
        customer_name,
        customer_phone,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        source,
        status: "booked",
      })
      .select("*")
      .single();

    if (insErr) {
      const msg = (insErr.message || "").toLowerCase();
      if (msg.includes("overlap") || msg.includes("conflict") || msg.includes("exclude")) {
        return res.status(409).json({ error: "Choque de horario (ya reservado)" });
      }
      return res.status(500).json({ error: insErr.message });
    }

    apptCreated = appt;

    const { calendar, googleCalendarId } = await getGoogleCalendarClientByCalendarId(calendar_id);

    const event = {
      summary: `Cita - ${customer_name}`,
      description: `Cliente: ${customer_name}\nTeléfono: ${customer_phone}\ncalendar_id: ${calendar_id}\nappointment_id: ${appt.id}`,
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

      return res.status(500).json({ error: "Se creó evento, pero falló guardar event_id en DB." });
    }

    return res.status(201).json({
      ok: true,
      appointment: apptUpdated,
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
async function cancelById(id, res) {
  const { data: appt, error: apptErr } = await supabase
    .from("appointments")
    .select("*")
    .eq("id", id)
    .single();

  if (apptErr || !appt) return res.status(404).json({ error: "Appointment no encontrado" });

  // idempotente
  if (String(appt.status).toLowerCase() === "canceled") {
    return res.json({ ok: true, canceled: true, appointment: appt });
  }

  // borrar evento google si existe
  if (appt.event_id) {
    try {
      const { calendar, googleCalendarId } = await getGoogleCalendarClientByCalendarId(
        appt.calendar_id
      );

      await calendar.events.delete({
        calendarId: googleCalendarId,
        eventId: appt.event_id,
      });
    } catch (e) {
      console.error("⚠️ Error borrando evento en Google:", e.message);
    }
  }

  // cancelar en BD
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
    return await cancelById(req.params.id, res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/appointments/:id", async (req, res) => {
  try {
    return await cancelById(req.params.id, res);
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
   🚀 START
====================================================== */
app.listen(PORT, () => {
  console.log(`🚀 Servidor listo en http://localhost:${PORT}`);
});