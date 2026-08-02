const twilio = require("twilio");

// 👇 no rompe si no hay credenciales configuradas (mismo patrón que email.js)
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_API_KEY_SID &&
  process.env.TWILIO_API_KEY_SECRET
    ? twilio(process.env.TWILIO_API_KEY_SID, process.env.TWILIO_API_KEY_SECRET, {
        accountSid: process.env.TWILIO_ACCOUNT_SID,
      })
    : null;

function formatDateCL(dateInput) {
  return new Date(dateInput).toLocaleDateString("es-CL", {
    timeZone: "America/Santiago",
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function formatTimeCL(dateInput) {
  return new Date(dateInput).toLocaleTimeString("es-CL", {
    timeZone: "America/Santiago",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Normaliza a "whatsapp:+E164" sin duplicar el prefijo si ya viene incluido
// (ej: TWILIO_WHATSAPP_NUMBER en Render ya trae "whatsapp:" en el valor —
// anteponerlo de nuevo generaba "whatsapp:whatsapp:+..." y Twilio lo
// rechazaba con "The 'From' number ... is not a valid phone number").
function toWhatsAppAddress(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith("whatsapp:") ? trimmed : `whatsapp:${trimmed}`;
}

// Envía un mensaje de WhatsApp usando un Content Template ya aprobado.
// `to` debe venir en formato E.164 con "+" (ej: +56912345678). Nunca lanza:
// siempre devuelve { ok, reason } para que el flujo que llama (creación de
// cita, cron de recordatorios) jamás se rompa por un fallo de Twilio.
async function sendWhatsAppTemplate({ to, contentSid, variables }) {
  try {
    if (!twilioClient) {
      console.warn("⚠️ Twilio no configurado (faltan credenciales). WhatsApp omitido.");
      return { ok: false, reason: "not_configured" };
    }
    if (!contentSid) {
      console.warn("⚠️ contentSid faltante. WhatsApp omitido.");
      return { ok: false, reason: "missing_template" };
    }
    if (!to) {
      console.warn("⚠️ Número de destino faltante. WhatsApp omitido.");
      return { ok: false, reason: "missing_recipient" };
    }
    if (!process.env.TWILIO_WHATSAPP_NUMBER) {
      console.warn("⚠️ TWILIO_WHATSAPP_NUMBER no configurado. WhatsApp omitido.");
      return { ok: false, reason: "missing_sender" };
    }

    await twilioClient.messages.create({
      contentSid,
      contentVariables: JSON.stringify(variables || {}),
      from: toWhatsAppAddress(process.env.TWILIO_WHATSAPP_NUMBER),
      to: toWhatsAppAddress(to),
    });

    return { ok: true };
  } catch (error) {
    console.error("Error enviando WhatsApp:", error.message);
    return { ok: false, reason: "send_error", error: error.message };
  }
}

module.exports = { sendWhatsAppTemplate, formatDateCL, formatTimeCL };
