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

    const isVeterinary = ["veterinaria", "vet"].includes(
      String(businessCategory || "").toLowerCase()
    );

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

async function sendInvitationEmail({ email, businessName, role, token }) {
  console.log("[INVITE EMAIL] Intentando enviar a:", email);
  try {
    if (!resend) {
      console.warn("⚠️ RESEND_API_KEY no configurada. Email de invitación omitido.");
      return;
    }

    const roleLabels = {
      admin: "Administrador",
      branch: "Operador de sucursal",
      readonly: "Solo lectura",
    };
    const roleLabel = roleLabels[role] || role;
    const inviteUrl = `https://www.orbyx.cl/invite/${token}`;

    console.log("[INVITE EMAIL] Llamando a Resend con from:", process.env.RESEND_FROM_EMAIL);
    const { data, error } = await resend.emails.send({
      from: "Orbyx <reservas@notificaciones.orbyx.cl>",
      to: email,
      subject: `Te invitaron a gestionar ${businessName || "un negocio"} en Orbyx`,
      html: `
<div style="margin:0; padding:30px 16px; background:#f1f5f9; font-family:Arial, Helvetica, sans-serif;">

  <div style="max-width:560px; margin:0 auto;">

    <div style="background:#ffffff; border-radius:20px; overflow:hidden; box-shadow:0 20px 50px rgba(0,0,0,0.1);">

      <div style="background:linear-gradient(135deg,#0f172a,#312e81); padding:28px; text-align:center;">
        <div style="color:#cbd5e1; font-size:12px; letter-spacing:0.2em;">
          INVITACIÓN AL EQUIPO
        </div>
        <h1 style="color:#ffffff; margin:10px 0 0; font-size:26px;">
          ${businessName || "Orbyx"}
        </h1>
      </div>

      <div style="padding:24px;">

        <div style="background:#dbeafe; color:#1e40af; display:inline-block; padding:6px 12px; border-radius:999px; font-size:12px; margin-bottom:12px;">
          ✉ Nueva invitación
        </div>

        <h2 style="margin:0 0 10px;">Te invitaron a colaborar</h2>

        <p style="color:#475569;">
          Fuiste invitado a gestionar <strong>${businessName || "un negocio"}</strong> en Orbyx
          con el rol de <strong>${roleLabel}</strong>.
        </p>

        <p style="color:#475569;">
          El enlace expira en <strong>7 días</strong>. Si no esperabas esta invitación, puedes ignorar este correo.
        </p>

        <div style="text-align:center; margin-top:24px;">
          <a href="${inviteUrl}" style="background:#0f172a; color:white; padding:12px 24px; border-radius:12px; text-decoration:none; font-weight:bold; font-size:15px;">
            Aceptar invitación
          </a>
        </div>

        <p style="margin-top:20px; font-size:12px; color:#94a3b8; text-align:center;">
          O copia este enlace en tu navegador:<br/>
          <a href="${inviteUrl}" style="color:#6366f1;">${inviteUrl}</a>
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
    console.log("[INVITE EMAIL] Resultado de Resend:", JSON.stringify({ data, error }));
  } catch (error) {
    console.error("Error enviando email de invitación:", error);
    console.error("[INVITE EMAIL] Error:", JSON.stringify(error));
  }
}

async function sendEmailChangeConfirmationToOldEmail({ to, newEmail, token }) {
  try {
    if (!resend) {
      console.warn("⚠️ RESEND_API_KEY no configurada. Email de cambio de correo omitido.");
      return;
    }
    const confirmUrl = `https://www.orbyx.cl/account/confirm-email-change/old/${token}`;
    await resend.emails.send({
      from: "Orbyx <reservas@notificaciones.orbyx.cl>",
      to,
      subject: "Confirma el cambio de tu correo electrónico en Orbyx",
      html: `
<div style="margin:0; padding:30px 16px; background:#f1f5f9; font-family:Arial, Helvetica, sans-serif;">
  <div style="max-width:560px; margin:0 auto;">
    <div style="background:#ffffff; border-radius:20px; overflow:hidden; box-shadow:0 20px 50px rgba(0,0,0,0.1);">
      <div style="background:linear-gradient(135deg,#0f172a,#1e3a5f); padding:28px; text-align:center;">
        <div style="color:#cbd5e1; font-size:12px; letter-spacing:0.2em;">CAMBIO DE CORREO</div>
        <h1 style="color:#ffffff; margin:10px 0 0; font-size:26px;">Orbyx</h1>
      </div>
      <div style="padding:24px;">
        <div style="background:#fef9c3; color:#854d0e; display:inline-block; padding:6px 12px; border-radius:999px; font-size:12px; margin-bottom:12px;">
          ⚠ Paso 1 de 2 — Confirma desde tu correo actual
        </div>
        <h2 style="margin:0 0 10px;">Solicitud de cambio de correo</h2>
        <p style="color:#475569;">
          Recibimos una solicitud para cambiar el correo de tu cuenta al siguiente:
          <strong>${newEmail}</strong>.
        </p>
        <p style="color:#475569;">
          Si fuiste tú, haz clic en el botón para confirmar desde tu correo actual.
          Luego recibirás un segundo correo en <strong>${newEmail}</strong> para completar el proceso.
        </p>
        <p style="color:#94a3b8; font-size:13px;">
          Si no solicitaste este cambio, ignora este correo y tu cuenta no cambiará.
          El enlace expira en <strong>24 horas</strong>.
        </p>
        <div style="text-align:center; margin-top:24px;">
          <a href="${confirmUrl}" style="background:#0f172a; color:white; padding:12px 24px; border-radius:12px; text-decoration:none; font-weight:bold; font-size:15px;">
            Sí, solicité este cambio
          </a>
        </div>
        <p style="margin-top:20px; font-size:12px; color:#94a3b8; text-align:center;">
          O copia este enlace:<br/>
          <a href="${confirmUrl}" style="color:#6366f1;">${confirmUrl}</a>
        </p>
      </div>
      <div style="padding:16px; text-align:center; border-top:1px solid #e2e8f0; background:#f8fafc;">
        <a href="https://orbyx.cl" style="color:#64748b; font-size:12px; text-decoration:none;" target="_blank">
          Orbyx · Sistema de reservas inteligentes
        </a>
      </div>
    </div>
  </div>
</div>`,
    });
  } catch (error) {
    console.error("Error enviando email de confirmación (correo actual):", error);
  }
}

async function sendEmailChangeVerificationToNewEmail({ to, token }) {
  try {
    if (!resend) {
      console.warn("⚠️ RESEND_API_KEY no configurada. Email de verificación de nuevo correo omitido.");
      return;
    }
    const verifyUrl = `https://www.orbyx.cl/account/confirm-email-change/new/${token}`;
    await resend.emails.send({
      from: "Orbyx <reservas@notificaciones.orbyx.cl>",
      to,
      subject: "Verifica tu nuevo correo electrónico en Orbyx",
      html: `
<div style="margin:0; padding:30px 16px; background:#f1f5f9; font-family:Arial, Helvetica, sans-serif;">
  <div style="max-width:560px; margin:0 auto;">
    <div style="background:#ffffff; border-radius:20px; overflow:hidden; box-shadow:0 20px 50px rgba(0,0,0,0.1);">
      <div style="background:linear-gradient(135deg,#0f172a,#1e3a5f); padding:28px; text-align:center;">
        <div style="color:#cbd5e1; font-size:12px; letter-spacing:0.2em;">CAMBIO DE CORREO</div>
        <h1 style="color:#ffffff; margin:10px 0 0; font-size:26px;">Orbyx</h1>
      </div>
      <div style="padding:24px;">
        <div style="background:#dcfce7; color:#166534; display:inline-block; padding:6px 12px; border-radius:999px; font-size:12px; margin-bottom:12px;">
          ✔ Paso 2 de 2 — Verifica tu nuevo correo
        </div>
        <h2 style="margin:0 0 10px;">¡Ya casi está!</h2>
        <p style="color:#475569;">
          Tu correo actual ya confirmó el cambio. Ahora solo falta que verifiques
          <strong>${to}</strong> como tu nuevo correo en Orbyx.
        </p>
        <p style="color:#475569;">
          Haz clic en el botón para completar el cambio. Una vez verificado, podrás
          iniciar sesión con este correo.
        </p>
        <p style="color:#94a3b8; font-size:13px;">
          El enlace expira en <strong>24 horas</strong>.
          Si no solicitaste este cambio, ignora este correo.
        </p>
        <div style="text-align:center; margin-top:24px;">
          <a href="${verifyUrl}" style="background:#166534; color:white; padding:12px 24px; border-radius:12px; text-decoration:none; font-weight:bold; font-size:15px;">
            Confirmar nuevo correo
          </a>
        </div>
        <p style="margin-top:20px; font-size:12px; color:#94a3b8; text-align:center;">
          O copia este enlace:<br/>
          <a href="${verifyUrl}" style="color:#6366f1;">${verifyUrl}</a>
        </p>
      </div>
      <div style="padding:16px; text-align:center; border-top:1px solid #e2e8f0; background:#f8fafc;">
        <a href="https://orbyx.cl" style="color:#64748b; font-size:12px; text-decoration:none;" target="_blank">
          Orbyx · Sistema de reservas inteligentes
        </a>
      </div>
    </div>
  </div>
</div>`,
    });
  } catch (error) {
    console.error("Error enviando email de verificación (nuevo correo):", error);
  }
}

module.exports = {
  sendBookingEmail,
  sendInvitationEmail,
  sendEmailChangeConfirmationToOldEmail,
  sendEmailChangeVerificationToNewEmail,
};