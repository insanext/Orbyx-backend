// email v3 pro (UI + veterinaria condicional)

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
  businessCategory,
  petName,
  petSpecies,
}) {
  try {
    const formattedDate = formatDate(startAt);

    const normalizedCategory = String(businessCategory || "")
      .trim()
      .toLowerCase();

    const isVeterinary =
      normalizedCategory === "veterinaria" ||
      normalizedCategory === "veterinary";

    const locationHtml = locationText
      ? `<p style="margin:6px 0 0; color:#334155; font-size:14px;">
          <strong>${locationType === "online" ? "Modalidad" : "Ubicación"}:</strong> ${locationText}
        </p>`
      : "";

    const addressHtml = address
      ? `<p style="margin:6px 0 0; color:#334155; font-size:14px;">
          <strong>📍 Dirección:</strong> ${address}
        </p>`
      : "";

    const phoneHtml = phone
      ? `<p style="margin:6px 0 0; color:#334155; font-size:14px;">
          <strong>📞 Teléfono:</strong> ${phone}
        </p>`
      : "";

    const petHtml =
      isVeterinary && (petName || petSpecies)
        ? `
          <div style="margin-top:16px; padding-top:16px; border-top:1px solid #e2e8f0;">
            <p style="margin:0 0 10px; font-size:15px; color:#0f172a;">
              <strong>🐶 Mascota:</strong> ${petName || "-"}
            </p>

            <p style="margin:0; font-size:15px; color:#0f172a;">
              <strong>🐾 Especie:</strong> ${petSpecies || "-"}
            </p>
          </div>
        `
        : "";

    await resend.emails.send({
      from: "Orbyx <reservas@notificaciones.orbyx.cl>",
      to: email,
      subject: `Reserva confirmada · ${businessName || "Orbyx"}`,
      html: `
<div style="margin:0; padding:40px 16px; background:#f1f5f9; font-family:Arial, Helvetica, sans-serif;">

  <div style="max-width:560px; margin:0 auto;">

    <div style="background:#ffffff; border-radius:20px; overflow:hidden; box-shadow:0 20px 60px rgba(15,23,42,0.12);">

      <div style="background:linear-gradient(135deg,#0f172a,#312e81); padding:30px 24px; text-align:center;">
        <div style="color:#cbd5e1; font-size:11px; letter-spacing:0.2em; text-transform:uppercase;">
          Reserva confirmada
        </div>

        <h1 style="margin:10px 0 0; color:#ffffff; font-size:30px;">
          ${businessName || "Orbyx"}
        </h1>
      </div>

      <div style="padding:28px;">

        <div style="display:inline-block; background:#dcfce7; color:#166534; padding:6px 12px; border-radius:999px; font-size:12px; font-weight:600; margin-bottom:14px;">
          ✔ Reserva agendada
        </div>

        <h2 style="margin:0 0 12px; color:#0f172a; font-size:20px;">
          Tu hora está confirmada
        </h2>

        <p style="margin:0 0 20px; color:#475569; font-size:14px; line-height:1.6;">
          Hola <strong>${customerName}</strong>, aquí tienes el detalle de tu reserva.
        </p>

        <div style="background:#f8fafc; border-radius:16px; padding:18px; border:1px solid #e2e8f0;">

          <p style="margin:0 0 10px; font-size:15px; color:#0f172a;">
            <strong>💼 Servicio:</strong> ${serviceName}
          </p>

          <p style="margin:0 0 10px; font-size:15px; color:#0f172a;">
            <strong>📅 Fecha:</strong> ${formattedDate}
          </p>

          ${addressHtml}
          ${phoneHtml}
          ${locationHtml}
          ${petHtml}

        </div>

        <div style="margin-top:26px; text-align:center;">
          <a
            href="${cancelUrl}"
            style="
              display:inline-block;
              background:linear-gradient(135deg,#0f172a,#1e293b);
              color:#ffffff;
              text-decoration:none;
              padding:14px 26px;
              border-radius:14px;
              font-size:14px;
              font-weight:700;
              box-shadow:0 10px 25px rgba(15,23,42,0.2);
            "
          >
            Cancelar reserva
          </a>
        </div>

        <p style="margin:22px 0 0; color:#64748b; font-size:13px; line-height:1.6;">
          Si necesitas reagendar, puedes cancelar esta reserva y elegir un nuevo horario.
        </p>

        ${
          address || phone
            ? `
          <div style="margin-top:18px; padding-top:18px; border-top:1px solid #e2e8f0;">
            <p style="margin:0; color:#64748b; font-size:13px;">
              Puedes comunicarte directamente con el local si tienes dudas.
            </p>
          </div>
        `
            : ""
        }

      </div>

      <div style="padding:16px; text-align:center; background:#f8fafc; border-top:1px solid #e2e8f0;">
        <span style="color:#94a3b8; font-size:12px;">
          © Orbyx · Sistema de reservas inteligentes
        </span>
      </div>

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