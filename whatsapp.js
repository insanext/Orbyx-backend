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

    const payload = {
      contentSid,
      contentVariables: JSON.stringify(variables || {}),
      from: toWhatsAppAddress(process.env.TWILIO_WHATSAPP_NUMBER),
      to: toWhatsAppAddress(to),
    };

    console.log(
      `[WA] Llamando a Twilio messages.create — from=${payload.from} to=${payload.to} contentSid=${payload.contentSid}`
    );

    // El SDK de Twilio (v6) no expone un timeout configurable en el
    // constructor público sin implementar un httpClient custom. En vez de
    // eso, se corre una carrera contra un timeout manual: si Twilio no
    // responde en SEND_TIMEOUT_MS, se loguea explícitamente como timeout en
    // vez de quedar colgado en silencio. Esto no cancela la request real —
    // si el timeout se dispara y la request original responde más tarde,
    // igual queda logueada abajo (etiquetada "tardía") para saber si
    // realmente era lentitud de Twilio y no un fallo total.
    const SEND_TIMEOUT_MS = 15000;
    let timedOut = false;
    const createPromise = twilioClient.messages.create(payload);

    createPromise
      .then((lateMessage) => {
        if (timedOut) {
          console.log(
            `[WA] Twilio respondió DESPUÉS del timeout local — sid=${lateMessage.sid} status=${lateMessage.status}`
          );
        }
      })
      .catch((lateError) => {
        if (timedOut) {
          console.error(
            `[WA] Twilio respondió con error DESPUÉS del timeout local — message=${lateError.message} code=${lateError.code} status=${lateError.status} moreInfo=${lateError.moreInfo}`
          );
        }
      });

    const message = await Promise.race([
      createPromise,
      new Promise((_, reject) =>
        setTimeout(() => {
          timedOut = true;
          reject(Object.assign(new Error(`Timeout: Twilio no respondió en ${SEND_TIMEOUT_MS}ms`), { code: "local_timeout" }));
        }, SEND_TIMEOUT_MS)
      ),
    ]);

    console.log(`[WA] Twilio OK — sid=${message.sid} status=${message.status}`);
    return { ok: true, sid: message.sid };
  } catch (error) {
    console.error(
      `[WA] Twilio ERROR — message=${error.message} code=${error.code} status=${error.status} moreInfo=${error.moreInfo}`
    );
    return { ok: false, reason: "send_error", error: error.message };
  }
}

module.exports = { sendWhatsAppTemplate, formatDateCL, formatTimeCL };
