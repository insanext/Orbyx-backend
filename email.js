const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendBookingEmail({ email, customerName, serviceName, startAt, cancelUrl }) {
  try {
    await resend.emails.send({
      from: "Orbyx <reservas@notificaciones.orbyx.cl>",
      to: email,
      subject: "Confirmación de reserva",
      html: `
        <h2>Reserva confirmada</h2>
        <p>Hola ${customerName}</p>

        <p>Tu reserva fue agendada:</p>

        <b>Servicio:</b> ${serviceName}<br/>
        <b>Fecha:</b> ${startAt}<br/><br/>

        <a href="${cancelUrl}" 
        style="background:black;color:white;padding:10px 15px;border-radius:6px;text-decoration:none;">
        Cancelar reserva
        </a>

        <p style="margin-top:20px;">Equipo Orbyx</p>
      `
    });
  } catch (error) {
    console.error("Error enviando email:", error);
  }
}

module.exports = { sendBookingEmail };