# Orbyx: diagnóstico pre-lanzamiento (2026-10-18)

Sesión de solo diagnóstico: no se modificó código. Solo se ejecutó `npm audit` (solo lee). No se pudo ver Render, Supabase, Vercel, Flow ni Cloudflare: lo que depende de ellos está en la lista de pruebas manuales.

## Tabla resumen

| # | Punto | Estado | Severidad | Esfuerzo |
|---|---|---|---|---|
| 1 | Reservas falsas / rate limit público | Pendiente | Crítica | 1–2 días (A+B+C) |
| 1b | Nuevo: `GET /pets/:slug` público devuelve datos de clientes | Pendiente | Crítica | 2–4 h |
| 2 | HTML sin escapar en correo de comprobante | Pendiente (el resto de correos de cliente final está bien) | Media | 1 h |
| 3 | Invitaciones de equipo | Pendiente, explotable hoy | Alta | 3–4 h |
| 4 | Cabeceras de seguridad del frontend | Pendiente (no hay ninguna) | Media | 2–3 h + una semana en Report-Only |
| 5 | Hallazgos menores | Parcial | Variada | Variado |
| 6 | Turnstile | Parcial: el login depende de Supabase y el backend falla abierto | Alta si falta el secret | 1 h de código + revisión manual |
| 7 | Checklist básico | Parcial | Baja–media | 3–4 h |
| 8 | Pendientes de lanzamiento | Parcial: Flow listo por variables, faltan datos y FAQ | Media | ~1 día |

---

## 1. Reservas falsas en la página pública

**Cómo llegan las reservas.** El navegador llama a `/api/appointments/slot` en Next (`orbyx-web/app/[slug]/page.tsx:2433`). Esa ruta reenvía al backend con un `fetch` desde Vercel (`orbyx-web/app/api/appointments/slot/route.ts`). Ese `fetch` no manda `x-forwarded-for` ni `x-real-ip`.

**Cómo se calcula la IP hoy.**
- `server.js:42` usa `trust proxy = 1`.
- `publicLimiter` (`server.js:1952`) es 100 solicitudes por minuto por `req.ip`.
- El backend recibe todas las reservas con la IP de salida de Vercel (unas pocas IPs), no la del cliente.
- Es un solo cupo compartido por todos los tenants y clientes, y lo comparten `/public/services`, `/public/staff`, `/public/slots` y `/appointments/slot`.
- Consecuencia 1: no limita a ningún atacante en particular.
- Consecuencia 2: alguien que mande 100 solicitudes por minuto deja con 429 a todos los clientes reales.
- Consecuencia 3: aunque no haya ataque, cada carga de la página pública hace varias llamadas; con unas 20 personas navegando a la vez ya se llega al tope.
- `extractClientIp` (`server.js:13685`) toma el primer valor de `x-forwarded-for`, que el cliente puede falsificar. Hoy solo lo usan la aceptación de términos y Turnstile.
- Si `api.orbyx.cl` pasa por el proxy de Cloudflare, `trust proxy 1` vería la IP de Cloudflare para todos. Hay que revisar el DNS.

**Captcha.** No hay Turnstile ni otro captcha en la reserva pública. Turnstile solo está en login, signup, checkout-premium, completar-registro, invite, recuperar-password y configuración.

**Validación del cliente final** (`server.js:7037-7081`):
- El correo solo se valida con un regex, sin verificar que sea de la persona ni revisar dominios desechables.
- El teléfono se normaliza (Chile, o países permitidos con solo largo de dígitos). Tampoco se verifica.
- `customer_name` no tiene límite de largo ni de caracteres, solo que exista.

**Límites por persona** (`server.js:7306-7362`):
- Máximo 2 reservas futuras activas por correo y 2 por teléfono, solo dentro de un mismo tenant.
- Un atacante rota correos y teléfonos inventados y llena la agenda sin límite.
- Ese chequeo carga todas las reservas futuras del tenant sin `limit`. Con más de 1000 filas (tope de PostgREST) el conteo se queda corto.
- Las reservas sin depósito nunca expiran. Con depósito, la retención es de 10 minutos (`server.js:7508`); CLAUDE.md dice 15.

**Daño adicional.** El correo de confirmación sale a cualquier dirección y, si el tenant tiene WhatsApp activo, también el mensaje de WhatsApp: spam a terceros desde tu dominio y gasto del cupo de WhatsApp del tenant.

### Opciones de solución

**Opción A: IP real y límites propios para la reserva (~3–4 h).**
- La ruta Next toma la IP del cliente (Vercel sobrescribe `x-forwarded-for` en el borde, así que ahí sí es confiable) y la manda al backend en un header propio junto con un secreto compartido.
- El backend solo confía en ese header si el secreto coincide.
- Un limitador nuevo para `/appointments/slot` usa esa IP, con valores generosos por la red móvil compartida (CGNAT) de Chile: por ejemplo 5 reservas cada 10 minutos y 20 por día por IP.
- También se corrige el cupo compartido de `publicLimiter` en las rutas de lectura.
- Experiencia del cliente: ninguna.
- Riesgos: si el secreto no está en Render o Vercel, cae a la IP de Vercel (comportamiento actual); con express-rate-limit v8 hay que usar `ipKeyGenerator` para IPv6; valores demasiado bajos bloquearían clientes legítimos.

**Opción B: Turnstile en el paso final (~4–6 h). Recomiendo A + B.**
- Widget en el paso de enviar datos, token enviado por la ruta Next y verificado en el backend con `siteverify`.
- La reserva manual desde Agenda (`booking_origin: dashboard`) se salta el captcha.
- Experiencia: casi invisible en modo "managed"; a veces pide un clic.
- Riesgos: requiere `TURNSTILE_SECRET_KEY` en Render (según memoria faltaba), agregar el dominio en Cloudflare, algunos bloqueadores de contenido lo rompen; no debe fallar abierto en producción.

**Opción C: límites por teléfono y correo, y verificación (0,5 día para los límites; el OTP es aparte).**
- Tope de intentos por teléfono o correo en 24 horas entre todos los tenants (por ejemplo 3), además del tope por tenant.
- Tope de reservas nuevas por hora por tenant.
- Botón "bloquear teléfono/correo" en el dashboard.
- Opcional: código por WhatsApp o correo para clientes nuevos (más caro y con fricción; para después).
- Riesgo: un tope demasiado bajo afecta a familias que reservan varias horas con el mismo teléfono.

---

## 1b. Hallazgo nuevo (crítico): `GET /pets/:slug` es público y filtra datos

- Ruta: `server.js:10889-10960`, con `publicLimiter` y sin autenticación.
- Cualquiera puede pasar `?phone=` o `?email=` y recibe `customer_found`, `resolved_customer_id` y `pets.*` (todas las columnas de las mascotas de ese cliente).
- El teléfono se busca con `ilike '%dígitos%'`, sin largo mínimo en el backend. Con `phone=9` devuelve el primer cliente cuyo número contenga un 9, y repitiendo con distintos dígitos se puede ir sacando la lista.
- Quien lo usa: la página pública, para autocompletar mascotas.
- Fix mínimo: devolver solo `id`, `name` y `species`; no devolver `resolved_customer_id`; exigir coincidencia exacta de teléfono normalizado o de correo; limitar mucho por IP.
- Qué puede romper: la experiencia "se acuerda de mi mascota" en veterinarias.

---

## 2. HTML sin escapar en correos

| Correo | Dónde | Campos de cliente final | Estado |
|---|---|---|---|
| Comprobante subido | `email.js:1559-1642` | `customerName` (cliente), `serviceName` y `tenantName` (tenant), `dashboardUrl` | Sin escapar. Llega al dueño del negocio desde tu dominio: sirve para phishing con un enlace en el nombre |
| Confirmación y recordatorio de reserva | `email.js:82`, `esc()` en todos los campos | nombre, mascota, teléfono, instrucciones | Escapado. El recordatorio (`/jobs/send-reminders`) reutiliza esta función |
| Alerta interna de signup atascado | `email.js:555-575` | `email` y `signupIntentId` | Sin escapar. `/signup/start-paid` no valida el correo |
| Campañas por correo | `server.js:11712-11728` y `sanitizeRichHtml` (`server.js:4315`) | `{{nombre}}` entra al HTML sin escapar | Impacto bajo: el destinatario es la misma persona. `sanitizeRichHtml` es un regex débil, pero el HTML lo escribe el tenant |
| Invitación, aviso de prueba, pago fallido, cambio de correo | `email.js:292`, `1666`, `1738`, `383` | nombre del negocio o `newEmail` (los controla el propio usuario) | Sin escapar, riesgo bajo |
| Bienvenida y vencimiento de add-ons | `email.js:1877`, `1958` | | Escapado |
| Confirmación de términos | `email.js:1464` | | Escapado |

No existe correo de "nueva reseña" en el backend.

**Fix mínimo.** `escapeHtml` en `customerName`, `serviceName` y `tenantName` de `sendDepositReceiptUploadedEmail`; largo máximo a `customer_name`; validar el correo en `/signup/start-paid`.

---

## 3. Invitaciones de equipo

**Flujo.** Crear (`POST /invitations`, `server.js:24424-24545`): token de 32 bytes y correo. Aceptar (`POST /invitations/accept/:token`, `server.js:24634`): sin sesión ni rate limit, pide solo una contraseña. Leer (`GET /invitations/token/:token`): sin autenticación.

**Problemas.**
1. La respuesta de crear hace `.select()` de la fila completa (`server.js:24529-24545`) y devuelve `invitation` incluyendo `token`. Quien invita (owner o admin) recibe el token del invitado.
2. Al aceptar, si el correo ya existe en Supabase Auth y no tiene identidad email (por ejemplo solo Google), el backend le fija la contraseña enviada con `updateUserById` (`server.js:24713-24724`).
3. Si el correo no existe, se crea una cuenta ya confirmada con la contraseña enviada (`server.js:24688`).

**Qué se puede hacer hoy.** Un admin malicioso, o con sesión robada, invita al correo de alguien que solo usa Google, toma el token de la respuesta, acepta con su propia contraseña y entra como esa persona, con acceso a todos sus demás negocios. Con un correo sin cuenta es un "pre-secuestro".

**Otros defectos.**
- `listUsers({ perPage: 1000 })` (`server.js:24483`, `24680`) solo mira los primeros 1000 usuarios; pasado eso, aceptar invitaciones de usuarios existentes falla con 500.
- El `select` de aceptar no incluye `branch_ids`, así que siempre guarda `[]` (`server.js:24761`).

**Fix mínimo.** Columnas explícitas en la respuesta; eliminar el `updateUserById`; si la cuenta existe, aceptar solo con sesión (Bearer cuyo correo coincida); límite de solicitudes en los dos endpoints públicos; búsqueda por correo que no dependa de `listUsers`.

---

## 4. Cabeceras de seguridad del frontend

**Estado actual.** `next.config.ts` está vacío; no hay `vercel.json`; el middleware no agrega cabeceras. Solo el backend usa helmet (`server.js:1922`), con CSP desactivada (es una API JSON, está bien).

**Dominios que el sitio realmente usa:**

| Uso | Dominio | Directiva |
|---|---|---|
| Backend | `https://api.orbyx.cl` (y `orbyx-backend.onrender.com` solo si `NEXT_PUBLIC_BACKEND_URL` aún apunta ahí) | `connect-src` |
| Supabase | `https://*.supabase.co`, `wss://*.supabase.co` | `connect-src`, `img-src` |
| Turnstile | `https://challenges.cloudflare.com` | `script-src`, `frame-src`, `connect-src` |
| Mapas embebidos | `https://maps.google.com`, `https://www.google.com` | `frame-src` |
| Fotos de la landing | `https://images.unsplash.com` | `img-src` |
| Fuentes | `next/font` las sirve desde tu dominio | `font-src 'self'` |
| Service worker y manifest | `/sw.js` | `worker-src 'self'`, `manifest-src 'self'` |

**Propuesta (`next.config.ts`, `headers()` para `/:path*`):**

```
Content-Security-Policy-Report-Only:
  default-src 'self';
  script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https:;
  font-src 'self' data:;
  connect-src 'self' https://api.orbyx.cl https://*.supabase.co wss://*.supabase.co https://challenges.cloudflare.com;
  frame-src https://challenges.cloudflare.com https://maps.google.com https://www.google.com;
  worker-src 'self'; manifest-src 'self';
  object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
```

- Partir en Report-Only una semana, revisando la consola en landing, login con Turnstile, signup, reserva pública con mapa, dashboard, billing y vuelta de Flow, invite y admin.
- `'unsafe-inline'` en `script-src` es inevitable (script en línea en `layout.tsx:57` y scripts de Next). Igual valen `frame-ancestors`, `object-src`, `base-uri`, `form-action` y la lista de `connect-src`.
- `frame-ancestors 'none'` rompe a negocios que embeban su página de reservas. Decisión: si se permite, dejar `/[slug]` sin esa directiva.

---

## 5. Hallazgos menores

| Sev. | Hallazgo | Dónde |
|---|---|---|
| Crítico | `GET /pets/:slug` público filtra datos (ver 1b) | `server.js:10889` |
| Crítico | Invitaciones: token devuelto y contraseña fijada en cuentas existentes (ver 3) | `server.js:24545`, `24717` |
| Importante | Rate limit público compartido por la IP de Vercel (ver 1) | `server.js:42`, `1952` |
| Importante | `/signup/start-paid` sin captcha en el backend; crea una fila en `signup_intents` y un cliente en Flow por llamada, sin validar el correo, y devuelve `err.message` | `server.js:17811` |
| Importante | `/auth/password-reset` solo verifica Turnstile si existe el secret (ver 6) | `server.js:23583-23591` |
| Importante | CORS acepta cualquier `https://orbyx*.vercel.app`; riesgo real bajo (sin cookies cruzadas), pero conviene listar dominios exactos | `server.js:1886` |
| Importante | Mensajes de error con detalle interno: ~124 respuestas con `error: err.message` y 12 con `detail: err.message` | `server.js` |
| Importante | Endpoints públicos sin limitador: `POST /invitations/accept/:token`, `GET /invitations/token/:token`, GET de confirmación de cambio de correo (además cambian estado por GET) | `server.js:24634`, `24808`, `25234`, `25270` |
| Menor | `upload-deposit-receipt`: su límite es en memoria dentro de una función serverless | `orbyx-web/app/api/upload-deposit-receipt/route.ts:20-40` |
| Menor | La ruta Next de reservas devuelve `debug_payload` con los datos del cliente en los errores | `orbyx-web/app/api/appointments/slot/route.ts` |
| Menor | `/appointments/slot` acepta `source` arbitrario si se llama al backend directo | `server.js:7029` |
| Menor | `extractClientIp` toma el primer valor de `x-forwarded-for` (falsificable) | `server.js:13685` |
| Menor | `signup/page.tsx` crea un cliente de `supabase-js` directo (sesión en localStorage por defecto) | `orbyx-web/app/signup/page.tsx:6` |
| Info | `npm audit`: backend 0 vulnerabilidades. Frontend: 5 "high" que son una sola cadena (`braces` → `eslint-config-next`, solo desarrollo, sin parche). No usar `--force` | |
| Info | Sin secretos versionados: `token.json` y los `.env` están en `.gitignore` y no figuran en el historial | |
| Doc | CLAUDE.md dice que `/jobs/send-reminders` no tiene auth; ya usa `requireSignupMaintenanceSecret` (`server.js:21454`) | |

Lo que está bien: RLS en tablas críticas, admin validado en el backend (`requireAdminAuth`, `server.js:22531`), los endpoints de mantenimiento fallan cerrado si falta `SIGNUP_MAINTENANCE_SECRET`, y el Flow webhook consulta el estado a Flow en vez de confiar en el body.

---

## 6. Turnstile

- **Backend.** Solo hay una verificación: `verifyTurnstileToken` (`server.js:23583`), usada únicamente en `POST /auth/password-reset`, con `TURNSTILE_SECRET_KEY`.
- **Si la variable no está definida, deja pasar todo** (`server.js:23584-23591`): escribe un warning una vez y devuelve `true`. Falla abierto.
- **Login, signup y demás.** Pasan el token a Supabase con `options: { captchaToken }` (`login/page.tsx:192`, `signup/page.tsx:120`, `completar-registro/page.tsx:94`, `invite/[token]/page.tsx:76`, `admin/login/page.tsx:31` y configuración). El backend no verifica nada de eso. Si "Captcha protection" no está activada en Supabase, el widget es decorativo.
- **Sin ningún captcha servidor:** reserva pública y `/signup/start-paid`.

**Revisar a mano:** `TURNSTILE_SECRET_KEY` en Render; Supabase → Auth → Attack Protection → Captcha protection con Turnstile y el mismo secret; dominios del widget en Cloudflare; Supabase → Auth → Rate Limits.

---

## 7. Checklist de seguridad y SEO

| Ítem | Estado | Detalle |
|---|---|---|
| Tokens de sesión en localStorage | Parcial | La sesión usa cookies con `@supabase/ssr` (`lib/supabase/client.ts`), legibles por JS (no HttpOnly). `signup/page.tsx` usa `supabase-js` directo (localStorage) |
| Admin validado en el backend | Existe | `requireAdminAuth` (`server.js:22531`) |
| Rate limit en login | Parcial | Nada propio; depende de Supabase Auth y de Turnstile |
| Rate limit en recuperación de contraseña | Existe (limitado) | `passwordVerifyLimiter` 10/min por IP más espera de 60 s por correo en memoria |
| Aviso de cookies | No existe | La política dice que solo hay cookies funcionales (`privacidad/page.tsx:403`); un banner no es obligatorio |
| HTTPS forzado | Existe (plataforma) | Vercel y Render redirigen; el backend manda HSTS por helmet |
| `sitemap.xml` y `robots.txt` | No existen | |
| Favicon | Existe | `app/favicon.ico`, `app/icon.png`, `apple-icon.png` |
| Página 404 personalizada | No existe | No hay `not-found.tsx` |
| Alt en imágenes de la landing | Existe | Las 3 imágenes tienen alt (`page.tsx:167`, `AgendaMockup.tsx:56`, `RubrosCarousel.tsx:237`) |
| Preguntas frecuentes | Desactualizado | Ver abajo |

**FAQ y textos que ya no calzan.**
- `dashboard/[slug]/soporte/faq-data.ts`, sobre sucursales: "Pro: 1, Premium: 2, VIP: 3, Platinum: 10". Los planes vigentes son Starter, Business y Premium; confirmar límites en `plan_config`.
- `planes/page.tsx:1495`: "Versión de prueba … en Pro" usa el nombre antiguo.
- La landing (`page.tsx:68`) anuncia "gratis" y "Sin tarjeta" en general; la prueba de 30 días es solo de Starter (`planes/comparar/page.tsx:144`).
- Confirmar que "responde según la prioridad de tu plan" sigue siendo cierto.
- No existe una FAQ pública fuera del dashboard.

---

## 8. Pendientes de lanzamiento

**Política de Privacidad.** `app/privacidad/page.tsx` es la versión 3.0 del 10 de septiembre de 2026: dice que Orbyx no usa IA (líneas 47, 247, 265) y lista a Vercel y Render (líneas 290–291). Confirmar que lo publicado en orbyx.cl/privacidad coincide con este repo.

**Flow sandbox → producción.** Es solo cambio de variables, en el servicio de Render:
- `FLOW_API_URL` = `https://www.flow.cl/api`. `server.js:4019` deduce el ambiente de esta variable.
- `FLOW_API_KEY` y `FLOW_SECRET_KEY` con las credenciales productivas; tienen prioridad sobre las `FLOW_SANDBOX_*` (`server.js:4030-4031`). Conviene borrar las `FLOW_SANDBOX_*`.
- Vercel no tiene variables de Flow.
- No hay nada de sandbox escrito a fuego. Las URLs `urlCallback` y `url_return` ya son `api.orbyx.cl` (`server.js:4183`, `15166`, `16532`, `17956`). Hay un callback de WhatsApp a la URL antigua de Render (`server.js:21828`) por compatibilidad.
- Los planes se crean solos: `getOrCreateFlowPlan` (`server.js:4139`) los crea por API con el id `orbyx_<plan>_<ciclo>_<monto>` y los guarda en `flow_plans` separados por `flow_env`. Los add-ons se cobran con `customer/charge` y pago único, sin planes en Flow.
- Los tenants, suscripciones y `signup_intents` de prueba con `flow_customer_id` y `flow_subscription_id` de sandbox apuntan a clientes que no existen en producción: hay que borrarlos o reinscribir las tarjetas.
- En el panel de Flow productivo, confirmar que la cuenta tiene activados el cobro automático y las suscripciones.

**`keep-alive.yml`.** Sigue en `.github/workflows/keep-alive.yml` del repo backend: pega a `https://api.orbyx.cl/health` cada 10 minutos. Con Render pagado ya no sirve para evitar el sueño. Se puede borrar o reemplazar por un monitor de uptime externo.

**Importación de clientes.** Ya existe (2026-10-12): botón "Importar clientes" (`ImportCustomersModal.tsx`), endpoints `/customers/import/:slug/{preview,commit,history,:importId/undo}` (`server.js:10060-10236`), migración `2026-10-12-customer-import.sql`. Confirmar que esa migración está corrida en producción.

**Comprobantes y boletas.** Orbyx no genera ninguna boleta, factura ni comprobante propio al tenant. Existe la pestaña "Historial de pagos" (`billing/page.tsx:1052`, `/billing/flow/payment-history` en `server.js:17747`) que lista los cargos que devuelve Flow. Cualquier comprobante lo manda Flow; no hay integración con el SII.

---

## Pruebas y verificaciones manuales

**Render:** `TURNSTILE_SECRET_KEY`, `SIGNUP_MAINTENANCE_SECRET` y `TWILIO_AUTH_TOKEN` definidas; quién resuelve `api.orbyx.cl` (DNS directo o proxy de Cloudflare); variables de Flow (`FLOW_API_URL`, `FLOW_API_KEY`, `FLOW_SECRET_KEY`, borrar `FLOW_SANDBOX_*` al cambiar); servicio en plan pagado.

**Supabase:** captcha activado con Turnstile y secret; Rate Limits; migraciones `2026-09-30-rls-close-anon-tables.sql` y `2026-10-12-customer-import.sql` corridas; limpiar tenants, suscripciones y `signup_intents` de prueba antes de pasar Flow a producción; confirmar límites reales de sucursales por plan en `plan_config`.

**Vercel:** `NEXT_PUBLIC_BACKEND_URL` apunta a `api.orbyx.cl`; host de `NEXT_PUBLIC_SUPABASE_URL` (para la CSP); `NEXT_PUBLIC_TURNSTILE_SITE_KEY`; que `orbyx.cl/privacidad` sirva la versión 3.0.

**Flow:** cobro automático y suscripciones activados en la cuenta productiva; una suscripción real del plan más barato y verificar que el webhook la marque pagada.

**Cloudflare:** dominios del widget Turnstile (`orbyx.cl`, `www.orbyx.cl`).

**Decisiones:** si las páginas públicas de reserva pueden embeberse en sitios de terceros (define `frame-ancestors`).

## Orden de corrección recomendado

1. `GET /pets/:slug` (1b).
2. Invitaciones (3).
3. Reservas falsas (1): A (IP real y límite propio), luego B (Turnstile), y C ligero.
4. Escapar el correo de comprobante, limitar el largo de `customer_name`, validar el correo en `/signup/start-paid`.
5. Turnstile: secret, fallar cerrado en producción, revisar Supabase.
6. Cabeceras de seguridad en Report-Only.
7. Flow a producción: limpieza de datos de prueba y checklist de variables.
8. Menores: regex de CORS, mensajes de error, límites en endpoints públicos, `sitemap`/`robots`/404, FAQ, borrar `keep-alive.yml`.
