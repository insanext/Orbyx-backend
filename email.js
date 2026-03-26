const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

function formatDate(dateString) {
  const date = new Date(dateString);

  return date.toLocaleString("es-CL", {
    timeZone: "America/Santiago",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function sendBookingEmail({
  email,
  customerName,
  serviceName,
  startAt,
  cancelUrl,
  locationType,
  locationText,
}) {
  try {
    const formattedDate = formatDate(startAt);

    const locationHtml = locationText
      ? `<p style="margin:4px 0;"><strong>${
          locationType === "online" ? "Modalidad" : "Ubicación"
        }:</strong> ${locationText}</p>`
      : "";

    await resend.emails.send({
      from: "Orbyx <reservas@notificaciones.orbyx.cl>",
      to: email,
      subject: "Reserva confirmada",
      html: `
        <div style="font-family: Arial, sans-serif; background:#f8fafc; padding:30px;">
          <div style="max-width:520px; margin:0 auto; background:white; border-radius:16px; overflow:hidden; box-shadow:0 10px 30px rgba(0,0,0,0.08);">

            <div style="background:linear-gradient(135deg,#0f172a,#312e81); padding:20px; text-align:center;">
              <h1 style="color:white; margin:0; font-size:20px;">Orbyx</h1>
            </div>

            <div style="padding:24px;">
              <h2 style="margin-top:0; color:#0f172a;">Reserva confirmada ✅</h2>

              <p style="color:#334155;">Hola <strong>${customerName}</strong>,</p>

              <p style="color:#334155;">
                Tu hora fue agendada correctamente.
              </p>

              <div style="margin-top:16px; padding:16px; border-radius:12px; background:#f1f5f9;">
                <p style="margin:4px 0;"><strong>Servicio:</strong> ${serviceName}</p>
                <p style="margin:4px 0;"><strong>Fecha:</strong> ${formattedDate}</p>
                ${locationHtml}
              </div>

              <div style="margin-top:24px; text-align:center;">
                <a
                  href="${cancelUrl}"
                  style="
                    display:inline-block;
                    background:#0f172a;
                    color:white;
                    padding:12px 20px;
                    border-radius:10px;
                    text-decoration:none;
                    font-weight:bold;
                  "
                >
                  Cancelar reserva
                </a>
              </div>

              <p style="margin-top:24px; font-size:13px; color:#64748b;">
                Si necesitas reagendar, puedes cancelar tu reserva y elegir un nuevo horario.
              </p>
            </div>

            <div style="padding:16px; text-align:center; font-size:12px; color:#94a3b8;">
              © Orbyx · Sistema de reservas inteligentes
            </div>
          </div>
        </div>
      `,
    });
  } catch (error) {
    console.error("Error enviando email:", error);
  }
}

module.exports = { sendBookingEmail };