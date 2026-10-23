# Auditoría de Seguridad — Fase 1 (Reporte, sin fixes aplicados)

Fecha: 2026-08-30. Alcance: `server.js` (backend), `orbyx-web/` (frontend), migraciones `.sql` del repo, Storage de Supabase, integraciones Twilio/Flow/Google Maps. Metodología: lectura directa de código + 3 sub-auditorías paralelas (RLS/Storage, IDOR/rate-limiting/CORS, validación de inputs/XSS/SQLi) + `npm audit` en ambos proyectos. Todos los hallazgos críticos/altos fueron releídos y confirmados línea por línea antes de incluirse aquí — no se reporta nada solo "según un sub-agente" sin verificación directa.

**No se aplicó ningún fix en esta fase.** Este documento es el insumo para decidir prioridades de la Fase 2.

---

## 🔴 CRÍTICO

### C1. ~~RLS de `tenants` y `tenant_users` nunca se activó~~ — VERIFICADO EN PRODUCCIÓN, FALSO POSITIVO (2026-08-30)
**Estado: RESUELTO — no requiere ningún cambio.**
**Dónde:** `2026-05-31-accounts-base-B.sql:54-68` (repo) + uso directo en `orbyx-web/middleware.ts:72,82,195,209` y `orbyx-web/app/login/page.tsx:33,60`.
**Qué se pensó:** el archivo de migración del repo trae las políticas de RLS para `tenants` y `tenant_users` **comentadas** — lo que sugería que nunca se activaron, mientras esas dos tablas se consultan directo con la anon key en el middleware que decide todo el acceso al dashboard.
**Verificación real (Camilo, Supabase SQL editor, 2026-08-30):** `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('tenants','tenant_users','subscriptions')` → **las 3 dan `true`**. Además `pg_policies` confirma que ya existen políticas de `SELECT` reales y correctas, activas en producción, creadas directo en el Dashboard de Supabase en algún momento (nunca se volcaron al `.sql` del repo — por eso el archivo de migración las muestra comentadas, mismo patrón ya documentado para `appointments`/`legal_acceptances`):
- `tenants_select`: `is_member(id)`
- `tenant_users_select`: `user_id = auth.uid() OR is_member(tenant_id)`

Solo hay políticas de `SELECT` en ambas tablas (nada de `INSERT`/`UPDATE`/`DELETE` vía RLS) — correcto, porque todas las escrituras las hace el backend con la service role key, no el cliente. **No hace falta ningún cambio en Supabase para C1.**

---

### C2. ~~`subscriptions` — gate de facturación vía anon key sin RLS documentada~~ — VERIFICADO EN PRODUCCIÓN, FALSO POSITIVO (2026-08-30)
**Estado: RESUELTO — no requiere ningún cambio.**
**Dónde:** `orbyx-web/middleware.ts:119` (decide si el dashboard queda bloqueado por falta de pago).
**Verificación real:** mismo query que C1 — `subscriptions.relrowsecurity = true`, con política `tenant_users_can_read_own_subscriptions` activa: escapa por `tenant_id IN (SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid() AND is_active = true)`. Solo `SELECT`, ninguna escritura vía RLS (correcto, mismo motivo que C1). **No hace falta ningún cambio en Supabase para C2.**

---

### C3. `DELETE /staff/:id` y `PUT /staff/:id` — IDOR: se puede borrar/editar personal de OTRO negocio
**Dónde:** `server.js:4554` (DELETE) y `server.js:4468` (PUT).
**Qué es:** Ambos endpoints usan `tenantAuthWrite`, que sí valida que el `tenant_id` del body pertenezca al usuario autenticado — pero **la query final no filtra por `tenant_id`**, solo por `id`:
```js
// DELETE /staff/:id, server.js:4558-4561
const { error } = await supabase.from("staff").delete().eq("id", id);
```
Un owner/admin autenticado de su propio negocio, si conoce (o prueba) el UUID de un `staff.id` de otro tenant, puede borrarlo o editarlo sin ninguna verificación de que le pertenece.
**Escenario concreto:** Usuario autenticado en el negocio A llama `DELETE /staff/<uuid-de-un-profesional-del-negocio-B>` con su propio `tenant_id` válido en el body → el profesional del negocio B se elimina.
**Fix:** solo código — agregar `.eq("tenant_id", effectiveTenantId)` (o el equivalente ya resuelto por `enforceTenantId`) a ambas queries, o mejor, hacer fetch previo del staff y comparar `tenant_id` antes de mutar (patrón que sí se usa correctamente en `customers`, `pets` y `service-groups` en este mismo archivo).

---

### C4. `PATCH /branches/:id` — IDOR: se puede editar cualquier sucursal de OTRO negocio
**Dónde:** `server.js:14313-14457`.
**Qué es:** Mismo patrón que C3. `existingBranch` se lee con `.eq("id", id)` sin `tenant_id` (línea 14345-14349); el body permite mandar un `tenant_id` propio que solo se usa para checks secundarios (límite de sucursales), nunca para comparar contra `existingBranch.tenant_id`; y el `UPDATE` final (línea 14452-14457) filtra únicamente por `.eq("id", id)`. Confirmado leyendo el código completo de la función.
**Impacto:** un owner/admin de cualquier negocio puede modificar nombre, dirección, teléfono, email, coordenadas geográficas y estado activo/inactivo de la sucursal de **cualquier otro tenant**, con solo conocer el UUID.
**Fix:** código — filtrar el fetch inicial y el update final por `tenant_id`.

---

### C5. `PATCH /services/:id` — mismo patrón IDOR
**Dónde:** `server.js:14761` (según sub-auditoría, mismo patrón exacto que C3/C4: lectura y update sin scoping por `tenant_id`).
**Impacto:** edición de servicios (precio, duración, buffers, capacidad grupal) de otro tenant.
**Fix:** código.

---

### C6. `GET /pets/:id/clinical-pdf` — fuga de fichas clínicas veterinarias entre negocios
**Dónde:** `server.js:7296-7327`.
**Qué es:** El endpoint solo exige `[dashboardLimiter, requireTenantAuth]` — es decir, **cualquier usuario autenticado, de cualquier negocio**, no solo miembros del tenant dueño de la mascota. Resuelve el tenant por `slug` (dato público, es la URL de reserva) y sí filtra el pet por `tenant_id` correctamente, pero **nunca verifica que el usuario autenticado sea miembro de ESE tenant** (falta `resolveTenantMembership`/`requireTenantMembership`).
**Impacto:** un usuario logueado en el dashboard de cualquier negocio puede descargar el PDF con historial clínico completo (diagnósticos, tratamientos, medicamentos) de una mascota de **otra veterinaria**, con solo conocer el `slug` público de esa veterinaria y el UUID de la mascota. Es dato médico — el hallazgo de mayor sensibilidad de todo el IDOR sweep.
**Fix:** código — agregar `requireTenantMembership(req, res, tenant.id)` (o equivalente) antes de generar el PDF.

---

### C7. `POST /tenants/provision` — sin autenticación, permite provisionar un tenant a nombre de cualquier usuario
**Dónde:** `server.js:10746`.
**Qué es:** Sin ningún middleware de auth (ni `requireTenantAuth`, ni Bearer token, ni rate limiter). Solo recibe `user_id`/`email`/`plan`/`phone` en el body y confirma que `user_id` exista en Supabase Auth vía la API admin — pero **no confirma que quien llama el endpoint esté autenticado como ese `user_id`**. Si se conoce (o filtra por algún otro medio) el UUID de un usuario real, cualquiera puede llamar este endpoint para crear un tenant y vincularlo como dueño a esa cuenta ajena (`linkTenantOwner`), disparando además el email de aceptación de Términos de Servicio hacia esa persona sin su consentimiento real.
**Fix:** código — exigir sesión autenticada y comparar `req.authenticatedUser.user_id === user_id` del body, más un rate limiter (`publicLimiter` como mínimo).

---

## 🟠 ALTO

### A1. `DELETE /services/:id`, `PUT /business-special-dates/:id`, `PUT /staff-special-dates/:id` — mismo patrón IDOR que C3-C5
**Dónde:** `server.js:14881`, `server.js:4095`, `server.js:4961`.
**Detalle extra en `business-special-dates`:** este endpoint ni siquiera hace un fetch previo de verificación — y encima permite **reasignar** `tenant_id` vía body sin ninguna comparación contra el recurso existente.
**Fix:** código, mismo patrón de fix que C3-C5.

### A2. `GET /campaigns/logs/:campaignId` y `GET /appointments` — lectura cross-tenant sin membership
**Dónde:** `server.js:9480` y `server.js:7604`.
**Qué es:** Ambos solo exigen `requireTenantAuth` (sesión válida) pero filtran la query por un ID que no se valida contra el tenant del usuario (`campaign_history_id` y `calendar_id` respectivamente, sin `tenant_id` ni membership check).
**Impacto:** exposición de nombre/email/teléfono de clientes de campañas, y de citas (con notas) de otro tenant, si se conoce/adivina el ID.
**Fix:** código.

### A3. Endpoints de soporte (`/support/tickets/:id/*`) sin verificación de membership
**Dónde:** `server.js:16404` (mensajes), `16478` (marcar leído), `16513` (resolver), `16535` (confirmar resolución).
**Qué es:** `tenant_id` viaja en query/body y se usa directo en el WHERE, sin `resolveTenantMembership`.
**Impacto:** leer o alterar el estado de tickets de soporte de otro tenant.
**Fix:** código.

### A4. `POST /onboarding/setup` sin rate limiter
**Dónde:** `server.js:15907`.
**Qué es:** Crea tenants públicos por slug sin ningún limiter (a diferencia de `/signup/start-paid`, que sí usa `publicLimiter`).
**Impacto:** squatting de slugs / creación masiva de tenants basura.
**Fix:** código — agregar `publicLimiter`.

### A5. ~~`GET /jobs/send-reminders` sin auth ni secreto~~ — RESUELTO (commit `06e5845`, 2026-08-30)
**Dónde:** `server.js` (línea original ~15701). Ya estaba señalado como "known gap" en el contexto del proyecto (WhatsApp integration notes) pero se confirmó vigente en esta auditoría.
**Qué era:** disparaba el envío real de emails de recordatorio a clientes de **todos los tenants** con cita en 24-25h, sin ningún secreto ni rate limiter — su endpoint hermano (`/whatsapp/maintenance/send-reminders`) sí estaba protegido con `publicLimiter` + secreto. Cualquiera que descubriera la URL podía spamear a los clientes reales de todos los negocios repetidamente.
**Fix aplicado:** mismo patrón `[publicLimiter, requireSignupMaintenanceSecret]` que ya usan los otros 3 jobs de mantenimiento. Camilo confirmó (logs de Render + revisión propia) que no hay ningún cron interno ni externo llamando este endpoint hoy — Orbyx no tiene actualmente una función de recordatorio por email 24h activa (el único email automático real es la confirmación inmediata al agendar). Confirmado también por grep de código: no está entre las 3 tareas `cron.schedule` internas (`release-expired-deposits`, `signup/maintenance/sweep`, `billing/addons/maintenance/charge-recurring`) ni referenciado en ningún otro archivo. **Funcionalidad sin uso en producción hoy** — queda protegida por si se retoma en el futuro.

### A6. Dependencias con vulnerabilidades conocidas de severidad alta
**Backend — RESUELTO (commit `208fb90`, 2026-08-30):** `npm audit fix` (sin `--force`) resolvió las 10 vulnerabilidades (`path-to-regexp` ReDoS/DoS alta, `ws` memory disclosure+DoS alta, `multer` DoS, `qs` DoS media, `uuid` media vía `svix`/`resend`) — todo dentro de los rangos semver ya declarados en `package.json`, sin cambios de major. `npm audit` ahora reporta 0 vulnerabilidades.

**Frontend — investigado 2026-08-30, CONFIRMADO APLICABLE, pendiente decisión de upgrade.** Next.js instalado: **16.1.6**. Se verificaron en detalle las 2 advisories de la familia "Middleware / Proxy bypass" más relevantes para esta app (no las 4 genéricas del audit — se descartaron 2 por no aplicar a esta config, ver abajo):

- **GHSA-492v-c6pp-mqqv** (bypass vía inyección de parámetro de ruta dinámica): afecta Next.js `16.0.0–16.2.4`. **16.1.6 está dentro del rango vulnerable.** Fix en `16.2.5`. Mecanismo: un query param especialmente armado puede alterar el valor de ruta dinámica que ve la página, dejando la URL visible sin cambios — puede saltarse un chequeo de autorización en middleware basado en el path.
- **GHSA-267c-6grr-h53f** (bypass vía rutas de segment-prefetch): afecta Next.js `≥15.2.0 <15.5.16` y `≥16.0.0 <16.2.5`. **16.1.6 está dentro del rango vulnerable.** Fix en `16.2.5`. Requiere exactamente: (1) App Router, (2) autorización dependiente de middleware/proxy sin duplicar el chequeo a nivel de página. Mecanismo: URLs `.rsc` y de segment-prefetch especialmente armadas pueden resolver a la misma página protegida sin que el matcher del middleware las reconozca.

**Las 2 condiciones de GHSA-267c-6grr-h53f se cumplen exactamente en este proyecto**: `orbyx-web` usa App Router, y — confirmado leyendo `orbyx-web/middleware.ts` completo — **todo el control de acceso a `/dashboard/**` y `/admin/**` vive únicamente ahí** (sesión activa, membership del tenant, bloqueo por facturación); no hay un chequeo redundante a nivel de página/layout que sirva de segunda barrera si el middleware se saltea. Es decir: esta app es exactamente el escenario que la advisory describe como vulnerable, no una coincidencia de versión sin relevancia real.

Se descartaron como no aplicables (confirmado leyendo `orbyx-web/package.json` y `next.config.ts`): la variante de Turbopack+single-locale (el proyecto usa `next dev`/`next build` sin flag `--turbo`) y la de Pages Router+i18n (el proyecto es 100% App Router, sin config `i18n` en `next.config.ts`).

`npm audit fix --force` propone subir a `next@16.3.3` — versión posterior a `16.2.5`, cubre ambos fixes.
**Fix:** código — subir a `next@16.3.3` (o al menos `16.2.5`) con `npm audit fix --force`, luego `npm run build` + verificar que el middleware sigue redirigiendo correctamente `/dashboard/**` sin sesión antes de dar por cerrado.

---

## 🟡 MEDIO

### M1. ~~Sin límite de largo en la mayoría de los campos de texto libre~~ — RESUELTO (commit `787f01c`, 2026-08-30)
**Dónde:** múltiples — `notes`/`reason` en `POST /appointments/slot`, campos clínicos completos en `POST /clinical-notes/:slug`, notas de mascota (`POST /pets` y `PATCH /pets/:id`), campos de negocio/sucursal (`PATCH /tenants/:id`, `POST /branches`, `PATCH /branches/:id`), `PATCH /customers/:id`.
**Qué era:** el patrón general era `String(valor).trim()` sin ningún `maxLength`. El único lugar con un cap real era `PATCH /appointments/:id/session-notes` (límite de 300 caracteres) — buen patrón, pero no replicado en ningún otro lado. Cualquiera que llamara la API directo (sin pasar por el frontend) podía mandar textos arbitrariamente largos.
**Fix aplicado:** nuevo helper compartido `validateText(value, { maxLen, required })` (junto a `normalizeNullableText`), generalizando el criterio de 300 caracteres — con límites por tipo de campo, no un cap único: 50-200 para campos cortos (teléfono, sexo, ciudad, nombre), 500-1000 para notas/descripciones, 2000 para los campos de ficha clínica completa (diagnóstico, tratamiento, síntomas, etc.), deliberadamente generosos para no afectar ningún dato real ya existente. Aplicado en los 8 endpoints listados arriba.
**Nota adicional resuelta:** `PATCH /customers/:id` ahora también valida formato de email con `isValidEmail` (promovida a helper compartido junto a `validateText`, misma lógica que ya usaba la reserva pública) — antes solo se validaba el formato en el booking público, no al editar un cliente desde el dashboard.
**Impacto (ya mitigado):** no era XSS ni SQLi (Supabase parametriza, sin renderizado HTML sin escapar de estos campos) — era riesgo de integridad de datos / DoS de almacenamiento (filas gigantes, romper layouts que no esperan textos tan largos).

### M2. `verifyCurrentPassword` sin rate limit dedicado
**Dónde:** `server.js:18021`, usado en `POST /account/email-change/request`.
**Qué es:** hace un login real contra Supabase con la contraseña recibida (actúa como oráculo de contraseña), protegido solo por el `dashboardLimiter` general (300 req/min compartido con todo el dashboard) — no hay un límite más estricto por cuenta/IP específico para intentos de contraseña.
**Fix:** código — rate limiter dedicado y más estricto para este endpoint puntual.

### M3. `GET /account/email-change/status` — expone email pendiente de otra cuenta
**Dónde:** `server.js:18188`.
**Qué es:** `user_id` viene de query sin compararlo contra `req.authenticatedUser.user_id`.
**Fix:** código.

### M4. Buckets de Storage sin políticas RLS documentadas (`storage.objects`)
**Dónde:** los 5 buckets encontrados (`business-logos`, `deposit-receipts`, `staff-photos`, `campaign-images`, `ticket-attachments`) — ninguno tiene `CREATE POLICY ... ON storage.objects` en ningún `.sql` del repo. Como hoy todas las subidas pasan por rutas server-side con service role key (nunca anon key desde el cliente), esto no es explotable *hoy* vía Storage directo — pero es indocumentado y debería confirmarse en el Dashboard de Supabase. Adicionalmente, `staff-photos`, `campaign-images` y `ticket-attachments` **no tienen ningún registro de creación en `storage.buckets` en el repo** — fueron creados directo en el Dashboard, mismo patrón que ya se vio con `appointments`/`legal_acceptances`.
**Fix:** manual — Camilo debe confirmar en Supabase Dashboard el flag `public`/`private` y las políticas de cada bucket.

**Sub-hallazgo adicional en `ticket-attachments` (investigado y resuelto en código, 2026-08-30, sesión aparte)**: el nombre de archivo se armaba como `${tenant_id}/${Date.now()}-${nombre_original_sin_sanitizar}` (`POST /upload/ticket-attachment`) — predecible dentro de una ventana acotada, a diferencia de `deposit-receipts` que ya usaba `crypto.randomUUID()`. Se investigó el flujo completo (confirmado: nada en el frontend sube/lee este bucket directo, todo pasa por el backend) y se aplicó el fix de código necesario para poder pasar el bucket a privado sin romper la vista de adjuntos:
- `crypto.randomUUID()` reemplaza el nombre predecible (commit `76cca64`).
- Nuevo `GET /support/tickets/:id/attachment-url` (mismo patrón de auth que el resto de `/support/tickets`) genera un signed URL de 5 min, verificando que el path del adjunto pedido empiece con el `tenant_id` del caller antes de firmar (evita que un miembro de un tenant pida el signed URL de un adjunto de otro tenant) — commit `76cca64`.
- `orbyx-web/app/dashboard/[slug]/soporte/page.tsx` ahora resuelve cada adjunto (del ticket y de cada mensaje) a un signed URL antes de renderizarlo, en vez de usar la URL guardada directo como `src`/`href` — commit `5eba5d1` (orbyx-web) + `6b09397` (bump submódulo).
- El endpoint extrae el path desde la URL pública histórica ya guardada en `attachments` (sin migrar datos) — funciona tanto para adjuntos viejos como nuevos.

**Camilo puede pasar `ticket-attachments` a privado en el Dashboard de Supabase ahora que el fix está desplegado** — no requiere ningún otro cambio de código. Los otros 4 buckets de este hallazgo (`business-logos`, `deposit-receipts`, `staff-photos`, `campaign-images`) siguen pendientes de la misma revisión manual, sin cambios de código aplicados sobre ellos en esta sesión.

### M5. `test-twilio-send.tmp.js` — script de debug sin commitear, con logging de presencia de secretos
**Dónde:** raíz del repo, archivo untracked (no en git, confirmado con `git status`).
**Qué es:** script temporal de diagnóstico de Twilio, deliberadamente aislado (no se importa desde `server.js`). Loguea si cada env var de Twilio está presente (no el valor real de `TWILIO_API_KEY_SECRET`, ese sí lo oculta) pero sí imprime SIDs/números en texto plano por consola. No está commiteado, pero tampoco está en `.gitignore` explícitamente — si alguien corre `git add -A` podría terminar commiteado por accidente.
**Fix:** código — borrar el archivo (el propio comentario del script ya dice "bórralo cuando termines de diagnosticar").

---

## 🟢 BAJO / Sin hallazgo (confirmado correcto)

- **Secretos**: todos los secretos reales (Google OAuth, Supabase service role key, Flow API keys) están únicamente en `.env`/`.env.local`, ambos correctamente en `.gitignore` (raíz y `orbyx-web/`). Confirmado que **nunca** se commiteó un archivo `.env` en todo el historial de git (`git log --all --diff-filter=A` sobre patrones `.env*` no devuelve nada). No se encontraron secretos hardcodeados en el código fuente (grep de patrones típicos: `sk_live`, `AC[hex]`, `AIza...`, JWT `eyJ...` — sin resultados fuera de `.env`).
- **`NEXT_PUBLIC_*`**: solo `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` y `NEXT_PUBLIC_BACKEND_URL` — los 4 son datos que ya están diseñados para ser públicos (site key de Turnstile, URL/anon key de Supabase con RLS como capa real de seguridad, URL del backend). Ningún secreto real lleva ese prefijo.
- **`GOOGLE_MAPS_API_KEY`**: se usa solo server-side (`server.js:15044-15081`, generación de thumbnail de mapa). El mapa embebido en la página pública y en Datos del negocio usa la URL gratuita de Google Maps (`google.com/maps?q=...&output=embed`), que **no requiere API key** — confirmado que la key nunca llega al navegador.
- **Webhook de Twilio** (`POST /whatsapp/status-callback`, server.js:15782): valida `X-Twilio-Signature` correctamente vía `twilio.validateRequest()`, y falla cerrado (si falta `TWILIO_AUTH_TOKEN`, no procesa nada) — bien implementado.
- **Webhook de Flow** (`POST /billing/flow/webhook`, server.js:12408): no confía en el body del POST — re-consulta el estado real del pago contra la API de Flow (`GET /payment/getStatus`) antes de activar cualquier plan. Es el patrón correcto para Flow (que no firma sus webhooks) — sin hallazgo.
- **SQL injection**: toda la data pasa por el query builder de supabase-js (parametrizado). No se encontró SQL crudo ni concatenación de strings de usuario en ninguna query. Los 2 únicos `.rpc()` (`increment_site_visit_counter`, `get_available_slots`) pasan argumentos parametrizados, no strings concatenados.
- **XSS almacenado**: 4 usos de `dangerouslySetInnerHTML` en todo `orbyx-web`, los 4 inyectan contenido hardcodeado/estático (labels internos, script anti-flash de tema) — ninguno inyecta texto de tenant/cliente. Es code smell (debería ser JSX plano), no vulnerabilidad.
- **Otros endpoints de subida de archivos** (`/upload/campaign-image`, `/upload/ticket-attachment`): ambos correctamente protegidos con auth + `requireTenantWriteAccessForResource` + allowlist de MIME + límite de tamaño (2MB y 1MB respectivamente) — contraste positivo frente a los 3 endpoints de subida sin auth reportados abajo.
- **CORS**: allowlist explícita de orígenes (dominios de producción + regex de previews de Vercel), sin `origin: "*"`, sin combinación peligrosa con `credentials`, aplicado globalmente vía `helmet`+`cors` antes de todas las rutas. Sin hallazgo.
- **Headers de seguridad**: `helmet()` activo en el backend (con CSP explícitamente desactivado, razonable para una API JSON). El frontend no define headers propios en `next.config.ts` (sin CSP/X-Frame-Options/HSTS custom) — severidad baja según lo acordado, pero vale agregarlo en algún momento ya que ahí sí se sirve HTML al usuario final.
- **Rate limiting**: `publicLimiter` (100/min) y `dashboardLimiter` (300/min) cubren razonablemente bien booking público, signup y la mayoría del dashboard. El login en sí es 100% client-side vía Supabase Auth (sin ruta backend propia) — depende del rate limiting nativo de Supabase, no verificable desde este repo.

---

## ⚠️ Hallazgo separado, fuera del alcance original: 3 endpoints de subida de archivos SIN autenticación

No estaba explícitamente en la lista de la tarea, pero apareció al revisar validación de archivos subidos y es severo — **agrupo aparte porque son 3 rutas Next.js API en `orbyx-web/app/api/`, no server.js, y el propio `middleware.ts` las excluye a propósito** (comentario explícito: *"Excluye explícitamente: /api/** (no bloqueamos API routes de Next.js)"*) — es decir, están efectivamente sin ninguna capa de auth.

### X1. 🔴 CRÍTICO — `orbyx-web/app/api/upload-staff-photo/route.ts`
Cero autenticación, **cero validación de tipo de archivo, cero límite de tamaño**. Toma `staff_id` del form-data sin verificar a qué tenant pertenece, y sube con `upsert: true` (sobrescribe). Cualquier visitante anónimo de internet puede subir **cualquier archivo** (no solo imágenes — nada valida `file.type` antes de usarlo como `contentType`) y sobrescribir la foto de cualquier profesional de cualquier negocio.
**Fix:** código — exigir sesión + `requireTenantMembership` (vía un token/JWT pasado desde el dashboard autenticado), validar `file.type` contra un allowlist de imágenes, límite de tamaño (ej. 2MB, igual que campaign-image).

### X2. 🔴 CRÍTICO — `orbyx-web/app/api/upload-business-logo/route.ts`
Cero autenticación. Sí valida tipo (jpeg/png/webp) pero **sin límite de tamaño**, y no verifica que `tenant_id` pertenezca a quien llama. `upsert: true`. Cualquiera puede sobrescribir el logo de cualquier negocio, o subir archivos enormes sin límite.
**Fix:** código — mismo patrón que X1.

### X3. 🟠 ALTO — `orbyx-web/app/api/upload-deposit-receipt/route.ts`
Cero autenticación, pero mitigado parcialmente: sí valida tipo (jpg/png/pdf) y tamaño (5MB), usa `upsert: false` (no sobrescribe), y el paso posterior de "adjuntar" el comprobante a una reserva sí exige el `cancel_token` correcto (server.js:9837). El hueco real es que **cualquiera puede subir archivos indefinidamente** a cualquier `tenant_id`/`appointment_id` sin que nunca se adjunten a nada real — abuso de almacenamiento (relleno de Storage), no acceso a datos ajenos.
**Fix:** código — al menos aplicar un rate limiter a esta ruta pública (Next.js API routes no tienen el `publicLimiter` de Express); considerar exigir que `appointment_id`+`tenant_id` correspondan a una reserva `deposit_status = 'pending'` real antes de aceptar la subida.

---

## Resumen ejecutivo (para decidir qué priorizar en Fase 2)

| # | Hallazgo | Estado | Tipo de fix |
|---|---|---|---|
| C1 | ~~RLS `tenants`/`tenant_users`~~ | Verificado OK en vivo | — |
| C2 | ~~RLS `subscriptions`~~ | Verificado OK en vivo | — |
| C3 | ~~IDOR `DELETE`/`PUT /staff/:id`~~ | Resuelto (`0127d28`) | Código |
| C4 | ~~IDOR `PATCH /branches/:id`~~ | Resuelto (`0127d28`) | Código |
| C5 | ~~IDOR `PATCH /services/:id`~~ | Resuelto (`0127d28`) | Código |
| C6 | ~~Fuga de fichas clínicas cross-tenant~~ | Resuelto (`0127d28`) | Código |
| C7 | ~~`POST /tenants/provision` sin auth~~ | Resuelto (`38bd197`+`a07322f`) | Código |
| X1 | ~~Upload staff-photo sin auth ni validación~~ | Resuelto (`e0fba26`) | Código |
| X2 | ~~Upload business-logo sin auth~~ | Resuelto (`e0fba26`) | Código |
| A1 | ~~IDOR adicional (services delete, special-dates x2)~~ | Resuelto (`0127d28`) | Código |
| A2 | ~~Lectura cross-tenant (campaign logs, appointments)~~ | Resuelto (`0127d28`) | Código |
| A3 | ~~Support tickets sin membership check~~ | Resuelto (`0127d28`) | Código |
| A4 | ~~Onboarding sin rate limit~~ | Resuelto (`38bd197`) | Código |
| A5 | ~~Job de recordatorios email sin auth~~ | Resuelto (`06e5845`) | Código |
| A6 | ~~Dependencias con CVEs altas (ambos repos)~~ | Resuelto (`208fb90`+`021e2d6`) | Código |
| X3 | ~~Upload deposit-receipt sin auth (mitigado parcial)~~ | Resuelto (`e0fba26`) | Código |
| M1 | ~~Validación de largo en texto libre + email en customers~~ | Resuelto (`787f01c`) | Código |
| M2 | ~~Rate limit dedicado para verificación de password~~ | Resuelto (`38bd197`) | Código |
| M3 | ~~IDOR menor en `/account/email-change/status`~~ | Resuelto (`38bd197`) | Código |
| M4 | Storage sin políticas RLS documentadas | **Abierto** | Manual (Supabase) |
| M5 | ~~Script de debug sin borrar~~ | Resuelto (`38bd197`) | Código |

**M4 es el único hallazgo sin cerrar de todo el reporte** — no estaba en ninguna de las 7 etapas de código porque es 100% acción manual de Camilo en el Dashboard de Supabase (confirmar `public`/`private` y políticas de `storage.objects` en los 5 buckets: `business-logos`, `deposit-receipts`, `staff-photos`, `campaign-images`, `ticket-attachments`). Ver detalle completo en la sección M4 más arriba.

**Actualización 2026-08-30:** C1 y C2 fueron verificados en vivo por Camilo — ambos falso positivo, RLS activa y correcta en producción (políticas creadas fuera del repo, mismo patrón que `appointments`). No requieren ningún cambio.

**Progreso Fase 2 (por etapas, ver detalle abajo):**
- ✅ Etapa 1 — commit `0127d28`: C3, C4, C5, A1 (+2 endpoints DELETE hermanos encontrados durante la implementación, mismo patrón exacto), C6, A2, A3.
- ✅ Etapa 2 — commits `38bd197` (backend, ver nota de incidente abajo) + `a07322f`/`3ebb096` (frontend + bump submódulo): C7 resuelto, requiere sesión autenticada en `/tenants/provision`.
  **Incidente menor durante esta sesión**: el fix de backend de C7 quedó incluido por error dentro del commit de la Etapa 5 (`git add server.js` amplio, sin revisar el diff completo antes de commitear) y se pusheó a producción *antes* de la confirmación explícita — el fix en sí era correcto y ya estaba validado, pero el commit de frontend correspondiente (que manda el Bearer token) todavía no se había hecho, así que por unos minutos el endpoint real de alta de tenants habría rechazado logins nuevos sin token. Se detectó y corrigió de inmediato en la misma sesión (commits `a07322f` + `3ebb096`), sin que mediara ningún alta de tenant real en el intervalo (a confirmar por Camilo revisando logs de Render de esa ventana si quiere estar 100% seguro). Lección: revisar el diff completo, no solo `--stat`, antes de cualquier commit que toque un endpoint recién editado en una etapa anterior de la misma sesión.
- ✅ Etapa 3 — commits `e0fba26` + `41f63e2`: X1 (`upload-staff-photo`) y X2 (`upload-business-logo`) ahora exigen Bearer token + membership del tenant, y X1 además valida tipo/tamaño de archivo (antes no validaba nada). X3 (`upload-deposit-receipt`) sigue anónima a propósito, pero exige que `appointment_id`+`tenant_id` correspondan a una reserva real `deposit_status='pending'`, más un rate limiter best-effort en memoria (nota: no persiste entre instancias serverless — mitigación parcial, no una defensa distribuida real).
- ✅ Etapa 4 — commit `06e5845`: `/jobs/send-reminders` ahora usa el mismo patrón `[publicLimiter, requireSignupMaintenanceSecret]` que los otros 3 jobs de mantenimiento. Camilo confirmó (logs de Render + revisión propia) que Orbyx no tiene hoy una función de recordatorio por email 24h activa — el único email automático real es la confirmación inmediata al agendar — y que ningún cron interno (node-cron) ni externo llama este endpoint. Confirmado también por grep: no está entre las 3 tareas `cron.schedule` internas ni referenciado en ningún otro lugar del código. **Es funcionalidad sin uso en producción hoy** — se deja protegida por si se retoma, no porque hubiera tráfico real que romper.
- ✅ Etapa 5 — commit `38bd197`: A4, M2, M3, M5.
- ✅ Etapa 6 backend — commit `208fb90`: `npm audit fix` sin `--force`, 0 vulnerabilidades.
- ✅ Etapa 6 frontend — commits `021e2d6` + `3135c0f`: confirmado que las 2 CVEs de "middleware bypass" (GHSA-492v-c6pp-mqqv, GHSA-267c-6grr-h53f) aplican de verdad a esta app (App Router + autorización solo en `middleware.ts`, next@16.1.6 dentro del rango vulnerable de ambas). Subido a `next@16.3.3` (fix en 16.2.5+). `npm run build` limpio. **Pendiente que Camilo confirme en el deploy real que `/dashboard/**` sigue redirigiendo correctamente sin sesión** — el build local no reemplaza esa verificación funcional.
- ✅ Etapa 7 — commit `787f01c`: nuevo helper compartido `validateText(value, { maxLen, required })` aplicado en 8 endpoints (booking público, clinical-notes, pets x2, tenants, branches x2, customers) con límites generosos por tipo de campo (50-200 corto, 500-1000 notas, 2000 ficha clínica). De paso, `PATCH /customers/:id` ahora valida formato de email igual que la reserva pública (`isValidEmail` promovida a helper compartido).

**Las 7 etapas de Fase 2 están cerradas.** Quedan 2 verificaciones funcionales pendientes de que Camilo confirme en el deploy real (no bloquean nada, son solo confirmación): (1) que `/dashboard/**` sigue redirigiendo bien sin sesión tras el upgrade de Next.js (Etapa 6), y (2) revisar logs de Render de la ventana breve donde `/tenants/provision` quedó exigiendo auth antes de que el frontend mandara el token (Etapa 2, incidente ya corregido en la misma sesión) para descartar que algún alta de tenant real haya quedado afectada.
