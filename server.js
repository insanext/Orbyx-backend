require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");
const { supabase } = require("./supabaseClient");

const app = express();
const PORT = process.env.PORT || 3000;

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
app.get("/_ping", (req, res) => {
  res.send("pong ✅");
});
/* ======================================================
   🚀 INICIAR SERVIDOR
====================================================== */
app.listen(PORT, () => {
  console.log(`🚀 Servidor listo en http://localhost:${PORT}`);
});