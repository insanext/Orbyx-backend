# Auditoría de producción — Sesión 1 de 3: flujo público, registro y correos

Fecha: 2026-09-29 · Alcance: todo lo que ocurre antes de iniciar sesión en el dashboard.
**Solo auditoría: no se modificó ningún archivo de código.**

Método: lectura y trazado del código (`server.js`, `email.js`, `orbyx-web/`). Pruebas en vivo hechas, todas de **solo lectura** (GET/HEAD con `curl`, sin crear nada):
- Todas las páginas públicas y las imágenes del landing responden 200 (incluidas las 5 fotos externas de Unsplash).
- `GET https://orbyx-backend.onrender.com/branches?tenant_id=…` sin sesión → **401 "Token requerido"** (confirma el hallazgo C1).
- `https://orbyx.cl/...` redirige 308 a `https://www.orbyx.cl/...` (los links del QR y de "Pedir reseña" funcionan, con un salto extra).

Severidad: **Crítico** = rompe una función central o expone clientes a reservas dobles · **Importante** = problema real para usuarios o riesgo de seguridad/costo · **Menor** = detalle, inconsistencia o mejora.

Columna "¿Decisión previa?": si parece una decisión tomada a propósito en una ronda anterior (según comentarios del código / CLAUDE.md) o un bug genuino.

---

## CRÍTICOS

### C1. La página pública de reserva solo muestra la sucursal principal — las demás sucursales no se pueden reservar
- **Dónde:** `orbyx-web/app/api/public-services/[slug]/route.ts:46-60` llama a `GET /branches?tenant_id=…` **sin token**. Ese endpoint exige sesión: `server.js:16737` (`app.get("/branches", tenantAuth, …)`), protegido desde el commit `1601625` (2026-06-29, "auth real en endpoints de dashboard").
- **Qué pasa:** el backend responde 401, el proxy lo ignora en silencio y devuelve `branches: []`. La página (`app/[slug]/page.tsx:1609-1621`) cae al "fallback" de una sola sucursal (`data.branch`, la principal). Como `showBranchSelector = branches.length > 1` (`page.tsx:585`), **el selector de sucursal nunca aparece**.
- **Impacto:** cualquier negocio con 2+ sucursales (plan Business/Premium, o add-on de sucursal pagado) recibe reservas públicas solo en la principal. Sus clientes no pueden elegir otra sucursal. Lleva ~3 meses así sin que se note.
- **Cómo lo confirmé:** trazado de código + prueba en vivo (401 del endpoint).
- **¿Decisión previa?** No — regresión accidental del endurecimiento de seguridad de junio.

### C2. Citas de la tarde-noche no se descuentan de la disponibilidad (error de zona horaria) → horarios "fantasma" y posibles reservas encimadas
- **Dónde:** `server.js:2359-2378` (`subtractAppointmentsFromWindows`) busca las citas del día con `gte("start_at", "${date}T00:00:00")` / `lte(... "T23:59:59")` **sin zona horaria**. Postgres interpreta ese texto en la zona de la sesión de la BD (en Supabase es UTC por defecto), no en hora de Chile.
- **Qué pasa:** el día "Chile" va de 00:00 a 23:59 hora local, pero la consulta cubre 00:00–23:59 **UTC**. Las citas que empiezan desde las **21:00 (horario de verano, UTC-3) o 20:00 (horario de invierno, UTC-4)** caen en el "día siguiente UTC" y no se descuentan.
- **Impacto:**
  - Esos horarios siguen apareciendo como libres en la página pública (`/public/slots`, `server.js:18160`). Si el cliente elige exactamente la misma hora de inicio, el chequeo de duplicado exacto (`server.js:6292-6316`) lo frena con "Este horario acaba de ser reservado" — mala experiencia pero sin daño.
  - **Si el inicio no coincide exactamente** (p.ej. un servicio de 60 min a las 21:00 y otro de 30 min ofrecido a las 21:30, o servicios con distinta duración), la validación final del backend (`server.js:6425-6432`, misma función) también lo deja pasar → **dos citas encimadas para el mismo profesional**.
  - Afecta a negocios que atienden de tarde: gimnasios, clases, barberías, etc.
- **Cómo lo confirmé:** lectura del código. Contraste: el cálculo de cupos grupales del mismo archivo sí usa offset explícito (`server.js:18047`, `-03:00`), lo que muestra que el problema de zona horaria era conocido en otras partes.
- **Verificación pendiente (solo lectura, la puedes correr tú):** en Supabase SQL editor, `SHOW timezone;` — si responde `UTC`, el bug está activo.
- **¿Decisión previa?** No, bug genuino.

---

## IMPORTANTES

### Reserva pública

**I1. No hay protección real contra dos clientes reservando al mismo tiempo (condición de carrera).**
`POST /appointments/slot` (`server.js:6292-6556`) hace "revisar → luego insertar" sin bloqueo. Dos solicitudes simultáneas pueden pasar ambas la revisión. El código maneja un error de índice único llamado `appointments_unique_slot` (`server.js:6594`), pero **no existe ninguna migración en el repo que lo cree** (y según la lección ya aprendida, el repo no es inventario confiable de prod).
- Aun si existe, un índice único solo protege el mismo inicio exacto, no citas que se solapan con distinta hora de inicio.
- En servicios grupales, la capacidad se cuenta y luego se inserta (`server.js:6317-6323`): dos reservas simultáneas pueden sobrepasar el cupo (ya listado como riesgo conocido en CLAUDE.md).
- **Verificación pendiente (solo lectura):** `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'appointments';` para saber si `appointments_unique_slot` existe y sobre qué columnas.
- ¿Decisión previa? Riesgo conocido (grupales), no resuelto.

**I2. Horas y fechas en la página pública usan la zona horaria del teléfono del cliente, no la de Chile.**
`app/[slug]/page.tsx:264-289` (`formatDate`, `formatHour`, `formatFullDate`) y `getStartOfWeek` usan `Date` local del navegador sin `timeZone: "America/Santiago"`. Además, el `date` que se envía al reservar sale de `formatDate` (`page.tsx:2106`).
- Caso real chileno: **Magallanes** (America/Punta_Arenas) está 1 hora adelante de Santiago en invierno → ese cliente ve todas las horas corridas en 1 h. Turistas o chilenos con el teléfono en otra zona igual.
- Si la fecha local difiere de la de Chile (reservas cerca de medianoche), el backend valida contra el día equivocado y responde "Ese horario ya no está disponible".
- Mismo problema en la página de cancelación (`app/cancel/[id]/page.tsx:141`).
- ¿Decisión previa? No, bug.

**I3. Negocios pausados o con prueba vencida siguen recibiendo reservas públicas.**
`POST /appointments/slot` no revisa si el tenant está pausado (`paused_at`), vencido o inactivo (`is_active`). `/public/services/:slug` (`server.js:17580-17584`) tampoco filtra `is_active`. El dueño no puede entrar a su dashboard (bloqueado por middleware), pero sus clientes siguen reservando, reciben confirmación y el negocio consume cupo de WhatsApp sin poder ver ni gestionar esas citas.
- ¿Decisión previa? No encontré ninguna decisión documentada al respecto — **pregunta de producto**: ¿debe la página pública quedar cerrada ("Este negocio no está recibiendo reservas") cuando la cuenta está pausada/vencida?

**I4. La API pública de servicios expone la fila completa del negocio.**
`GET /public/services/:slug` hace `select("*")` sobre `tenants` y la devuelve entera como `business` (`server.js:17582`, `17675`). Cualquiera puede ver: plan, fechas de prueba y de facturación, `paused_at`, créditos/cargos de prorrateo, configuración de WhatsApp, selección de staff/sucursales a conservar en un downgrade, datos bancarios completos del depósito (aunque el negocio no lo tenga activado), etc. `/public/business/:slug` (`server.js:17776-17803`) también expone plan, ciclo de facturación y prorrateos.
- ¿Decisión previa? No, parece arrastre histórico. Se profundiza en la sesión de seguridad.

**I5. Búsqueda pública de mascotas por teléfono parcial: filtra datos de otros clientes y puede autocompletar la mascota equivocada.**
`GET /pets/:slug` es público (`server.js:9562`) y busca el cliente con `ilike("phone", "%dígitos%")` (`server.js:9607`) — coincidencia parcial, sin mínimo de dígitos en el backend. También acepta `customer_id` directo.
- Privacidad: con `?phone=9` devuelve las mascotas (todas las columnas) y el `customer_id` del primer cliente que calce.
- UX real en veterinarias: la página consulta apenas el cliente escribe 6 dígitos (`page.tsx:1680-1702`); un número parcial puede calzar con **otro** cliente, y el formulario preselecciona la mascota de otra persona.
- ¿Decisión previa? No, bug.

**I6. Reseñas: cualquiera que sepa el teléfono o correo de un cliente puede publicar (o sobrescribir) una reseña a su nombre, y de paso confirma su nombre.**
`POST /public/reviews/:slug/check-eligibility` (`server.js:18250`) responde `eligible: true` + **el nombre del cliente** al ingresar un teléfono/correo. `POST /public/reviews/:slug` (`server.js:18345`) hace upsert por cliente: sobrescribe la reseña existente de esa persona.
- ¿Decisión previa? El flujo manual por teléfono/correo fue diseñado como "fallback" intencional; el riesgo de suplantación/enumeración no aparece documentado.

**I7. Depósito: si el cliente recarga o cierra la pestaña antes de subir el comprobante, pierde la reserva sin aviso.**
El paso "sube tu comprobante" vive solo en memoria de la página (`page.tsx:1244`, `2154-2164`). No se envía ningún correo al cliente al crear una reserva con depósito (la confirmación se envía recién al aprobar, `server.js:6861`), así que no hay link para volver. A los 10 minutos el cron la cancela.
- Además, **el cliente no se entera antes de reservar** que el servicio exige depósito: no hay aviso previo en el formulario; lo descubre después de enviar, con el cronómetro corriendo.
- ¿Decisión previa? El flujo de 2 pasos es deliberado (rondas de depósitos), pero estos dos huecos no aparecen documentados.

**I8. Depósito: comprobantes entre 4,5 MB y 5 MB fallan con un error ilegible.**
El límite propio es 5 MB (`app/api/upload-deposit-receipt/route.ts:6` y `page.tsx:2339`), pero Vercel corta el cuerpo de una función serverless en ~4,5 MB antes de llegar al código y responde con una página de error no-JSON; el `uploadRes.json()` de `page.tsx:2001` revienta y el cliente ve un mensaje técnico. Las fotos de celular de comprobantes suelen pesar 3-6 MB.
- **Prueba pendiente (efecto real, requiere tu autorización):** subir un comprobante de ~4,8 MB en una reserva de prueba con depósito.

**I9. Recordatorios de WhatsApp se envían a reservas con depósito aún no aprobado.**
`sendWhatsAppReminders` (`server.js:18593-18612`) filtra `status = booked` pero no `deposit_status`. Una reserva con comprobante subido y aún sin revisar (esas no vencen nunca, `server.js:11709`) recibe recordatorio como si estuviera confirmada.

**I10. Si algo falla después de crear la cita, el backend la cancela aunque ya se haya enviado la confirmación.**
El `catch` final de `POST /appointments/slot` (`server.js:6905-6913`) marca la cita como `canceled` ante cualquier error posterior al insert (resolución de mascota, stats, sync, etc.). CLAUDE.md dice que una reserva válida no debe borrarse por fallas secundarias. El cliente ve "error", pero puede haber recibido el correo/WhatsApp de confirmación de una cita que ya no existe.

### Registro, login y recuperación

**I11. `/tenants/provision` acepta el plan que manda el navegador → cualquiera puede crearse un negocio Premium (o VIP/Platinum legacy) gratis.**
`server.js:12407` toma `plan` del body; `provisionTenantCore` lo normaliza y lo acepta tal cual si es `business`, `premium`, `pro`, `vip` o `platinum` (`server.js:12168-12171`). Con un plan distinto de starter queda `is_trial=false`, sin `trial_ends_at`, y con `billing_cycle_end` a +1 mes → según `deriveTenantBucket` (`server.js:20082`) funciona como "en prueba" durante ese mes con las capacidades del plan elegido (incluye cupo de campañas WhatsApp = costo real de Twilio). El `plan` también viaja en `user_metadata` de Supabase, que el propio usuario controla al registrarse.
- ¿Decisión previa? No. Se profundiza en la sesión de seguridad.

**I12. `/tenants/provision` no evita crear negocios duplicados.**
El backend no revisa si el usuario ya tiene un `tenant_users` (solo el frontend lo hace, `app/login/page.tsx:47-58`). Doble clic, dos pestañas o una recarga durante el primer login (que tarda más porque espera el envío del correo legal con reintentos, `server.js:12462`) crean 2 negocios. Pasó antes: el propio comentario de `server.js:12422` documenta 4 tenants fantasma.

**I13. `POST /onboarding/setup` (sin autenticación) permite crear negocios arbitrarios.**
`server.js:18997`: sin login ni captcha, crea tenant + calendario + servicio + horarios con el slug que se pida (permite "apartar" slugs o llenar la BD de basura). Lo usa solo la página `/start` (`app/start/page.tsx`), que nadie enlaza pero sigue publicada (responde 200).
- ¿Decisión previa? Parece código legado del onboarding antiguo.

**I14. Slugs que chocan con rutas del sitio: el negocio queda con su página pública inaccesible.**
Ni `PATCH /tenants/:id` (`server.js:16375-16396`) ni `provisionTenantCore` tienen lista de slugs reservados. Un negocio llamado "Planes", "Nosotros", "Login", "Signup", "Dashboard", "Admin", "Términos", "Checkout", "Welcome", "Invite", "Cancel", "Start", etc. obtiene ese slug, pero Next.js sirve la página estática → `orbyx.cl/planes` muestra la página de precios de Orbyx, no la del negocio.

**I15. Link de verificación vencido o inválido muestra "Cuenta verificada".**
`app/auth/verified/page.tsx` muestra el ✅ siempre, sin leer el error que Supabase agrega a la URL (`#error=access_denied&error_code=otp_expired`). La persona cree que está verificada, intenta entrar y le aparece un error en inglés ("Email not confirmed", ver M-ERR). `app/auth/check-email` no tiene botón "reenviar correo".

**I16. El registro no envía correo de bienvenida de Orbyx (Resend); el "bienvenida" real es el correo legal, que llega recién en el primer login.**
- Al registrarse solo llega el correo de confirmación de Supabase (plantilla y remitente configurados en Supabase, no en el código).
- `sendWelcomeAccessEmail` (`email.js:1794`) solo se dispara desde el panel admin (`server.js:20704`).
- El correo que sí llega, "Bienvenido a Orbyx — confirmación de tu cuenta y copia de tu contrato" (`email.js:1470`), se envía en el primer login, no trae link para entrar al dashboard, y el saludo sale sin nombre de negocio (se llama con `business_name: null`, `server.js:12466`).
- **Verificación pendiente:** en Supabase → Authentication → SMTP, confirmar que el correo de confirmación usa SMTP propio (Resend). Si usa el SMTP por defecto de Supabase, hay un límite de muy pocos correos por hora para todo el proyecto: en un lanzamiento, los registros se quedarían sin correo de verificación.

**I17. Captcha posiblemente decorativo en registro/login/recuperación.**
- Registro y login pasan el token de Turnstile a Supabase; solo se valida si "Captcha protection" está activado en Supabase Auth (no verificable desde el código).
- Recuperación de contraseña: se valida en el backend solo si existe `TURNSTILE_SECRET_KEY` (`server.js:20771-20781`); según tu memoria del 2026-09-28, esa variable faltaba en Render → hoy no se valida.
- **Verificación pendiente:** revisar ambos ajustes.

### Correos y recordatorios

**I18. No existe recordatorio por email, aunque el plan Starter lo promete.**
`lib/plans.ts:214` ("Recordatorio por email") y el landing (`app/page.tsx:63`, "Confirma y recuerda por WhatsApp y email"). El único job de recordatorio por correo, `GET /jobs/send-reminders` (`server.js:18532`), no lo llama ningún cron (lo dice su propio comentario). Y si se activara tal cual: reenviaría la plantilla "Reserva confirmada" (no un recordatorio), sin nombre ni branding del negocio, sin marca anti-duplicado y a reservas con depósito pendiente.
- El único recordatorio real es WhatsApp, opcional por negocio y limitado por plan.
- ¿Decisión previa? El comentario reconoce que no se usa, pero la promesa comercial sigue publicada.

**I19. Recordatorio WhatsApp con dirección vacía cuando el negocio no la cargó.**
`server.js:18659`: la variable `{{4}}` se envía como `""` si no hay dirección (la confirmación sí tiene respaldo: nombre del servicio, `server.js:1402`). WhatsApp suele rechazar plantillas con parámetros vacíos → el recordatorio probablemente falla en silencio para esos negocios.
- **Prueba pendiente (envío real, requiere autorización):** tenant de prueba sin dirección, recordatorio activo, cita a 1 h.

**I20. WhatsApp usa la dirección del negocio, no la de la sucursal.**
Confirmación (`server.js:1402`) y recordatorio (`server.js:18659`) usan `tenants.address`; el correo sí usa la dirección de la sucursal (`server.js:1364`). En multi-sucursal, el WhatsApp puede mandar al cliente a la dirección equivocada (hoy lo tapa C1, pero saldrá a la luz al corregirlo).

---

## MENORES

### Landing / marketing
- **M1.** Footer: íconos de Instagram y Facebook con `href="#"` (`components/public/PublicFooter.tsx:42,50`), mientras el header ya tiene el Instagram real (`https://www.instagram.com/orbyx.cl/`).
- **M2.** El menú del header (`PublicHeader.tsx`) no tiene link a "Planes" y en móvil (< 1024 px) se oculta entero, sin menú hamburguesa; en móvil solo quedan "Iniciar sesión" y el footer.
- **M3.** Rubros del carrusel: 2 de 8 imágenes (`RubrosCarousel.tsx:15`, Manicure) y las 3 fotos de staff del mockup (`AgendaMockup.tsx:6-8`) se cargan desde Unsplash. Hoy responden 200, pero dependen de un tercero.
- **M4.** No hay formulario de contacto: solo `mailto:contacto@orbyx.cl`. Nada roto.
- **M5.** Imagen hero de `/nosotros`: sigue pendiente de reemplazo (ya registrado en tu memoria: texto "Automatización Inteligente" y funciones que no existen).

### Preguntas frecuentes y textos desactualizados
No existe una sección de FAQ pública en el sitio de marketing (landing, `/planes`, `/nosotros`). La única FAQ está en el dashboard (Soporte, `app/dashboard/[slug]/soporte/faq-data.ts`, corresponde a la Sesión 2, pero la incluyo porque se pidió):
- **F1.** `faq-data.ts:55`: "según el límite de tu plan actual (**Pro: 1, Premium: 2, VIP: 3, Platinum: 10**)" → planes antiguos. Hoy: Starter 1, Business 2, Premium 3 (más add-ons).
- **F2.** `faq-data.ts:41` ("¿Cómo cancelo o reagendo…?"): dice que el cliente puede cancelar "con el link de su correo de confirmación"; correcto, pero en reservas con depósito ese correo solo llega tras la aprobación.
- **F3.** Landing `app/page.tsx:54`: "Tus clientes reservan desde tu web **o WhatsApp**" → reservar por WhatsApp (IA conversacional) no está construido.
- **F4.** Landing `app/page.tsx:63` y `lib/plans.ts:214`: recordatorio por email → no existe (ver I18).
- **F5.** `lib/plans.ts:256`: "Modo veterinario" aparece como función de Business, pero no encontré ningún bloqueo por plan en el código (un Starter puede elegir categoría veterinaria). Confirmar cuál es la intención.

### Registro / login / contraseña
- **M-ERR.** Errores de Supabase se muestran crudos y en inglés: registro (`app/signup/page.tsx:141`, ej. "Email rate limit exceeded", "captcha verification process failed"), login (`app/login/page.tsx:194`, ej. "Email not confirmed"), cambio de contraseña (`app/actualizar-password/page.tsx:104`).
- **M6.** El registro dice explícitamente "Ya existe una cuenta con este correo" (`signup/page.tsx:133`) y el login muestra "Email not confirmed" solo para correos registrados → ambos revelan si un correo existe (anotado para la sesión de seguridad). La recuperación de contraseña sí responde genérico (bien), aunque tarda distinto si el correo existe o no.
- **M7.** Timeout de 10 s en el registro (`signup/page.tsx:107-112`): si Supabase responde después, igual redirige a "revisa tu correo" tras haber mostrado "tardó demasiado"; y un reintento puede terminar en "Ya existe una cuenta".
- **M8.** Reglas de contraseña distintas: registro exige 8 caracteres + letra + número; restablecer solo 8 caracteres (`actualizar-password/page.tsx:84`).
- **M9.** `/actualizar-password` sin token pero con una sesión normal abierta queda habilitada (cambia la contraseña sin pedir la actual). Tras cambiarla no se cierran las otras sesiones.
- **M10.** Duración del link de recuperación: depende del ajuste "Email OTP Expiration" de Supabase (por defecto 1 hora); no está en el código. **Verificación pendiente** en Supabase → Auth → Providers → Email.
- **M11.** Si se cierra la pestaña a mitad del onboarding **después del paso 1** (nombre + rubro), el siguiente login va directo al dashboard (el login solo revisa `business_category`, `login/page.tsx:95`): quedan sin horarios, profesional ni servicio, y la página pública no muestra nada reservable. Si se cierra antes del paso 1, se retoma bien.
- **M12.** El onboarding precarga como "nombre del negocio" el correo del usuario (el tenant nace con `name = email`, `server.js:12143`; se precarga en `onboarding/page.tsx:266`). Si no lo cambia, el slug queda derivado del correo.
- **M13.** El login usa `"pro"` como plan por defecto si no hay metadata (`login/page.tsx:145,212`); el backend lo traduce a starter, sin efecto real, pero es un resto del esquema antiguo.
- **M14.** El primer login espera el envío del correo legal (hasta 2 intentos con 1,5 s de pausa) antes de responder (`server.js:12462`), alargando la espera y aumentando el riesgo de I12.

### Página pública de reserva
- **M15.** Nombre del cliente sin validación real: basta 1 carácter ("a", "123"), sin largo máximo en backend (`server.js:6132-6144`). Correo: el frontend solo exige que no esté vacío; el backend sí valida formato. Teléfono: consistente (solo celulares chilenos en ambos lados).
- **M16.** `customer_data` enviado por el cliente se guarda completo en `customers.extra_data` sin filtrar claves ni tamaño (`server.js:6614-6669`). También se aceptan `source` y `next_control_at` desde el público.
- **M17.** La respuesta pública de la reserva incluye el ID del Google Calendar del negocio (suele ser el Gmail del dueño) y el error técnico de sincronización (`server.js:6896-6903`). El proxy de Next devuelve `debug_payload` en errores (`app/api/appointments/slot/route.ts:53`).
- **M18.** Límite "días máximos de anticipación" calculado con la hora del servidor (UTC) y un offset fijo `-03:00` (`server.js:6234-6238`, `17999-18002`): puede correr el límite en un día.
- **M19.** Servicios grupales: la misma persona puede reservar varios cupos del mismo horario (el control "misma persona" se salta en grupales, `server.js:6349`). Además, la validación de capacidad al reservar cuenta citas de cualquier servicio a esa hora (`server.js:6292-6298` no filtra `service_id`), mientras la vista de cupos sí filtra por servicio.
- **M20.** `/public/services` muestra servicios cuyo único profesional está inactivo (`server.js:17650-17668` no filtra staff activo) → el cliente elige el servicio y no ve profesionales ni horarios.
- **M21.** Pantalla de éxito: si el negocio no tiene WhatsApp ni teléfono, el botón "Consultar por WhatsApp" abre un chat con **el propio número del cliente** (`page.tsx:2454`, respaldo `bookingSuccess.customerPhone`). Además usa el WhatsApp del negocio antes que el de la sucursal.
- **M22.** "Antes de tu visita" (instrucciones por servicio) aparece solo en el correo (condicional, correcto), nunca en la página pública ni en la pantalla de éxito. Confirmar si es intencional.
- **M23.** Depósito: "Te llegará una notificación cuando el negocio confirme tu depósito" (`page.tsx:2361`) — si lo rechaza, no llega nada (limitación ya documentada en CLAUDE.md). El hold real es de **10 min** (`server.js:6551`) mientras CLAUDE.md dice 15 (solo desactualización de docs).
- **M24.** Depósito: `upload-deposit-receipt` no exige el token de la reserva (solo `appointment_id` + `tenant_id`), así que cualquiera con esos IDs puede subir archivos huérfanos al bucket; y `POST /appointments/:id/deposit-receipt` acepta cualquier `receipt_path` sin verificar que pertenezca a esa reserva (`server.js:11449-11455`). Para la sesión de seguridad.
- **M25.** Fotos de iPhone en formato HEIC: el input acepta solo JPG/PNG/PDF (`page.tsx:2325`). iOS suele convertir al elegir, pero conviene probarlo. **Prueba pendiente.**
- **M26.** Cancelación: el link permite cancelar citas ya pasadas o marcadas como `completed`/`no_show` (`server.js:11777-11784` solo bloquea las ya canceladas); no hay plazo mínimo; el negocio no recibe aviso.
- **M27.** Página de cancelación: el parámetro `redirect` acepta cualquier URL (`app/cancel/[id]/page.tsx:26-34`) → un link con marca Orbyx puede llevar a un sitio externo (redirección abierta, para la sesión de seguridad).
- **M28.** El recordatorio de WhatsApp corre por cron interno cada 10 min **y** existe el endpoint para cron-job.org; si ambos siguen activos pueden correr a la vez y duplicar envíos (se leen las mismas citas con `wa_recordatorio_enviado=false` antes de marcarlas). Verificar si cron-job.org sigue llamando a `/whatsapp/maintenance/send-reminders`.

### Correos
- **M29.** Logos subidos después del 2026-09-06 se guardan en WebP (pipeline de compresión); Outlook de escritorio no muestra WebP → en esos clientes se ve el texto alternativo en vez del logo (el propio comentario de `email.js:40` lo reconoce).
- **M30.** Correo de confirmación sin `reply_to`: si el cliente responde, le escribe a `reservas@notificaciones.orbyx.cl`, no al negocio (`email.js:272-278`). El teléfono mostrado es siempre el del negocio, no el de la sucursal (`server.js:1365`).
- Verificado OK: el link de Google Calendar del correo usa hora UTC absoluta (correcto), incluye servicio/negocio/sucursal/dirección; la sucursal solo aparece con 2+ sucursales activas; sin dirección ni teléfono, esas filas simplemente no se muestran (no quedan espacios raros); sin logo se usa el avatar con inicial y color de marca.

### Reseñas / QR
- **M31.** El QR del dashboard lleva a la página de reservas (`https://orbyx.cl/{slug}`, `dashboard/[slug]/layout.tsx:309`), no a la página de reseñas. En la página pública, el botón "Dejar una reseña" está **solo dentro del modal de reseñas, que solo aparece si ya hay al menos 1 reseña** (`page.tsx:613`, `4087`). Un negocio nuevo no tiene forma pública de conseguir su primera reseña; solo con "Pedir reseña" (link por WhatsApp manual desde Clientes/Agenda).
- **M32.** No hay solicitud automática de reseña después de una cita: es 100 % manual (`lib/reviewRequest.ts`). Los links personalizados (`?t=`) nunca vencen.
- **M33.** El promedio público se calcula solo sobre las últimas 200 reseñas (`server.js:18474`).
- **M34.** Si un negocio tiene 2 clientes con el mismo teléfono/correo, la verificación de reseña falla con error 500 (`maybeSingle()`, `server.js:3131-3136`).

---

## Pruebas pendientes (requieren tu autorización; no las ejecuté)

| # | Qué probar | Para confirmar |
|---|---|---|
| P1 | `SHOW timezone;` en Supabase (solo lectura) | C2 |
| P2 | `SELECT indexname, indexdef FROM pg_indexes WHERE tablename='appointments';` (solo lectura) | I1 |
| P3 | Supabase → Auth → SMTP: ¿SMTP propio o el por defecto? | I16 |
| P4 | Supabase → Auth → "Captcha protection" activado; Render → `TURNSTILE_SECRET_KEY` existe | I17 |
| P5 | Supabase → Auth → duración de OTP/links de correo | M10 |
| P6 | Registro real completo con un correo nuevo: correo de verificación, link, primer login, 2 filas `legal_acceptances`, correo legal, `trial_ends_at` = +30 días, `plan_slug = starter`, sucursal "Principal", owner en `tenant_users` | Sección 2 |
| P7 | Abrir un link de verificación **ya usado** o vencido | I15 |
| P8 | Reserva de prueba en un negocio con 2 sucursales (ver que solo aparece una) | C1 |
| P9 | Reserva de prueba 21:00+ y luego ver si ese horario sigue ofrecido | C2 |
| P10 | Reserva con depósito + comprobante de ~4,8 MB; recargar la página en el paso de subida | I7, I8 |
| P11 | Recordatorio WhatsApp en tenant sin dirección | I19 |
| P12 | Comprobante desde iPhone (foto HEIC) | M25 |
| P13 | Recibir un correo de confirmación con logo WebP en Outlook | M29 |
| P14 | ¿cron-job.org sigue llamando a los endpoints de mantenimiento ya cubiertos por cron interno? | M28 |

## Preguntas de producto (no son bugs hasta que decidas)
1. ¿Debe cerrarse la página pública de reservas cuando el negocio está pausado o con la prueba vencida? (I3)
2. ¿"Modo veterinario" es exclusivo de Business o está abierto a Starter? (F5)
3. ¿Se quiere recordatorio por email real, o se retira de los planes y el landing? (I18)
4. ¿Las instrucciones "Antes de tu visita" deberían verse también en la página de éxito? (M22)
