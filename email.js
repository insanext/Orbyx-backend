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
  customerInstructions,
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

    const instructionsHtml = customerInstructions
      ? `
        <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:14px; padding:16px; margin-top:16px;">
          <p style="margin:0 0 6px; font-size:13px; font-weight:bold; color:#92400e; text-transform:uppercase; letter-spacing:0.05em;">
            📋 Instrucciones importantes
          </p>
          <p style="margin:0; font-size:14px; color:#78350f; white-space:pre-line;">${String(
            customerInstructions
          )
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}</p>
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

        ${instructionsHtml}

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

async function sendSignupRecoveryEmail({ to, token }) {
  try {
    if (!resend) {
      console.warn("⚠️ RESEND_API_KEY no configurada. Email de recuperación de registro omitido.");
      return;
    }
    const resumeUrl = `https://orbyx.cl/completar-registro?token=${token}`;
    await resend.emails.send({
      from: "Orbyx <reservas@notificaciones.orbyx.cl>",
      to,
      subject: "Tu pago fue exitoso — completa tu cuenta en Orbyx",
      html: `
<div style="margin:0; padding:30px 16px; background:#f1f5f9; font-family:Arial, Helvetica, sans-serif;">
  <div style="max-width:560px; margin:0 auto;">
    <div style="background:#ffffff; border-radius:20px; overflow:hidden; box-shadow:0 20px 50px rgba(0,0,0,0.1);">
      <div style="background:linear-gradient(135deg,#0f172a,#312e81); padding:28px; text-align:center;">
        <div style="color:#cbd5e1; font-size:12px; letter-spacing:0.2em;">PAGO CONFIRMADO</div>
        <h1 style="color:#ffffff; margin:10px 0 0; font-size:26px;">Orbyx</h1>
      </div>
      <div style="padding:24px;">
        <div style="background:#dcfce7; color:#166534; display:inline-block; padding:6px 12px; border-radius:999px; font-size:12px; margin-bottom:12px;">
          ✔ Tu pago fue exitoso
        </div>
        <h2 style="margin:0 0 10px;">Falta un paso para activar tu cuenta</h2>
        <p style="color:#475569;">
          Tu pago se procesó correctamente, pero tuvimos un problema técnico terminando de configurar tu cuenta.
          Haz clic en el botón para completar el registro — no se te cobrará de nuevo.
        </p>
        <div style="text-align:center; margin-top:24px;">
          <a href="${resumeUrl}" style="background:#0f172a; color:white; padding:12px 24px; border-radius:12px; text-decoration:none; font-weight:bold; font-size:15px;">
            Completar mi cuenta
          </a>
        </div>
        <p style="margin-top:20px; font-size:12px; color:#94a3b8; text-align:center;">
          O copia este enlace:<br/>
          <a href="${resumeUrl}" style="color:#6366f1;">${resumeUrl}</a>
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
    console.error("Error enviando email de recuperación de registro:", error);
  }
}

async function sendSignupStuckAlertEmail({ to, signupIntentId, email, planId, monto }) {
  try {
    if (!resend) {
      console.warn("⚠️ RESEND_API_KEY no configurada. Email de alerta interna omitido.");
      return;
    }
    await resend.emails.send({
      from: "Orbyx <reservas@notificaciones.orbyx.cl>",
      to,
      subject: `⚠️ signup_intent atascado sin completar: ${signupIntentId}`,
      html: `
<div style="font-family:Arial, Helvetica, sans-serif; padding:16px;">
  <h2>signup_intent pagado sin completar hace más de 24h</h2>
  <ul>
    <li><strong>signup_intent_id:</strong> ${signupIntentId}</li>
    <li><strong>email prospecto:</strong> ${email}</li>
    <li><strong>plan:</strong> ${planId}</li>
    <li><strong>monto:</strong> ${monto}</li>
  </ul>
  <p>Requiere seguimiento manual: esta persona pagó y no tiene cuenta ni logró usar el link de recuperación.</p>
</div>`,
    });
  } catch (error) {
    console.error("Error enviando email de alerta interna de signup:", error);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Igual que renderInline() en orbyx-web/app/terminos/page.tsx: divide en
// **negrita** y texto plano, escapando todo lo que no sea un marcador.
function inlineBold(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return parts
    .map((part) =>
      part.startsWith("**") && part.endsWith("**")
        ? `<strong>${escapeHtml(part.slice(2, -2))}</strong>`
        : escapeHtml(part)
    )
    .join("");
}

// Convierte el mismo modelo de bloques (h2/h3/p/ul/ol/table/hr) usado por la
// página /terminos a HTML apto para email (estilos inline, sin CSS externo).
function renderLegalBlocksToHtml(blocks) {
  let html = "";
  for (const block of blocks) {
    switch (block.t) {
      case "h2":
        html += `<h2 style="margin:26px 0 10px; font-size:18px; color:#0f172a; border-bottom:2px solid #e2e8f0; padding-bottom:6px;">${inlineBold(
          block.text
        )}</h2>`;
        break;
      case "h3":
        html += `<h3 style="margin:16px 0 8px; font-size:14.5px; color:#1e293b;">${inlineBold(
          block.text
        )}</h3>`;
        break;
      case "p":
        html += `<p style="margin:0 0 10px; font-size:13.5px; line-height:1.6; color:#334155;">${inlineBold(
          block.text
        )}</p>`;
        break;
      case "ul":
        html += `<ul style="margin:0 0 10px; padding-left:20px; font-size:13.5px; line-height:1.6; color:#334155;">${block.items
          .map((item) => `<li style="margin-bottom:4px;">${inlineBold(item)}</li>`)
          .join("")}</ul>`;
        break;
      case "ol":
        html += `<ol style="margin:0 0 10px; padding-left:20px; font-size:13.5px; line-height:1.6; color:#334155;">${block.items
          .map((item) => `<li style="margin-bottom:4px;">${inlineBold(item)}</li>`)
          .join("")}</ol>`;
        break;
      case "table": {
        const hasHeader = block.headers.some((h) => h.trim() !== "");
        const headHtml = hasHeader
          ? `<thead><tr>${block.headers
              .map(
                (h) =>
                  `<th style="text-align:left; padding:6px 10px; background:#f1f5f9; border:1px solid #e2e8f0; font-size:12px; color:#0f172a;">${inlineBold(
                    h
                  )}</th>`
              )
              .join("")}</tr></thead>`
          : "";
        const bodyHtml = `<tbody>${block.rows
          .map(
            (row) =>
              `<tr>${row
                .map(
                  (cell, ci) =>
                    `<td style="padding:6px 10px; border:1px solid #e2e8f0; font-size:12px; color:#334155;${
                      ci === 0 ? " font-weight:600; color:#0f172a; white-space:nowrap;" : ""
                    }">${inlineBold(cell)}</td>`
                )
                .join("")}</tr>`
          )
          .join("")}</tbody>`;
        html += `<div style="overflow-x:auto; margin:0 0 12px;"><table style="border-collapse:collapse; width:100%; min-width:420px;">${headHtml}${bodyHtml}</table></div>`;
        break;
      }
      case "hr":
        html += `<div style="height:1px; background:#e2e8f0; margin:18px 0;"></div>`;
        break;
    }
  }
  return html;
}

// Mismo contenido (texto sin alterar) que el array `content` de
// orbyx-web/app/terminos/page.tsx — mantener ambos en sincronía si se
// publica una nueva versión de los Términos.
const LEGAL_TERMS_BLOCKS = [
  { t: "h2", text: "Resumen breve" },
  { t: "p", text: "Antes del detalle, lo esencial:" },
  {
    t: "ul",
    items: [
      "Estos Términos son el contrato entre Orbyx y tu negocio.",
      "Orbyx te entrega una plataforma para gestionar reservas, clientes y comunicaciones. Tú decides cómo usarla.",
      "Los datos de tus clientes son **tuyos**. Orbyx los procesa por encargo tuyo, según el Anexo A.",
      "Puedes cancelar cuando quieras, sin penalización.",
      "Si cambiamos estos Términos de forma relevante, te avisamos con 30 días de anticipación y puedes terminar el contrato sin costo.",
      "Puedes descargar una copia de este contrato en cualquier momento, y te enviamos una al contratar.",
    ],
  },
  { t: "p", text: "Este resumen no reemplaza el texto completo ni modifica su contenido." },
  { t: "hr" },

  { t: "h2", text: "1. Identificación del prestador" },
  {
    t: "table",
    headers: ["", ""],
    rows: [
      ["**Razón social**", "Orbyx Soluciones Digitales SpA"],
      ["**RUT**", "78.453.137-6"],
      ["**Domicilio**", "PJE 21, 511, Comuna: TALCAHUANO, Región del Bíobio"],
      ["**Correo de contacto**", "contacto@orbyx.cl"],
      ["**Sitio web**", "orbyx.cl"],
    ],
  },
  { t: "hr" },

  { t: "h2", text: "2. Definiciones" },
  {
    t: "ul",
    items: [
      "**Orbyx**: Orbyx Soluciones Digitales SpA.",
      "**Cliente** o **Negocio**: la persona natural o jurídica que contrata el Servicio.",
      "**Servicio** o **Plataforma**: el software de gestión de reservas y clientes provisto por Orbyx.",
      "**Cliente Final**: la persona atendida por el Cliente y cuyos datos este registra en la Plataforma.",
      "**Cuenta**: el espacio lógico asignado al Cliente dentro de la Plataforma.",
      "**Datos del Cliente**: la información que el Cliente o sus Clientes Finales incorporan a la Plataforma.",
      "**Plan**: la modalidad de suscripción contratada.",
      "**Anexo A**: el Acuerdo de Tratamiento de Datos que forma parte integrante de estos Términos.",
    ],
  },
  { t: "hr" },

  { t: "h2", text: "3. Objeto y aceptación" },
  { t: "h3", text: "3.1 Objeto" },
  {
    t: "p",
    text: "Orbyx otorga al Cliente una licencia de uso, no exclusiva, intransferible y revocable, para acceder y utilizar la Plataforma durante la vigencia de la suscripción, conforme a estos Términos.",
  },
  { t: "h3", text: "3.2 Aceptación" },
  {
    t: "p",
    text: "Estos Términos se aceptan de forma electrónica al momento de crear una cuenta o contratar un Plan, mediante una acción afirmativa e inequívoca del Cliente.",
  },
  {
    t: "p",
    text: "Antes de aceptar, el Cliente tiene acceso al texto íntegro de estos Términos, de su Anexo A y de la Política de Privacidad, con la posibilidad de **almacenarlos e imprimirlos**. La sola visita al sitio web de Orbyx no genera obligación alguna para el Cliente.",
  },
  {
    t: "p",
    text: "Una vez perfeccionado el contrato, Orbyx enviará al Cliente, por correo electrónico, **confirmación escrita con una copia íntegra, clara y legible** de estos Términos y su Anexo A, indicando la versión y la fecha de aceptación.",
  },
  { t: "h3", text: "3.3 Capacidad" },
  {
    t: "p",
    text: "Quien acepta estos Términos declara tener facultades suficientes para obligar al Cliente. El Servicio está dirigido exclusivamente a personas mayores de edad que actúan en el ejercicio de una actividad comercial o profesional.",
  },
  { t: "hr" },

  { t: "h2", text: "4. Descripción del Servicio" },
  { t: "p", text: "La Plataforma permite al Cliente, según el Plan contratado:" },
  {
    t: "ul",
    items: [
      "Gestionar agenda, horarios y disponibilidad.",
      "Recibir y administrar reservas de sus propios clientes.",
      "Mantener una base de datos de clientes e historial de atenciones.",
      "Administrar servicios, precios, profesionales y sucursales.",
      "Registrar información de atención según el rubro, incluyendo fichas clínicas cuando corresponda.",
      "Enviar comunicaciones a sus clientes por correo electrónico y, cuando esté habilitado, por WhatsApp.",
      "Acceder a reportes y estadísticas de su operación.",
    ],
  },
  {
    t: "p",
    text: "Las funcionalidades específicas de cada Plan se detallan en orbyx.cl y pueden variar conforme a la sección 9.",
  },
  { t: "hr" },

  { t: "h2", text: "5. Registro y cuenta" },
  { t: "h3", text: "5.1 Información veraz" },
  {
    t: "p",
    text: "El Cliente debe proporcionar información veraz, completa y actualizada al registrarse, y mantenerla actualizada.",
  },
  { t: "h3", text: "5.2 Credenciales" },
  {
    t: "p",
    text: "El Cliente es responsable de mantener la confidencialidad de sus credenciales y de toda actividad realizada bajo su Cuenta. Debe notificar a Orbyx sin demora ante cualquier uso no autorizado.",
  },
  { t: "h3", text: "5.3 Usuarios internos" },
  {
    t: "p",
    text: "Si el Plan lo permite, el Cliente puede crear usuarios adicionales. El Cliente es responsable de la gestión de esos usuarios, de sus permisos y de su conducta dentro de la Plataforma.",
  },
  { t: "hr" },

  { t: "h2", text: "6. Planes, precios y pagos" },
  { t: "h3", text: "6.1 Planes vigentes" },
  {
    t: "table",
    headers: ["Plan", "Precio mensual"],
    rows: [
      ["Pro", "$12.990"],
      ["Premium", "$29.990"],
      ["VIP", "$54.990"],
      ["Platinum", "$149.990"],
    ],
  },
  {
    t: "p",
    text: "Los precios se expresan en pesos chilenos e incluyen los impuestos aplicables, salvo indicación distinta al momento de contratar.",
  },
  { t: "p", text: "Se aplican descuentos por pago semestral (10%) y anual (15%)." },
  { t: "h3", text: "6.2 Complementos" },
  {
    t: "p",
    text: "Determinados Planes permiten contratar complementos (paquetes de mensajes, usuarios o sucursales adicionales). Los complementos se facturan mensualmente con independencia del ciclo del Plan base y **no son acumulables**: las cuotas no utilizadas se reinician cada mes y no se traspasan al mes siguiente.",
  },
  { t: "h3", text: "6.3 Medio de pago" },
  {
    t: "p",
    text: "Los pagos se procesan a través de Flow, proveedor de servicios de pago. Orbyx no almacena los datos completos de las tarjetas.",
  },
  { t: "h3", text: "6.4 Cobro y renovación" },
  {
    t: "p",
    text: "La suscripción se renueva automáticamente al término de cada ciclo, cobrándose el medio de pago registrado, salvo que el Cliente la cancele antes de la fecha de renovación.",
  },
  {
    t: "p",
    text: "Orbyx informará al Cliente con anticipación razonable la fecha y el monto de cada renovación.",
  },
  { t: "h3", text: "6.5 Mora" },
  {
    t: "p",
    text: "El impago de una suscripción faculta a Orbyx para suspender el acceso al Servicio, previa notificación al Cliente y otorgándole un plazo razonable para regularizar. La suspensión no implica eliminación de los Datos del Cliente, que se rigen por la sección 14.",
  },
  { t: "hr" },

  { t: "h2", text: "7. Periodo de prueba" },
  { t: "p", text: "Orbyx puede ofrecer un periodo de prueba gratuito. Durante ese periodo:" },
  {
    t: "ul",
    items: [
      "El Cliente accede a las funcionalidades que Orbyx determine.",
      "No se realizan cobros mientras el periodo esté vigente.",
      "Orbyx informará con anticipación la fecha de término del periodo de prueba.",
      "El periodo de prueba **no otorga automáticamente beneficios de los Planes pagados**, tales como paquetes de mensajes.",
    ],
  },
  {
    t: "p",
    text: "Al término del periodo de prueba, el Cliente puede contratar un Plan o dejar de usar el Servicio. No se generan cobros sin una contratación expresa del Cliente.",
  },
  { t: "hr" },

  { t: "h2", text: "8. Cancelación" },
  { t: "h3", text: "8.1 Cancelación por el Cliente" },
  {
    t: "p",
    text: "El Cliente puede cancelar su suscripción **en cualquier momento y sin expresión de causa**, desde la propia Plataforma o escribiendo a contacto@orbyx.cl. La cancelación no genera penalización alguna.",
  },
  {
    t: "p",
    text: "La cancelación surte efecto al término del ciclo de facturación en curso. El Cliente mantiene acceso al Servicio hasta esa fecha.",
  },
  { t: "h3", text: "8.2 Efectos" },
  {
    t: "p",
    text: "Tras la cancelación, los Datos del Cliente se conservan y eliminan conforme a la sección 14 y al Anexo A.",
  },
  { t: "hr" },

  { t: "h2", text: "9. Modificaciones" },
  { t: "h3", text: "9.1 Modificaciones al Servicio" },
  {
    t: "p",
    text: "Orbyx puede incorporar, modificar o descontinuar funcionalidades. Cuando una modificación reduzca de forma sustancial las funcionalidades del Plan contratado, Orbyx lo comunicará al Cliente con **al menos 30 días corridos de anticipación**, y el Cliente podrá poner término al contrato sin penalización dentro de ese plazo, con derecho a la devolución proporcional de lo pagado y no utilizado.",
  },
  { t: "h3", text: "9.2 Modificaciones a estos Términos" },
  { t: "p", text: "Orbyx puede modificar estos Términos. Cuando la modificación sea sustancial:" },
  {
    t: "ul",
    items: [
      "Se comunicará al Cliente por correo electrónico y dentro de la Plataforma con **al menos 30 días corridos de anticipación** a su entrada en vigencia.",
      "El Cliente podrá **poner término al contrato sin penalización** dentro de ese plazo, con derecho a la devolución proporcional de lo pagado y no utilizado.",
      "Las modificaciones no se aplican retroactivamente.",
    ],
  },
  {
    t: "p",
    text: "**Orbyx no modificará unilateralmente el precio del Plan durante un ciclo ya pagado.** Los cambios de precio se comunicarán con al menos 30 días corridos de anticipación y regirán a partir del ciclo siguiente, pudiendo el Cliente cancelar sin penalización antes de esa fecha.",
  },
  { t: "hr" },

  { t: "h2", text: "10. Uso aceptable" },
  { t: "p", text: "El Cliente se obliga a no utilizar la Plataforma para:" },
  {
    t: "ul",
    items: [
      "Actividades ilícitas o contrarias al orden público.",
      "Almacenar o tratar información que no esté legalmente facultado para tratar.",
      "Enviar comunicaciones no solicitadas, engañosas o que infrinjan la normativa aplicable.",
      "Vulnerar derechos de terceros, incluidos derechos de propiedad intelectual y de protección de datos.",
      "Intentar acceder a datos, cuentas o entornos de otros clientes de Orbyx.",
      "Realizar ingeniería inversa, descompilar o intentar extraer el código fuente de la Plataforma.",
      "Sobrecargar deliberadamente la infraestructura o eludir límites técnicos o de cuota.",
      "Revender o sublicenciar el Servicio sin autorización escrita de Orbyx.",
    ],
  },
  { t: "hr" },

  { t: "h2", text: "11. Obligaciones del Cliente respecto de sus propios clientes" },
  {
    t: "p",
    text: "El Cliente reconoce y acepta que, respecto de los datos personales de sus Clientes Finales:",
  },
  {
    t: "ul",
    items: [
      "**El Cliente es el responsable del tratamiento.** Determina las finalidades y los medios.",
      "Debe contar con un fundamento jurídico válido para recopilar y tratar dichos datos.",
      "Debe informar adecuadamente a sus Clientes Finales sobre el tratamiento de sus datos.",
      "Debe obtener las autorizaciones que la ley exija, especialmente respecto de **datos sensibles** y de **niños, niñas y adolescentes**.",
      "Es responsable del contenido, la legitimidad y los destinatarios de las campañas y comunicaciones que envíe.",
      "Debe atender los derechos que sus Clientes Finales ejerzan sobre sus datos.",
      "Debe cumplir la normativa sectorial aplicable a su rubro, incluida la normativa sanitaria cuando corresponda.",
    ],
  },
  {
    t: "p",
    text: "El detalle del tratamiento que Orbyx realiza por encargo del Cliente se regula en el **Anexo A**.",
  },
  { t: "hr" },

  { t: "h2", text: "12. Comunicaciones por WhatsApp y correo electrónico" },
  { t: "h3", text: "12.1 Naturaleza del servicio" },
  {
    t: "p",
    text: "Orbyx provee la funcionalidad técnica que permite al Cliente enviar comunicaciones a sus Clientes Finales. Orbyx actúa como intermediario tecnológico y **no es el emisor** del contenido de dichas comunicaciones.",
  },
  { t: "h3", text: "12.2 Proveedores" },
  {
    t: "p",
    text: "Los mensajes de WhatsApp se envían a través de Twilio y de la plataforma WhatsApp Business operada por Meta. El uso de este canal está sujeto a las políticas de dichos proveedores, que pueden cambiar sin intervención de Orbyx.",
  },
  { t: "h3", text: "12.3 Cuotas" },
  {
    t: "p",
    text: "Los Planes incluyen cuotas mensuales de mensajes. Alcanzada la cuota, el envío puede suspenderse hasta el siguiente ciclo o hasta la contratación de un complemento. Orbyx notificará al Cliente cuando se aproxime al límite.",
  },
  { t: "h3", text: "12.4 Responsabilidad del contenido" },
  {
    t: "p",
    text: "El Cliente es el único responsable del contenido de los mensajes que envía y de contar con las autorizaciones necesarias de sus destinatarios. Orbyx puede suspender el envío ante usos manifiestamente ilícitos o abusivos, previa notificación al Cliente salvo que la urgencia lo impida.",
  },
  { t: "h3", text: "12.5 Limitaciones del canal" },
  {
    t: "p",
    text: "El Cliente reconoce que la entrega de mensajes depende de terceros (Meta, Twilio, operadores móviles) y que Orbyx no puede garantizar la entrega, el momento de entrega ni la lectura de cada mensaje.",
  },
  { t: "hr" },

  { t: "h2", text: "13. Disponibilidad y soporte" },
  { t: "h3", text: "13.1 Disponibilidad" },
  {
    t: "p",
    text: "Orbyx procura mantener el Servicio disponible de forma continua y adopta medidas razonables para ello. No obstante, el Servicio puede experimentar interrupciones por mantenimiento, actualizaciones, fallas de proveedores de infraestructura o eventos fuera del control de Orbyx.",
  },
  {
    t: "p",
    text: "Orbyx comunicará con anticipación razonable las mantenciones programadas que impliquen indisponibilidad relevante, salvo urgencias de seguridad.",
  },
  {
    t: "p",
    text: "**Orbyx no ofrece actualmente un acuerdo de nivel de servicio (SLA) con compromisos de disponibilidad garantizada.** Si lo incorpora, lo informará y actualizará estos Términos conforme a la sección 9.",
  },
  { t: "h3", text: "13.2 Soporte" },
  {
    t: "p",
    text: "El soporte se presta por correo electrónico a contacto@orbyx.cl, en días hábiles. El alcance y los tiempos de respuesta pueden variar según el Plan contratado.",
  },
  { t: "hr" },

  { t: "h2", text: "14. Datos del Cliente" },
  { t: "h3", text: "14.1 Titularidad" },
  {
    t: "p",
    text: "**Los Datos del Cliente son de su exclusiva titularidad.** Orbyx no adquiere derecho de propiedad alguno sobre ellos y no los utiliza para finalidades ajenas a la prestación del Servicio.",
  },
  { t: "h3", text: "14.2 Exportación" },
  {
    t: "p",
    text: "El Cliente puede solicitar una copia de la información asociada a su Cuenta, en formato estructurado y de uso común, escribiendo a contacto@orbyx.cl, sujeto a factibilidad técnica y a los derechos de terceros.",
  },
  { t: "h3", text: "14.3 Conservación tras la cancelación" },
  {
    t: "p",
    text: "Tras la cancelación de la Cuenta, los Datos del Cliente se conservan durante **12 meses**, plazo destinado a permitir la eventual reactivación, la recuperación o exportación de información y la resolución de controversias. Transcurrido ese plazo, son eliminados o anonimizados.",
  },
  {
    t: "p",
    text: "La documentación tributaria y contable se conserva por los plazos que exige la normativa aplicable.",
  },
  {
    t: "p",
    text: "El Cliente puede solicitar la eliminación anticipada de sus datos escribiendo a contacto@orbyx.cl, sin perjuicio de la información que Orbyx deba conservar por mandato legal.",
  },
  { t: "hr" },

  { t: "h2", text: "15. Propiedad intelectual" },
  { t: "h3", text: "15.1 De Orbyx" },
  {
    t: "p",
    text: "La Plataforma, su código, diseño, marcas, documentación y todo elemento que la compone son de propiedad de Orbyx o de sus licenciantes. Estos Términos no transfieren al Cliente derecho de propiedad intelectual alguno, salvo la licencia de uso descrita en la sección 3.1.",
  },
  { t: "h3", text: "15.2 Del Cliente" },
  {
    t: "p",
    text: "El Cliente conserva todos los derechos sobre su marca, logotipos, contenidos y Datos del Cliente. Otorga a Orbyx una licencia limitada para alojarlos, procesarlos y mostrarlos exclusivamente en la medida necesaria para prestar el Servicio.",
  },
  { t: "h3", text: "15.3 Sugerencias" },
  {
    t: "p",
    text: "Si el Cliente propone mejoras o funcionalidades, Orbyx puede implementarlas libremente, sin que ello genere obligación de pago ni derecho de propiedad a favor del Cliente.",
  },
  { t: "hr" },

  { t: "h2", text: "16. Confidencialidad" },
  {
    t: "p",
    text: "Cada parte se obliga a mantener en reserva la información confidencial de la otra a la que acceda con ocasión de este contrato, y a no divulgarla ni utilizarla para fines distintos de la ejecución del contrato.",
  },
  {
    t: "p",
    text: "Esta obligación subsiste durante la vigencia del contrato y por **cinco años** contados desde su término. No aplica a información que sea pública, que la parte receptora ya poseyera legítimamente, o cuya divulgación sea exigida por autoridad competente.",
  },
  { t: "hr" },

  { t: "h2", text: "17. Protección de datos personales" },
  { t: "p", text: "El tratamiento de datos personales se rige por:" },
  {
    t: "ul",
    items: [
      "La **Política de Privacidad** de Orbyx, publicada en orbyx.cl/privacidad.",
      "El **Anexo A — Acuerdo de Tratamiento de Datos**, que forma parte integrante de estos Términos.",
    ],
  },
  {
    t: "p",
    text: "En caso de discrepancia entre estos Términos y el Anexo A en materia de tratamiento de datos personales, **prevalece el Anexo A**.",
  },
  { t: "hr" },

  { t: "h2", text: "18. Responsabilidad" },
  { t: "h3", text: "18.1 Responsabilidad de Orbyx" },
  {
    t: "p",
    text: "Orbyx responde de los perjuicios que cause al Cliente por el incumplimiento de sus obligaciones bajo estos Términos, conforme a las reglas generales del derecho chileno.",
  },
  {
    t: "p",
    text: "**Orbyx no excluye ni limita su responsabilidad** por dolo, culpa grave, daños a las personas, ni en aquellos casos en que la ley no permita limitarla.",
  },
  { t: "h3", text: "18.2 Limitación" },
  {
    t: "p",
    text: "Fuera de los casos señalados en el párrafo anterior, y en la medida en que la ley lo permita, la responsabilidad de Orbyx por perjuicios derivados de la prestación del Servicio se limita al monto efectivamente pagado por el Cliente durante los doce meses anteriores al hecho que origina la responsabilidad.",
  },
  {
    t: "p",
    text: "Esta limitación no resulta aplicable cuando el Cliente sea una micro o pequeña empresa y la ley disponga su improcedencia.",
  },
  { t: "h3", text: "18.3 Responsabilidad del Cliente" },
  {
    t: "p",
    text: "El Cliente responde frente a Orbyx por los perjuicios derivados del uso de la Plataforma en infracción a estos Términos, en particular por el tratamiento ilícito de datos de sus Clientes Finales y por el contenido de las comunicaciones que envíe.",
  },
  { t: "h3", text: "18.4 Terceros" },
  {
    t: "p",
    text: "Orbyx no responde por interrupciones, fallas o cambios de política de proveedores de terceros (Meta, Twilio, Flow, proveedores de infraestructura), sin perjuicio de su deber de elegirlos con diligencia y de adoptar medidas razonables ante incidencias.",
  },
  { t: "hr" },

  { t: "h2", text: "19. Suspensión y término por Orbyx" },
  { t: "h3", text: "19.1 Causales" },
  { t: "p", text: "Orbyx puede suspender o terminar el Servicio cuando el Cliente:" },
  {
    t: "ul",
    items: [
      "Incumpla gravemente estos Términos.",
      "Utilice la Plataforma para fines ilícitos.",
      "No pague la suscripción en los términos de la sección 6.5.",
      "Ponga en riesgo la seguridad o el funcionamiento de la Plataforma o de otros clientes.",
    ],
  },
  { t: "h3", text: "19.2 Procedimiento" },
  {
    t: "p",
    text: "Salvo casos de ilicitud manifiesta o riesgo grave e inminente de seguridad, Orbyx **notificará previamente** al Cliente, describiendo el incumplimiento y otorgándole un plazo razonable, no inferior a **10 días corridos**, para subsanarlo.",
  },
  { t: "h3", text: "19.3 Efectos" },
  {
    t: "p",
    text: "Terminado el contrato por esta causa, el Cliente mantiene el derecho a exportar sus datos conforme a la sección 14.2 durante el plazo de conservación establecido en la sección 14.3.",
  },
  { t: "hr" },

  { t: "h2", text: "20. Fuerza mayor" },
  {
    t: "p",
    text: "Ninguna parte responde por el incumplimiento de sus obligaciones cuando este se deba a caso fortuito o fuerza mayor, en los términos del artículo 45 del Código Civil. La parte afectada deberá informarlo a la otra tan pronto como sea posible.",
  },
  { t: "hr" },

  { t: "h2", text: "21. Cesión" },
  { t: "p", text: "El Cliente no puede ceder este contrato sin autorización escrita de Orbyx." },
  {
    t: "p",
    text: "Orbyx puede ceder este contrato en caso de reorganización societaria, fusión o venta de activos, informando al Cliente con anticipación razonable. Si la cesión implica un cambio sustancial en las condiciones del Servicio, el Cliente puede terminar el contrato sin penalización, con devolución proporcional de lo pagado y no utilizado.",
  },
  { t: "hr" },

  { t: "h2", text: "22. Comunicaciones" },
  {
    t: "p",
    text: "Las comunicaciones de Orbyx al Cliente se realizarán al correo electrónico registrado en la Cuenta o mediante avisos dentro de la Plataforma. Es responsabilidad del Cliente mantener actualizado su correo.",
  },
  { t: "p", text: "Las comunicaciones del Cliente a Orbyx se dirigirán a **contacto@orbyx.cl**." },
  { t: "hr" },

  { t: "h2", text: "23. Nulidad parcial" },
  {
    t: "p",
    text: "Si alguna disposición de estos Términos fuere declarada nula o inaplicable, las demás mantendrán su plena vigencia, y la disposición afectada se entenderá reemplazada por aquella que más se aproxime a su finalidad dentro del marco legal.",
  },
  { t: "hr" },

  { t: "h2", text: "24. Legislación aplicable y competencia" },
  { t: "p", text: "Estos Términos se rigen por las leyes de la República de Chile." },
  {
    t: "p",
    text: "Cualquier controversia será sometida a los tribunales ordinarios de justicia competentes conforme a las reglas generales.",
  },
  {
    t: "p",
    text: "**Cuando el Cliente sea una micro o pequeña empresa**, en los términos de la Ley N° 20.416, le resultan aplicables las normas establecidas en su favor por la Ley N° 19.496 en las materias que dicha ley señala. **Esta protección es irrenunciable anticipadamente**, y nada en estos Términos podrá interpretarse como una renuncia a ella ni como una alteración de las reglas de competencia que la ley establezca en su favor.",
  },
  { t: "hr" },

  { t: "h2", text: "25. Vigencia y versiones" },
  {
    t: "p",
    text: "Estos Términos entran en vigencia en la fecha indicada al inicio y permanecen vigentes mientras el Cliente mantenga una Cuenta activa.",
  },
  {
    t: "p",
    text: "Orbyx conserva el registro de la versión aceptada por cada Cliente y la fecha de aceptación. El Cliente puede solicitar copia de la versión que aceptó escribiendo a contacto@orbyx.cl.",
  },
  { t: "hr" },

  { t: "h2", text: "ANEXO A — Acuerdo de Tratamiento de Datos (DPA)" },
  {
    t: "p",
    text: "**Forma parte integrante de los Términos de Servicio de Orbyx Soluciones Digitales SpA.**",
  },
  { t: "h3", text: "A.1 Partes y ámbito" },
  {
    t: "p",
    text: 'Este Acuerdo regula el tratamiento de datos personales que **Orbyx Soluciones Digitales SpA** ("Orbyx") realiza **por encargo del Cliente**, en el marco de la prestación del Servicio.',
  },
  {
    t: "p",
    text: "Se aplica exclusivamente a los datos personales de los **Clientes Finales** y demás titulares cuyos datos el Cliente incorpore a la Plataforma.",
  },
  {
    t: "p",
    text: "No se aplica a los datos respecto de los cuales Orbyx actúa como responsable, regulados en la Política de Privacidad.",
  },
  { t: "h3", text: "A.2 Rol de las partes" },
  {
    t: "table",
    headers: ["Parte", "Rol"],
    rows: [
      ["**El Cliente**", "Responsable de datos. Determina las finalidades y los medios del tratamiento."],
      [
        "**Orbyx**",
        "Tercero mandatario o encargado. Trata los datos conforme al encargo y a las instrucciones del Cliente.",
      ],
    ],
  },
  { t: "h3", text: "A.3 Elementos del encargo" },
  {
    t: "p",
    text: "Conforme a la legislación chilena aplicable, el encargo queda definido en los siguientes términos:",
  },
  { t: "h3", text: "A.3.1 Objeto" },
  {
    t: "p",
    text: "La prestación del Servicio descrito en los Términos: alojamiento, procesamiento y puesta a disposición de la información necesaria para que el Cliente gestione su agenda, sus reservas, su base de clientes y sus comunicaciones.",
  },
  { t: "h3", text: "A.3.2 Duración" },
  {
    t: "p",
    text: "Desde la aceptación de los Términos y mientras la Cuenta permanezca activa, extendiéndose por el plazo de conservación establecido en la cláusula A.10.",
  },
  { t: "h3", text: "A.3.3 Finalidad" },
  {
    t: "p",
    text: "Exclusivamente la ejecución del Servicio contratado. Orbyx **no tratará estos datos para finalidades propias** ni distintas de las convenidas.",
  },
  { t: "p", text: "En particular, Orbyx **no utilizará** los datos de los Clientes Finales para:" },
  {
    t: "ul",
    items: [
      "Promocionar sus propios servicios a dichas personas.",
      "Comercializarlos ni cederlos a terceros con fines publicitarios o de perfilamiento.",
      "Entrenar modelos generales de inteligencia artificial de terceros para fines propios de dichos terceros.",
    ],
  },
  { t: "h3", text: "A.3.4 Tipos de datos" },
  {
    t: "p",
    text: "Según el rubro del Cliente y las funcionalidades que utilice, el tratamiento puede comprender:",
  },
  {
    t: "table",
    headers: ["Categoría", "Contenido"],
    rows: [
      ["Identificación", "Nombre, apellido, RUT, fecha de nacimiento"],
      ["Contacto", "Teléfono, correo electrónico, dirección"],
      ["Agenda", "Historial de reservas, horarios, profesional asignado, estado"],
      ["Comerciales", "Historial de servicios, preferencias, notas internas"],
      ["Mascotas", "Especie, raza, edad, historial, vinculados a su tutor"],
      ["**Sensibles (según rubro)**", "Fichas clínicas veterinarias, fichas médicas humanas, notas clínicas"],
      ["Archivos", "Fotografías y documentos adjuntos"],
    ],
  },
  { t: "h3", text: "A.3.5 Categorías de titulares" },
  {
    t: "ul",
    items: [
      "Clientes Finales del Cliente, incluidos eventualmente niños, niñas y adolescentes.",
      "Tutores o responsables de mascotas.",
      "Personal y profesionales del Cliente registrados en la Plataforma.",
      "Terceros cuyos datos el Cliente incorpore legítimamente.",
    ],
  },
  { t: "hr" },

  { t: "h3", text: "A.4 Instrucciones del Cliente" },
  {
    t: "p",
    text: "Orbyx trata los datos únicamente conforme a las instrucciones documentadas del Cliente, las que se entienden constituidas por:",
  },
  {
    t: "ul",
    items: [
      "Los Términos de Servicio y este Anexo.",
      "La configuración que el Cliente establece en la Plataforma.",
      "Las instrucciones adicionales que el Cliente comunique por escrito y que sean técnicamente factibles y jurídicamente admisibles.",
    ],
  },
  {
    t: "p",
    text: "Si Orbyx estima que una instrucción del Cliente infringe la legislación aplicable, se lo informará y podrá abstenerse de ejecutarla.",
  },
  {
    t: "p",
    text: "**Si Orbyx tratara los datos con un objeto distinto del encargo convenido, o los comunicara sin autorización, será considerado responsable de datos para todos los efectos legales**, respondiendo personalmente por las infracciones y solidariamente con el Cliente por los daños ocasionados.",
  },
  { t: "hr" },

  { t: "h3", text: "A.5 Obligaciones de Orbyx" },
  { t: "p", text: "Orbyx se obliga a:" },
  {
    t: "ol",
    items: [
      "Tratar los datos exclusivamente conforme al encargo.",
      "Guardar **secreto o confidencialidad** sobre los datos, obligación que subsiste tras el término de la relación.",
      "Adoptar las medidas de seguridad descritas en la cláusula A.7.",
      "Asegurar que su personal con acceso a los datos esté sujeto a deber de confidencialidad.",
      "No comunicar ni ceder los datos a terceros, salvo autorización del Cliente, lo previsto en la cláusula A.8, o mandato legal.",
      "Asistir al Cliente conforme a las cláusulas A.9 y A.11.",
      "Suprimir o devolver los datos conforme a la cláusula A.10.",
      "Poner a disposición del Cliente la información razonable que acredite el cumplimiento de estas obligaciones.",
    ],
  },
  { t: "hr" },

  { t: "h3", text: "A.6 Obligaciones del Cliente" },
  { t: "p", text: "El Cliente se obliga a:" },
  {
    t: "ol",
    items: [
      "Contar con un fundamento jurídico válido para el tratamiento de los datos que incorpore.",
      "Informar adecuadamente a sus Clientes Finales.",
      "Obtener las autorizaciones exigidas por ley, especialmente respecto de **datos sensibles** y de **niños, niñas y adolescentes**.",
      "No incorporar datos que no esté facultado para tratar.",
      "Configurar adecuadamente los permisos de sus usuarios internos.",
      "Atender los derechos que ejerzan sus Clientes Finales.",
      "Comunicar a Orbyx cualquier circunstancia que afecte el encargo.",
    ],
  },
  { t: "hr" },

  { t: "h3", text: "A.7 Medidas de seguridad" },
  { t: "p", text: "Orbyx aplica las siguientes medidas:" },
  {
    t: "ul",
    items: [
      "**Aislamiento multi-tenant**: separación lógica de los datos de cada Cliente, mediante validación de pertenencia en cada operación de lectura y escritura.",
      "**Control de acceso**: autenticación de usuarios y gestión de permisos.",
      "**Mínimo privilegio**: acceso limitado a lo necesario para cada función.",
      "**Protección de credenciales**: las contraseñas no se almacenan en texto plano.",
      "**Comunicaciones cifradas** mediante HTTPS/TLS.",
      "**Respaldos** periódicos para recuperación ante incidentes.",
      "**Registro de actividad** de operaciones dentro de la Plataforma.",
      "**Actualización de componentes** y corrección de vulnerabilidades detectadas.",
    ],
  },
  {
    t: "p",
    text: "Orbyx no declara contar con certificaciones ISO 27001, SOC 2, auditorías externas periódicas ni programas de pruebas de penetración permanentes. Si las incorpora, lo informará al Cliente.",
  },
  { t: "h3", text: "A.7.1 Acceso administrativo" },
  {
    t: "p",
    text: "Orbyx no dispone de una funcionalidad que permita a su personal iniciar sesión en la Cuenta del Cliente y navegar sus datos como si fuera este.",
  },
  {
    t: "p",
    text: "Existe, no obstante, la posibilidad técnica de acceder a la información a través de la infraestructura de base de datos. Dicho acceso queda restringido a personal autorizado, limitado a una necesidad legítima de soporte, seguridad, mantenimiento o cumplimiento legal, sujeto a mínimo privilegio y a deber de confidencialidad.",
  },
  { t: "hr" },

  { t: "h3", text: "A.8 Subencargados" },
  { t: "p", text: "El Cliente autoriza a Orbyx a recurrir a los siguientes subencargados:" },
  {
    t: "table",
    headers: ["Subencargado", "Función", "País"],
    rows: [
      ["**Supabase Inc.**", "Base de datos y autenticación", "Estados Unidos"],
      ["**Vercel Inc.**", "Alojamiento del frontend", "Estados Unidos"],
      ["**Render Services Inc.**", "Alojamiento del backend", "Estados Unidos"],
      ["**Twilio Inc.**", "Mensajería WhatsApp", "Estados Unidos"],
      ["**Meta Platforms Inc.**", "Plataforma WhatsApp Business", "Estados Unidos"],
      ["**Resend Inc.**", "Correo transaccional", "Estados Unidos"],
      ["**Flow S.A.**", "Procesamiento de pagos", "Chile"],
    ],
  },
  {
    t: "p",
    text: "Orbyx procura que los subencargados queden sujetos a obligaciones de protección de datos equivalentes a las de este Anexo.",
  },
  {
    t: "p",
    text: "Orbyx informará al Cliente con **al menos 30 días corridos de anticipación** la incorporación o sustitución de un subencargado. Si el Cliente se opone fundadamente, podrá terminar el contrato sin penalización, con devolución proporcional de lo pagado y no utilizado.",
  },
  { t: "hr" },

  { t: "h3", text: "A.9 Transferencias internacionales" },
  {
    t: "p",
    text: "Como consecuencia de lo anterior, determinados datos pueden ser procesados o almacenados fuera de Chile.",
  },
  {
    t: "p",
    text: "Orbyx adoptará las medidas y bases jurídicas que la legislación chilena exija para dichas transferencias, incluyendo la suscripción de cláusulas contractuales apropiadas con sus subencargados.",
  },
  { t: "hr" },

  { t: "h3", text: "A.10 Supresión o devolución" },
  {
    t: "p",
    text: "Terminada la prestación del Servicio, Orbyx conservará los datos durante **12 meses**, plazo destinado a permitir la eventual reactivación de la Cuenta, la recuperación o exportación de información y la resolución de controversias.",
  },
  { t: "p", text: "Durante ese plazo, el Cliente puede solicitar:" },
  {
    t: "ul",
    items: [
      "La **devolución** de los datos en formato estructurado y de uso común, o",
      "Su **supresión anticipada**.",
    ],
  },
  {
    t: "p",
    text: "Transcurrido el plazo, Orbyx suprimirá o anonimizará los datos, salvo aquellos que deba conservar por mandato legal.",
  },
  {
    t: "p",
    text: "Los respaldos técnicos pueden mantener copias durante un periodo adicional acotado, tras el cual son sobrescritos conforme al ciclo de respaldos.",
  },
  { t: "hr" },

  { t: "h3", text: "A.11 Derechos de los titulares" },
  {
    t: "p",
    text: "Los Clientes Finales ejercen sus derechos **ante el Cliente**, en su calidad de responsable.",
  },
  { t: "p", text: "Si un titular dirige una solicitud a Orbyx, este:" },
  {
    t: "ul",
    items: [
      "Le informará que debe dirigirse al Cliente responsable.",
      "Comunicará la solicitud al Cliente sin dilaciones indebidas.",
      "Prestará al Cliente la asistencia razonable para responderla, dentro de las capacidades técnicas de la Plataforma.",
    ],
  },
  {
    t: "p",
    text: "Orbyx no atenderá directamente solicitudes de supresión o rectificación sobre datos de Clientes Finales sin instrucción del Cliente, salvo mandato legal u orden de autoridad competente.",
  },
  { t: "hr" },

  { t: "h3", text: "A.12 Vulneraciones de seguridad" },
  {
    t: "p",
    text: "Ante una vulneración de las medidas de seguridad que ocasione destrucción, filtración, pérdida o alteración accidental o ilícita de los datos, o el acceso o comunicación no autorizados a estos, Orbyx:",
  },
  {
    t: "ol",
    items: [
      "**Notificará al Cliente** por los medios más expeditos posibles y **sin dilaciones indebidas**.",
      "Le entregará la información disponible sobre la naturaleza de la vulneración, las categorías de datos y de titulares afectados, sus efectos y las medidas adoptadas.",
      "Prestará la asistencia razonable para que el Cliente cumpla sus propias obligaciones de reporte y comunicación.",
    ],
  },
  {
    t: "p",
    text: "**Corresponde al Cliente**, como responsable, efectuar las notificaciones que la ley le imponga ante la autoridad de control y ante los titulares afectados.",
  },
  { t: "p", text: "Orbyx mantendrá registro de estas comunicaciones." },
  { t: "hr" },

  { t: "h3", text: "A.13 Datos sensibles" },
  {
    t: "p",
    text: "Cuando el Cliente pertenezca a un rubro que implique el tratamiento de datos relativos a la salud u otros datos sensibles:",
  },
  {
    t: "ul",
    items: [
      "El Cliente reconoce que la ley somete estos datos a un régimen más estricto y asume la responsabilidad de cumplirlo.",
      "Orbyx aplicará las medidas de seguridad de la cláusula A.7 con especial diligencia sobre estos datos.",
      "Orbyx **no utilizará información clínica para finalidad alguna distinta** de la prestación del Servicio.",
      "Las funcionalidades automatizadas que Orbyx incorpore en el futuro operarán bajo restricciones reforzadas respecto de esta información, conforme a su Política de Privacidad.",
    ],
  },
  { t: "hr" },

  { t: "h3", text: "A.14 Responsabilidad" },
  {
    t: "p",
    text: "Cada parte responde por el incumplimiento de las obligaciones que este Anexo le impone, conforme a la legislación aplicable.",
  },
  { t: "hr" },

  { t: "h3", text: "A.15 Vigencia y prevalencia" },
  {
    t: "p",
    text: "Este Anexo rige desde la aceptación de los Términos de Servicio y mientras Orbyx trate datos por encargo del Cliente.",
  },
  {
    t: "p",
    text: "En materia de tratamiento de datos personales, **prevalece por sobre cualquier disposición contraria** de los Términos de Servicio.",
  },
];

async function sendLegalAcceptanceConfirmationEmail({
  to,
  businessName,
  termsVersion,
  termsUrl,
  privacyVersion,
  privacyUrl,
  acceptedAt,
}) {
  try {
    if (!resend) {
      console.warn("⚠️ RESEND_API_KEY no configurada. Email de aceptación legal omitido.");
      return { ok: false, reason: "resend_not_configured" };
    }

    const formattedAcceptedAt = formatDate(acceptedAt);
    const contractHtml = renderLegalBlocksToHtml(LEGAL_TERMS_BLOCKS);
    const greeting = businessName ? `, ${escapeHtml(businessName)}` : "";

    const { error } = await resend.emails.send({
      from: "Orbyx <reservas@notificaciones.orbyx.cl>",
      to,
      subject: "Bienvenido a Orbyx — confirmación de tu cuenta y copia de tu contrato",
      html: `
<div style="margin:0; padding:30px 16px; background:#f1f5f9; font-family:Arial, Helvetica, sans-serif;">
  <div style="max-width:680px; margin:0 auto;">
    <div style="background:#ffffff; border-radius:20px; overflow:hidden; box-shadow:0 20px 50px rgba(0,0,0,0.1);">

      <div style="background:linear-gradient(135deg,#0f172a,#312e81); padding:28px; text-align:center;">
        <div style="color:#cbd5e1; font-size:12px; letter-spacing:0.2em;">CUENTA CREADA</div>
        <h1 style="color:#ffffff; margin:10px 0 0; font-size:24px;">¡Bienvenido a Orbyx${greeting}!</h1>
      </div>

      <div style="padding:24px;">
        <div style="background:#dcfce7; color:#166534; display:inline-block; padding:6px 12px; border-radius:999px; font-size:12px; margin-bottom:12px;">
          ✔ Tu cuenta fue creada correctamente
        </div>

        <p style="color:#475569; font-size:14px; line-height:1.6;">
          Al crear tu cuenta aceptaste los Términos de Servicio de Orbyx (que incluyen el Acuerdo de
          Tratamiento de Datos, Anexo A) y declaraste haber leído la Política de Privacidad. Este correo
          es tu <strong>confirmación escrita</strong>, con la versión aceptada y una copia íntegra del contrato.
        </p>

        <div style="background:#f8fafc; padding:16px; border-radius:14px; border:1px solid #e2e8f0; margin-top:16px; font-size:13.5px; color:#334155;">
          <p style="margin:0 0 6px;"><strong>Documento:</strong> Términos de Servicio, incluye Anexo A — versión ${escapeHtml(
            termsVersion
          )}</p>
          <p style="margin:0 0 6px;"><strong>Documento:</strong> Política de Privacidad — versión ${escapeHtml(
            privacyVersion
          )}</p>
          <p style="margin:0;"><strong>Fecha de aceptación:</strong> ${formattedAcceptedAt}</p>
        </div>

        <p style="color:#475569; font-size:13px; margin-top:16px;">
          A continuación, el texto completo de los Términos de Servicio y su Anexo A, tal como los
          aceptaste. También puedes consultarlos en cualquier momento en
          <a href="${termsUrl}" style="color:#6366f1;">${termsUrl}</a> y en
          <a href="${privacyUrl}" style="color:#6366f1;">${privacyUrl}</a>.
        </p>
      </div>

      <div style="padding:0 24px 24px;">
        ${contractHtml}
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

    if (error) {
      console.error("Error enviando email de confirmación legal:", error);
      return { ok: false, reason: error.message || "resend_error" };
    }

    return { ok: true };
  } catch (error) {
    console.error("Error enviando email de confirmación legal:", error);
    return { ok: false, reason: error?.message || "unknown_error" };
  }
}

// Notifica al tenant (no al cliente) que un cliente subió un comprobante de
// depósito y queda pendiente de revisión. Mismo patrón que
// sendLegalAcceptanceConfirmationEmail: internal try/catch, nunca lanza,
// devuelve { ok, reason } para que el caller (server.js,
// notifyTenantDepositReceiptUploaded) pueda loguear sin que esto bloquee la
// respuesta al cliente que subió el archivo.
async function sendDepositReceiptUploadedEmail({
  to,
  tenantName,
  customerName,
  serviceName,
  startAt,
  dashboardUrl,
}) {
  try {
    if (!resend) {
      console.warn("⚠️ RESEND_API_KEY no configurada. Email de depósito pendiente omitido.");
      return { ok: false, reason: "resend_not_configured" };
    }

    const formattedDate = formatDate(startAt);

    const { data, error } = await resend.emails.send({
      from: "Orbyx <reservas@notificaciones.orbyx.cl>",
      to,
      subject: `Nuevo depósito para revisar · ${tenantName || "Orbyx"}`,
      html: `
<div style="margin:0; padding:30px 16px; background:#f1f5f9; font-family:Arial, Helvetica, sans-serif;">

  <div style="max-width:560px; margin:0 auto;">

    <div style="background:#ffffff; border-radius:20px; overflow:hidden; box-shadow:0 20px 50px rgba(0,0,0,0.1);">

      <div style="background:linear-gradient(135deg,#0f172a,#312e81); padding:28px; text-align:center;">
        <div style="color:#cbd5e1; font-size:12px; letter-spacing:0.2em;">
          DEPÓSITO PENDIENTE DE REVISIÓN
        </div>
        <h1 style="color:#ffffff; margin:10px 0 0; font-size:24px;">
          ${tenantName || "Orbyx"}
        </h1>
      </div>

      <div style="padding:24px;">

        <div style="background:#fef3c7; color:#92400e; display:inline-block; padding:6px 12px; border-radius:999px; font-size:12px; margin-bottom:12px;">
          💰 Comprobante subido
        </div>

        <h2 style="margin:0 0 10px;">Un cliente subió su comprobante de depósito</h2>

        <p style="color:#475569; font-size:15px;">
          <strong>${customerName || "Cliente"}</strong> subió un comprobante de transferencia
          para reservar <strong>${serviceName || "un servicio"}</strong>
          el <strong>${formattedDate}</strong>.
        </p>

        <p style="color:#475569; font-size:15px;">
          Revísalo desde tu panel de Agenda para confirmar o rechazar la reserva antes de
          que se venza el tiempo de espera.
        </p>

        <div style="text-align:center; margin-top:24px;">
          <a href="${dashboardUrl}" style="background:#0f172a; color:white; padding:12px 24px; border-radius:12px; text-decoration:none; font-weight:bold; font-size:15px;">
            Revisar depósito en Agenda
          </a>
        </div>

        <p style="margin-top:20px; font-size:12px; color:#94a3b8; text-align:center;">
          O copia este enlace en tu navegador:<br/>
          <a href="${dashboardUrl}" style="color:#6366f1;">${dashboardUrl}</a>
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

    if (error) {
      console.error("Error enviando email de depósito pendiente:", error);
      return { ok: false, reason: error.message || "resend_error" };
    }

    console.log("[DEPOSIT EMAIL] Enviado:", JSON.stringify(data));
    return { ok: true };
  } catch (error) {
    console.error("Error enviando email de depósito pendiente:", error);
    return { ok: false, reason: error?.message || "unknown_error" };
  }
}

module.exports = {
  sendBookingEmail,
  sendInvitationEmail,
  sendEmailChangeConfirmationToOldEmail,
  sendEmailChangeVerificationToNewEmail,
  sendSignupRecoveryEmail,
  sendSignupStuckAlertEmail,
  sendLegalAcceptanceConfirmationEmail,
  sendDepositReceiptUploadedEmail,
};