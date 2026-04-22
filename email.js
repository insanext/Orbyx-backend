const { Resend } = require("resend");

// 👇 no rompe si no hay API key
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

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
    // 👇 evita que explote en local
    if (!resend) {
      console.warn("⚠️ RESEND_API_KEY no configurada. Email omitido.");
      return;
    }

    const formattedDate = formatDate(startAt);

    const isVeterinary =
      String(businessCategory || "").toLowerCase() === "veterinaria";

    const petHtml =
      isVeterinary && (petName || petSpecies)
        ? `
        <div style="margin-top:16px; padding-top:16px; border-top:1px solid #e2e8f0;">
          <p style="margin:0 0 8px; font-size:15px;">
            <strong>🐶 Mascota:</strong> ${petName || "-"}
          </p>
          <p style="margin:0; font-size:15px;">
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
<div style="margin:0; padding:30px 16px; background:#f1f5f9; font-family:Arial, Helvetica, sans-serif;">

  <div style="max-width:560px; margin:0 auto;">

    <div style="background:#ffffff; border-radius:20px; overflow:hidden; box-shadow:0 20px 50px rgba(0,0,0,0.1);">

      <div style="background:linear-gradient(135deg,#0f172a,#312e81); padding:28px; text-align:center;">
        <div style="color:#cbd5e1; font-size:12px; letter-spacing:0.2em;">
          RESERVA CONFIRMADA
        </div>

        <h1 style="color:#ffffff; margin:10px 0 0; font-size:26px;">
          ${businessName}
        </h1>
      </div>

      <div style="padding:24px;">

        <div style="background:#dcfce7; color:#166534; display:inline-block; padding:6px 12px; border-radius:999px; font-size:12px; margin-bottom:12px;">
          ✔ Reserva agendada
        </div>

        <h2 style="margin:0 0 10px;">Tu hora está confirmada</h2>

        <p style="color:#475569;">
          Hola <strong>${customerName}</strong>, aquí tienes el detalle de tu reserva.
        </p>

        <div style="background:#f8fafc; padding:16px; border-radius:14px; border:1px solid #e2e8f0; margin-top:16px;">

          <p><strong>💼 Servicio:</strong> ${serviceName}</p>
          <p><strong>📅 Fecha:</strong> ${formattedDate}</p>

          ${address ? `<p><strong>📍 Dirección:</strong> ${address}</p>` : ""}
          ${phone ? `<p><strong>📞 Teléfono:</strong> ${phone}</p>` : ""}
          ${
            locationText
              ? `<p><strong>📌 ${locationType === "online" ? "Modalidad" : "Ubicación"}:</strong> ${locationText}</p>`
              : ""
          }

          ${petHtml}

        </div>

        <div style="text-align:center; margin-top:24px;">
          <a href="${cancelUrl}" style="background:#0f172a; color:white; padding:12px 20px; border-radius:12px; text-decoration:none; font-weight:bold;">
            Cancelar reserva
          </a>
        </div>

        <p style="margin-top:20px; font-size:13px; color:#64748b;">
          Puedes cancelar y reagendar cuando lo necesites.
        </p>

      </div>

      <div style="padding:16px; text-align:center; border-top:1px solid #e2e8f0; background:#f8fafc;">
        <a 
          href="https://orbyx.cl"
          style="color:#64748b; font-size:12px; text-decoration:none;"
          target="_blank"
        >
          Orbyx · Sistema de reservas inteligentes
        </a>
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