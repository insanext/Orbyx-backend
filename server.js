require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");
const { supabase } = require("./supabaseClient");

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ✅ PASO 1: habilitar JSON body
app.use(express.json());

// 🔐 Credenciales OAuth (TU app, únicas)
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

// ✅ Cliente fijo (por ahora)
const CLIENTE_FIJO = "cliente_demo";
const CAL_FIJO = "principal";
const GOOGLE_CALENDAR_ID = "primary";

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

console.log("✅ Iniciado sin token.json. Tokens se leerán desde Supabase.");
console.log("🔥 VERSION: PING+SLOTS+APPOINTMENTS DEPLOYED");

/* ======================================================
   🔹 ENDPOINT 1: Generar autorización Google
====================================================== */
app.get("/auth", (req, res) => {
  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  res.send(`
    <h2>Autorizar Google Calendar</h2>
    <p>Cliente: <b>${CLIENTE_FIJO}</b> | Calendario: <b>${CAL_FIJO}</b></p>
    <a href="${url}">Haz clic aquí para autorizar</a>
  `);
});

/* ======================================================
   🔹 ENDPOINT 2: Callback Google OAuth
====================================================== */
app.get("/oauth2callback", async (req, res) => {
  try {
    const code = req.query.code;

    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    if (!tokens.refresh_token) {
      return res
        .status(400)
        .send(
          "⚠️ No vino refresh_token. Revoca acceso a la app en tu cuenta Google y reautoriza en /auth."
        );
    }

    const { error } = await supabase
      .from("calendar_tokens")
      .upsert(
        {
          client_id: CLIENTE_FIJO,
          calendar_name: CAL_FIJO,
          google_calendar_id: GOOGLE_CALENDAR_ID,
          refresh_token: tokens.refresh_token,
          access_token: tokens.access_token ?? null,
          token_type: tokens.token_type ?? null,
          scope: tokens.scope ?? null,
          expiry_date: tokens.expiry_date ?? null,
        },
        { onConflict: "client_id,calendar_name" }
      );

    if (error) throw error;

    console.log("✅ Tokens guardados en Supabase");

    res.send("✅ Autorizado y guardado en Supabase. Ahora entra a /test-event");
  } catch (error) {
    console.error(error);
    res.status(500).send("Error en OAuth callback: " + error.message);
  }
});

/* ======================================================
   🔹 ENDPOINT 3: Crear evento de prueba
====================================================== */
app.get("/test-event", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("calendar_tokens")
      .select("*")
      .eq("client_id", CLIENTE_FIJO)
      .eq("calendar_name", CAL_FIJO)
      .single();

    if (error) throw error;

    if (!data?.refresh_token) {
      return res
        .status(401)
        .send("⚠️ No hay token en Supabase. Entra a /auth primero.");
    }

    oAuth2Client.setCredentials({ refresh_token: data.refresh_token });

    const calendar = google.calendar({
      version: "v3",
      auth: oAuth2Client,
    });

    const start = new Date(Date.now() + 5 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    const event = {
      summary: "Prueba Proyecto Independizar (Supabase)",
      description: "Evento con token persistente en Supabase",
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    };

    const response = await calendar.events.insert({
      calendarId: data.google_calendar_id || "primary",
      requestBody: event,
    });

    res.send(
      `✅ Evento creado: <a href="${response.data.htmlLink}" target="_blank">Ver evento</a>`
    );
  } catch (error) {
    console.error(error);
    res.status(500).send("Error creando evento: " + error.message);
  }
});

/* ======================================================
   🔹 ENDPOINT 4: Obtener slots disponibles
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

    if (error) {
      console.error(error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      calendar_id,
      date,
      total: data?.length || 0,
      slots: data || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ PASO 2: POST /appointments (agendar)
   Body: calendar_id, customer_name, phone, start_at
====================================================== */
app.post("/appointments", async (req, res) => {
  try {
    const { calendar_id, customer_name, phone, start_at } = req.body || {};

    if (!calendar_id || !customer_name || !phone || !start_at) {
      return res.status(400).json({
        error: "Faltan campos: calendar_id, customer_name, phone, start_at",
      });
    }

    const startDate = new Date(start_at);
    if (Number.isNaN(startDate.getTime())) {
      return res.status(400).json({
        error: "start_at inválido. Usa ISO (ej: 2026-03-03T15:00:00-03:00)",
      });
    }

    // 1) Buscar tokens en Supabase
    const { data: tokenData, error: tokenError } = await supabase
      .from("calendar_tokens")
      .select("*")
      .eq("client_id", CLIENTE_FIJO)
      .eq("calendar_name", CAL_FIJO)
      .single();

    if (tokenError) throw tokenError;

    if (!tokenData?.refresh_token) {
      return res.status(401).json({
        error: "⚠️ No hay token en Supabase. Entra a /auth primero.",
      });
    }

    oAuth2Client.setCredentials({ refresh_token: tokenData.refresh_token });

    const calendar = google.calendar({
      version: "v3",
      auth: oAuth2Client,
    });

    // 2) Calcular end_at usando slot_minutes (por ahora fijo)
    const SLOT_MINUTES = Number(process.env.SLOT_MINUTES || 30);
    if (!Number.isFinite(SLOT_MINUTES) || SLOT_MINUTES <= 0) {
      return res.status(500).json({ error: "SLOT_MINUTES mal configurado" });
    }

    const endDate = new Date(startDate.getTime() + SLOT_MINUTES * 60 * 1000);

    // 3) Verificar overlap (choque)
    const listResp = await calendar.events.list({
      calendarId: tokenData.google_calendar_id || "primary",
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 10,
    });

    const items = listResp?.data?.items || [];
    const active = items.filter((e) => e.status !== "cancelled");

    if (active.length > 0) {
      return res.status(409).json({
        error: "ese horario ya no está disponible",
      });
    }

    // 4) Crear evento
    const event = {
      summary: `Cita - ${customer_name}`,
      description: `Cliente: ${customer_name}\nTeléfono: ${phone}\ncalendar_id: ${calendar_id}`,
      start: { dateTime: startDate.toISOString() },
      end: { dateTime: endDate.toISOString() },
    };

    const response = await calendar.events.insert({
      calendarId: tokenData.google_calendar_id || "primary",
      requestBody: event,
    });

    return res.status(201).json({
      ok: true,
      appointment: {
        calendar_id,
        event_id: response?.data?.id,
        start_at: startDate.toISOString(),
        end_at: endDate.toISOString(),
        customer_name,
        phone,
      },
    });
  } catch (error) {
    console.error("POST /appointments error:", error?.response?.data || error);
    return res.status(500).json({
      error: "Error creando cita",
      detail: error.message,
    });
  }
});

app.get("/_ping", (req, res) => {
  res.send("pong ✅");
});
app.post("/appointments", async (req, res) => {
  try {
    const {
      calendar_id,
      date,         // "YYYY-MM-DD" (en horario del calendario, ej America/Santiago)
      slot_start,   // ISO string con zona o UTC, ej "2026-03-18T14:00:00.000Z"
      customer_name,
      customer_phone,
      source = "web",
    } = req.body;

    if (!calendar_id || !date || !slot_start) {
      return res.status(400).json({
        error: "Faltan campos: calendar_id, date (YYYY-MM-DD) y slot_start (ISO)",
      });
    }

    // 1) Traer config del calendario (slot_minutes + buffer_minutes + tenant_id)
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

    const slotMinutes = cal.slot_minutes ?? 30;
    const bufferMinutes = cal.buffer_minutes ?? 0;

    // 2) Verificar que slot_start sea realmente un slot disponible (anti “doble reserva”)
    const { data: slots, error: slotsErr } = await supabase.rpc(
      "get_available_slots",
      { _calendar_id: calendar_id, _day: date }
    );

    if (slotsErr) {
      return res.status(500).json({ error: slotsErr.message });
    }

    const wantedStart = new Date(slot_start).toISOString();
    const found = (slots || []).some((s) => {
      // s.slot_start viene como string ISO con +00
      return new Date(s.slot_start).toISOString() === wantedStart;
    });

    if (!found) {
      return res.status(409).json({
        error: "Ese horario ya no está disponible",
        hint: "Vuelve a consultar /slots y elige otro slot_start",
      });
    }

    // 3) Calcular end_at = start + slot + buffer
    const start = new Date(slot_start);
    const end = new Date(start.getTime() + (slotMinutes + bufferMinutes) * 60 * 1000);

    // 4) Insertar cita (si hay choque, la DB lo rechazará por el constraint)
    const { data: appt, error: insErr } = await supabase
      .from("appointments")
      .insert({
        tenant_id: cal.tenant_id,
        calendar_id,
        customer_name: customer_name ?? null,
        customer_phone: customer_phone ?? null,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        source,
        status: "booked",
      })
      .select("*")
      .single();

    if (insErr) {
      // Si hay overlap constraint, lo tratamos como conflicto
      const msg = (insErr.message || "").toLowerCase();
      if (msg.includes("overlap") || msg.includes("conflict") || msg.includes("exclude")) {
        return res.status(409).json({ error: "Choque de horario (ya reservado)" });
      }
      return res.status(500).json({ error: insErr.message });
    }

    return res.status(201).json({ ok: true, appointment: appt });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.delete("/appointments/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // 1) Buscar la cita en BD
    const { data: appt, error: apptErr } = await supabase
      .from("appointments")
      .select("*")
      .eq("id", id)
      .single();

    if (apptErr || !appt) {
      return res.status(404).json({ error: "Appointment no encontrado" });
    }

    // 2) Borrar evento en Google Calendar (si existe event_id)
    if (appt.event_id) {
      const { data: tokenRow, error: tokErr } = await supabase
        .from("calendar_tokens")
        .select("*")
        .eq("client_id", CLIENTE_FIJO)
        .eq("calendar_name", CAL_FIJO)
        .single();

      if (!tokErr && tokenRow?.refresh_token) {
        oAuth2Client.setCredentials({ refresh_token: tokenRow.refresh_token });

        const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

        await calendar.events.delete({
          calendarId: tokenRow.google_calendar_id || "primary",
          eventId: appt.event_id,
        });
      }
    }

    // 3) Borrar en Supabase
    const { error: delErr } = await supabase
      .from("appointments")
      .delete()
      .eq("id", id);

    if (delErr) return res.status(500).json({ error: delErr.message });

    return res.json({ ok: true, deleted_id: id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.post("/appointments/slot", async (req, res) => {
  try {
    const {
      calendar_id,
      date, // "YYYY-MM-DD"
      slot_start, // ISO (copiado desde /slots)
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
      .select("tenant_id, slot_minutes, buffer_minutes, is_active")
      .eq("id", calendar_id)
      .single();

    if (calErr || !cal) return res.status(404).json({ error: "Calendario no encontrado" });
    if (!cal.is_active) return res.status(400).json({ error: "Calendario inactivo" });

    const slotMinutes = cal.slot_minutes ?? 30;
    const bufferMinutes = cal.buffer_minutes ?? 0;

    const { data: slots, error: slotsErr } = await supabase.rpc("get_available_slots", {
      _calendar_id: calendar_id,
      _day: date,
    });

    if (slotsErr) return res.status(500).json({ error: slotsErr.message });

    const wantedStartIso = new Date(slot_start).toISOString();
    const ok = (slots || []).some((s) => new Date(s.slot_start).toISOString() === wantedStartIso);

    if (!ok) {
      return res.status(409).json({
        error: "Ese horario ya no está disponible. Vuelve a pedir slots y elige otro.",
      });
    }

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
        status: "booked",
        source,
      })
      .select("*")
      .single();

    if (insErr) {
      const msg = (insErr.message || "").toLowerCase();
      if (msg.includes("exclude") || msg.includes("overlap") || msg.includes("conflict")) {
        return res.status(409).json({ error: "Ese horario ya fue tomado (choque de horario)." });
      }
      return res.status(500).json({ error: insErr.message });
    }

    return res.status(201).json({ ok: true, appointment: appt });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
/* ======================================================
   🚀 INICIAR SERVIDOR
====================================================== */
app.listen(PORT, () => {
  console.log(`🚀 Servidor listo en http://localhost:${PORT}`);
});