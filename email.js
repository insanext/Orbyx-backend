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
}) {
  try {
    const formattedDate = formatDate(startAt);

    await resend.emails.send({
      from: "Orbyx <reservas@notificaciones.orbyx.cl>",
      to: email,
      subject: "Recuerda tu reserva de mañana",
      html: `
        <h2>Reserva confirmada</h2>

        <p>Hola ${customerName}</p>

        <p>Tu reserva fue agendada:</p>

        <p>
        <strong>Servicio:</strong> ${serviceName}<br/>
        <strong>Fecha:</strong> ${formattedDate}
        </p>

        <p style="margin-top:20px;">
          <a href="${cancelUrl}" 
          style="background:black;color:white;padding:10px 16px;border-radius:6px;text-decoration:none;">
          Cancelar reserva
          </a>
        </p>

        <p>Equipo Orbyx</p>
      `,
    });
  } catch (error) {
    console.error("Error enviando email:", error);
  }
}

module.exports = { sendBookingEmail };