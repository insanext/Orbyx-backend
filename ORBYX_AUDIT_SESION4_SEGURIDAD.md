# Auditoría de seguridad — Sesión 4 de 5: seguridad general

**Fecha:** 2026-09-30 · **Tipo:** solo auditoría, **no se aplicó ningún fix**.
**Base revisada:** `Orbyx-backend` `main` @ `db196f9`, `orbyx-web` `main` @ `64acdb9`.

## Cómo se hizo

- Lectura dirigida de `server.js` (mapa de las 199 rutas con su middleware, luego handler por handler en todo lo que recibe un `:id`, un `tenant_id`/`slug` o es público), `email.js`, `whatsapp.js`, las rutas API de Next (`orbyx-web/app/api/**`), `middleware.ts`, `lib/api.ts` y `next.config.ts`.
- Búsqueda en **todo el historial de git** de ambos repos de patrones de secretos (JWT `eyJ…`, `re_…`, `SK…`/`AC…` de Twilio, `GOCSPX`, `sk_live`, service role hardcodeado).
- `npm audit --omit=dev` en ambos repos (solo lee el lockfile, no instala nada).
- Cabeceras HTTP públicas de `www.orbyx.cl` y `orbyx-backend.onrender.com/health`.
- **Una única consulta a producción**, sin leer datos: con la anon key pública (la misma que viaja en el JavaScript del sitio) se pidió solo el *conteo* de filas visibles de cada tabla (`HEAD` + `count=exact`, no devuelve ninguna fila). El paso siguiente (ver qué columnas tienen esas tablas y si las filas son de uno o de varios negocios) **fue bloqueado por el control de permisos de la sesión** y no se intentó por otra vía: queda como prueba pendiente para Camilo (ver T1–T4).

No se repite lo ya reportado en Fase 1 ni en las Sesiones 1–3, salvo cuando se confirmó que sigue abierto o cambió de gravedad.

> Nota sobre el nivel de detalle: la sección "cómo se podría explotar" de cada hallazgo describe **condiciones e impacto**, no pasos de ataque. Es suficiente para priorizar y corregir; las pruebas reales quedan en la tabla de pruebas pendientes, a ejecutar con autorización y contra un tenant de prueba.

---

## Resumen

| # | Hallazgo | Severidad | Tipo |
|---|---|---|---|
| C1 | La conexión de calendario de un profesional se puede reasignar a una cuenta de Google/Microsoft ajena, sin sesión | **Crítico** | Vulnerabilidad |
| C2 | 9 tablas (incluida `customers`) responden filas **sin login** usando la anon key pública | **Crítico** (a confirmar alcance) | Vulnerabilidad |
| I1 | `DELETE /service-groups/:id`: se valida un `tenant_id` y se borra con otro | Importante | Vulnerabilidad |
| I2 | `DELETE /staff-services/:id` borra por id sin revisar el negocio | Importante | Vulnerabilidad |
| I3 | `GET /test-event` sin autenticación crea eventos en calendarios de negocios | Importante | Código de prueba olvidado |
| I4 | Reserva pública: el rate limit no funciona por cliente (proxy de Vercel) y no hay captcha | Importante | Vulnerabilidad |
| I5 | Invitaciones: el token vuelve a quien invita; aceptar puede poner contraseña a una cuenta existente | Importante (latente) | Diseño peligroso |
| I6 | Inyección de HTML en el correo "Un cliente subió su comprobante" | Importante | Vulnerabilidad |
| I7 | Frontend sin cabeceras de seguridad (CSP, anti-iframe, nosniff) | Importante | Falta de defensa |
| M1–M14 | Menores (ver abajo) | Menor | Mixto |

---

## 🔴 CRÍTICOS

### C1. La conexión de calendario de un profesional se puede reasignar a una cuenta ajena, sin sesión

**Dónde:** `server.js:4264-4295` (`GET /auth`), `4353-4387` (`GET /auth/microsoft`), `4389-4496` (`GET /oauth2callback/microsoft`), `4502-4614` (`GET /oauth2callback`, rama staff), `4617-4664` (rama legacy por `calendar_id`). Contenido del evento: `server.js:7157-7162`.

**Qué pasa, en simple:** el flujo "Conectar calendario" no pide sesión en ninguna de sus 4 rutas, y el parámetro `state` que viaja al proveedor y vuelve es un JSON en base64 **sin firma ni vínculo con quien inició el flujo**. El callback confía en el `tenant_id`/`staff_id` (o `calendar_id`) que traiga ese `state`: desactiva la conexión vigente de ese profesional (`4574-4580` Google, `4454-4460` Microsoft) e inserta una nueva con el refresh token de **la cuenta que completó la autorización** (`4584-4602`, `4464-4480`). La rama legacy hace lo mismo sobre `calendar_tokens` por `calendar_id` (`4632-4644`).

**Por qué es crítico:** cada reserva nueva de ese profesional se escribe como evento en el calendario conectado, y el evento incluye **nombre, teléfono y correo del cliente** (`7158-7159`). Si la conexión queda apuntando a una cuenta ajena, esos datos personales se entregan a un tercero de forma continua, y el negocio además pierde su sincronización real sin aviso.

**Condiciones para que ocurra:** los tres identificadores que usa el flujo no son secretos: `GET /public/business/:slug` devuelve el `id` del negocio y su `calendar_id` (`server.js:19288-19356`, `calendar_id` en `19350`) y `GET /public/staff/:slug/:service_id` devuelve los `id` de los profesionales. No se requiere cuenta en Orbyx. También aplica la variante inversa (un dueño legítimo engañado para completar un flujo iniciado por otro — CSRF de OAuth).

**Cómo se confirmó:** lectura completa de las 4 rutas y del armado del evento; confirmado que ningún middleware de auth se aplica a esas rutas (mapa de rutas) y que los IDs necesarios salen de endpoints públicos. **No se probó contra producción** — ver prueba E1.

**Decisión previa o bug:** bug. El flujo nació como herramienta de un solo cliente ("modo fijo" `cliente_demo`, `4666-4683`) y se extendió a multi-tenant sin agregarle autenticación ni firma al `state`.

**Dirección del fix (para decidir después):** exigir sesión y membresía (owner/admin o permiso de staff) al *iniciar* el flujo, y firmar/guardar el `state` en servidor (nonce de un solo uso ligado a usuario + tenant + staff) para validarlo en el callback. Revisar además si la rama legacy y el "modo fijo" siguen en uso (ver P1).

### C2. Tablas legibles sin login con la anon key pública (RLS apagado o con política demasiado abierta)

**Dónde:** configuración de Supabase (no en el repo). Tablas afectadas y filas visibles para un visitante anónimo al momento de la prueba:

| Tabla | Filas visibles sin login |
|---|---|
| `customers` | 6 |
| `staff` | 8 |
| `branches` | 4 |
| `staff_services` | 12 |
| `business_hours` | 28 |
| `staff_special_dates` | 5 |
| `service_groups` | 2 |
| `tenant_addons` | 5 |
| `pets` | 1 |

Todas las demás tablas probadas devolvieron 0 filas (RLS funcionando o sin filas), incluidas `tenants`, `tenant_users`, `subscriptions`, `appointments`, `clinical_notes`, `calendar_connections`, `calendar_tokens`, `signup_intents`, `admin_users`, `legal_acceptances` — consistente con lo verificado en Fase 1 para `tenants`/`tenant_users`/`subscriptions`. `tenant_invitations` respondió 401 (sin permiso para anon, correcto).

**Qué pasa, en simple:** la anon key de Supabase no es secreta — está en el JavaScript público de `www.orbyx.cl` y es la que usa el navegador. Su única protección es RLS. En estas 9 tablas, la anon key obtiene filas sin ningún login, es decir: **cualquier persona en internet puede leer esos datos directamente desde Supabase, saltándose por completo el backend y todos sus chequeos de tenant**. `customers` y `pets` son datos personales de clientes finales (Ley 19.628).

**Lo que falta confirmar (y cambia la gravedad):**
1. Si las filas visibles son **todas** las de la tabla (RLS apagado) o solo un subconjunto (política permisiva). Comparar con el total real (T4).
2. Qué columnas se exponen (en `customers`, presumiblemente nombre/teléfono/correo).
3. **Si también se puede escribir.** Si RLS está apagado y los permisos por defecto de Supabase siguen vigentes para `anon`, la misma key podría insertar, modificar o borrar filas (ej. borrar clientes o cambiar horarios de negocios ajenos). Es la pregunta más urgente: T1–T3 la responden sin tocar datos.

**Cómo se confirmó:** conteo `HEAD` con `Prefer: count=exact` usando solo la anon key, sin leer ninguna fila. No se leyeron columnas ni contenido.

**Contexto:** el frontend no consulta ninguna de estas 9 tablas directamente (solo usa `tenants`, `tenant_users`, `subscriptions` y Realtime de `appointments`/`tenant_monthly_usage`); todo lo demás pasa por el backend con service role. Es decir, **cerrar RLS en estas tablas no debería romper nada del frontend** — a confirmar tabla por tabla antes de aplicar. Mismo patrón ya visto en el repo: los `.sql` no son un inventario fiel de lo aplicado en prod.

**Decisión previa o bug:** bug (no hay ninguna razón funcional para que sean legibles por anon).

---

## 🟠 IMPORTANTES

### I1. `DELETE /service-groups/:id` — el middleware valida un `tenant_id` y el handler borra con otro

**Dónde:** `server.js:18551-18578` (handler) y `server.js:2104-2114` (`enforceTenantId`).

**Qué pasa:** `enforceTenantId` toma el `tenant_id` a validar **primero del body y después de la query** (`req.body.tenant_id || req.query.tenant_id`). Este handler, en cambio, lee `tenant_id` **solo de la query** (`18554`). Si una misma request trae dos valores distintos, la membresía se valida contra uno y el borrado se hace contra el otro. Resultado: un usuario con sesión en cualquier negocio puede borrar un grupo de servicios de otro negocio (y desagrupar sus servicios, `18565-18569`), conociendo el id del grupo.

**Cómo se confirmó:** lectura de ambos bloques + barrido automático de todas las rutas de escritura bajo `tenantAuth*` buscando handlers que lean `tenant_id` de la query: **este es el único caso** (el mismo barrido con `slug` no encontró ninguno — todos leen el slug del mismo lugar que el middleware). No probado en prod (E3).

**Impacto real:** acotado (requiere el UUID del grupo, borra configuración, no datos personales). Pero el patrón es frágil: cualquier ruta futura que lea de la query con body presente repite el bug. **Fix natural:** que el middleware rechace requests donde body y query traen `tenant_id` distintos, o que el handler use `req.authenticatedUser.tenant_id`.

### I2. `DELETE /staff-services/:id` — borra por id sin comprobar el negocio

**Dónde:** `server.js:5723-5742`.

**Qué pasa:** el middleware `tenantAuthWrite` valida que el usuario pertenezca al `tenant_id` que *él mismo manda*, pero el borrado filtra solo por `id` (`5727-5730`), sin `.eq("tenant_id", …)`. Cualquier usuario con sesión en cualquier negocio puede borrar la relación profesional↔servicio de otro negocio si conoce su id. Efecto: ese profesional deja de ofrecerse para ese servicio en la página pública del negocio afectado.

**Cómo se confirmó:** lectura del handler; es el único endpoint `:id` de la revisión sistemática (≈45 rutas con `:id` revisadas, ver "Lo que está bien") que no filtra por tenant. Los ids no se exponen en endpoints públicos, lo que baja la probabilidad, no el tipo de bug. Mismo patrón que C3–C5 de Fase 1. No probado en prod (E4).

### I3. `GET /test-event` sin autenticación — crea eventos en calendarios de negocios

**Dónde:** `server.js:4726-4756` (usa `getGoogleCalendarClientByCalendarId`, `3992`, o el "modo fijo").

**Qué pasa:** ruta de prueba de los inicios del proyecto, sin auth ni rate limit. Con un `calendar_id` (público, ver C1) crea un evento "Prueba Proyecto Independizar" en el Google Calendar conectado por la vía legacy (`calendar_tokens`) de ese negocio, y devuelve el link al evento. Sin `calendar_id`, escribe en el calendario "modo fijo". Permite llenar de eventos basura los calendarios de negocios con conexión legacy y consume cuota de la API de Google del proyecto.

**Cómo se confirmó:** lectura; confirmado que no tiene middleware. No probado (E5). **Decisión previa o bug:** código de prueba olvidado; ver P1.

### I4. Reserva pública: el rate limit no limita por cliente y no hay captcha

**Dónde:** `orbyx-web/app/api/appointments/slot/route.ts:48-55` (proxy), `server.js:1817-1823` (`publicLimiter`, 100/min por IP), `server.js:6473` (`POST /appointments/slot`). Mismo patrón en los proxies `app/api/public-*`.

**Qué pasa, en simple:** la página pública no llama al backend directo: p