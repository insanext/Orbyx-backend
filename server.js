require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// 🔐 Credenciales desde .env
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

// 📁 Ruta del archivo donde guardaremos el token
const TOKEN_PATH = path.join(__dirname, "token.json");

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

// 🔹 Cargar token si ya existe
if (fs.existsSync(TOKEN_PATH)) {
  const savedToken = JSON.parse(fs.readFileSync(TOKEN_PATH));
  oAuth2Client.setCredentials(savedToken);
  console.log("✅ token.json cargado correctamente");
} else {
  console.log("⚠️ No existe token.json. Debes autorizar en /auth");
}

// 🔹 Paso 1: Generar autorización
app.get("/auth", (req, res) => {
  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  res.send(`
    <h2>Autorizar Google Calendar</h2>
    <a href="${url}">Haz clic aquí para autorizar</a>
  `);
});

// 🔹 Paso 2: Callback de Google
app.get("/oauth2callback", async (req, res) => {
  try {
    const code = req.query.code;

    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    // 💾 Guardar token en archivo
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

    console.log("✅ token.json guardado correctamente");

    res.send("✅ Autorizado y guardado. Ahora entra a /test-event");
  } catch (error) {
    console.error(error);
    res.status(500).send("Error en OAuth callback");
  }
});

// 🔹 Crear evento de prueba
app.get("/test-event", async (req, res) => {
  try {
    if (!oAuth2Client.credentials || !oAuth2Client.credentials.access_token) {
      return res.status(401).send("⚠️ No hay token cargado. Entra a /auth primero.");
    }

    const calendar = google.calendar({
      version: "v3",
      auth: oAuth2Client,
    });

    const start = new Date(Date.now() + 5 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    const event = {
      summary: "Prueba Proyecto Independizar",
      description: "Evento con token persistente",
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    };

    const response = await calendar.events.insert({
      calendarId: "primary",
      requestBody: event,
    });

    res.send(
      `✅ Evento creado: <a href="${response.data.htmlLink}" target="_blank">Ver evento</a>`
    );
  } catch (error) {
    console.error(error);
    res.status(500).send("Error creando evento.");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor listo en http://localhost:${PORT}`);
});