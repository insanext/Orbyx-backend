// force deploy email v2
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
  businessName,
  serviceName,
  startAt,
  cancelUrl,
  address,
  phone,
  locationType,
  locationText,
}) {
  try {
    const formattedDate = formatDate(startAt);

    const locationHtml = locationText
      ? `<p style="margin:6px 0 0; color:#334155; font-size:14px;">
          <strong>${locationType === "online" ? "Modalidad" : "Ubicación"}:</strong> ${locationText}
        </p>`
      : "";

    const addressHtml = address
      ? `<p style="margin:6px 0 0; color:#334155; font-size:14px;">
          <strong>Dirección:</strong> ${address}
        </p>`
      : "";

    const phoneHtml = phone
      ? `<p style="margin:6px 0 0; color:#334155; font-size:14px;">
          <strong>Teléfono:</strong> ${phone}
        </p>`
      : "";

    await resend.emails.send({
      from: "Orbyx <reservas@notificaciones.orbyx.cl>",
      to: email,
      subject: `Reserva confirmada · ${businessName || "Orbyx"}`,
      html: `
        <div style="margin:0; padding:30px 16px; background:#f8fafc; font-family:Arial, Helvetica, sans-serif;">
          <div style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:18px; overflow:hidden; box-shadow:0 12px 32px rgba(15,23,42,0.10);">

            <div style="background:linear-gradient(135deg,#0f172a,#312e81); padding:28px 24px; text-align:center;">
              <div style="color:#cbd5e1; font-size:12px; letter-spacing:0.18em; text-transform:uppercase; margin-bottom:8px;">
                Reserva confirmada
              </div>
              <h1 style="margin:0; color:#ffffff; font-size:28px; line-height:1.2;">
                ${businessName || "Orbyx"}
              </h1>
            </div>

            <div style="padding:28px;">
              <h2 style="margin:0 0 14px; color:#0f172a; font-size:18px;">
                Tu hora quedó agendada ✅
              </h2>

              <p style="margin:0 0 18px; color:#334155; font-size:15px; line-height:1.6;">
                Hola <strong>${customerName}</strong>, te enviamos el detalle de tu reserva.
              </p>

              <div style="background:#f1f5f9; border-radius:14px; padding:18px 18px 14px;">
                <p style="margin:0 0 8px; color:#0f172a; font-size:15px;">
                  <strong>Servicio:</strong> ${serviceName}
                </p>

                <p style="margin:0; color:#0f172a; font-size:15px;">
                  <strong>Fecha:</strong> ${formattedDate}
                </p>

                ${addressHtml}
                ${phoneHtml}
                ${locationHtml}
              </div>

              <div style="margin-top:22px; text-align:center;">
                <a
                  href="${cancelUrl}"
                  style="
                    display:inline-block;
                    background:#0f172a;
                    color:#ffffff;
                    text-decoration:none;
                    padding:13px 22px;
                    border-radius:12px;
                    font-size:15px;
                    font-weight:700;
                  "
                >
                  Cancelar reserva
                </a>
              </div>

              <p style="margin:22px 0 0; color:#64748b; font-size:13px; line-height:1.6;">
                Si necesitas reagendar, puedes cancelar esta reserva y luego elegir un nuevo horario.
              </p>

              ${
                address || phone
                  ? `
                <div style="margin-top:18px; padding-top:18px; border-top:1px solid #e2e8f0;">
                  <p style="margin:0; color:#64748b; font-size:13px; line-height:1.6;">
                    Si tienes dudas, puedes comunicarte directamente con el local.
                  </p>
                </div>
              `
                  : ""
              }
            </div>

            <div style="padding:18px 24px; text-align:center; border-top:1px solid #e2e8f0; background:#ffffff;">
              <a
                href="https://orbyx.cl"
                style="color:#64748b; text-decoration:none; font-size:12px;"
                target="_blank"
                rel="noopener noreferrer"
              >
                © Orbyx · Sistema de reservas inteligentes
              </a>
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