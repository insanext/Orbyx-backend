# RUNBOOK — Migración de Supabase a Virginia (día del corte)

Proyecto viejo: `vmxjqhndepvgoexajtfc` (São Paulo) · Proyecto nuevo: `fqmdcbvtrgcnftlwcojc` (us-east-1)
Plan de fondo y justificación: `ORBYX_SUPABASE_MIGRATION_PLAN.md`.

**Estado de este material:** preparado, **no ejecutado**. Ningún script se ha corrido contra el proyecto viejo ni el nuevo. No se cambió ninguna variable, no hay commit ni push. Los scripts están revisados en sintaxis y probados en modo simulacro con un `psql` de mentira; **el SQL nunca se ha corrido contra un Postgres real**. El ensayo de la Fase A es la primera ejecución real.

Palabras clave:
- **CLAUDE** = lo ejecuto yo (comandos en el computador de Camilo).
- **CAMILO** = lo haces tú a mano (clics en paneles).
- **PENDIENTE** = dato que no tengo. No lo inventé: hay que traerlo.

---

## 0. Reglas de seguridad de los scripts

1. **Todo script que escribe es un simulacro hasta que se le agrega `--apply`.** Sin esa bandera solo imprime lo que haría.
2. Con `--apply`, el script pide escribir el ref del proyecto que va a modificar. Si no coincide, cancela.
3. El proyecto **viejo** solo se lee: las conexiones usan `default_transaction_read_only=on`. Un script con `--apply` apuntado al viejo se detiene.
4. Cada script verifica que `OLD_DB_URL` contenga el ref viejo y `NEW_DB_URL` el nuevo. Si están cruzadas, se detiene.
5. Los respaldos que se bajan **no están cifrados**. Se guardan fuera del repo (`~/orbyx-migration-out`) y se borran al final con `99-cleanup.sh`.

## 0.5 URGENTE (independiente de la migración): cerrar 14 tablas abiertas en el proyecto VIEJO

Hallazgo del 2026-10-23: 14 tablas de `public` no tienen RLS y `anon` y `authenticated` tienen permisos completos (incluso borrar y vaciar). Se confirmó desde afuera con la llave pública que ya viaja en el JavaScript de orbyx.cl. Verificado por grep: ni el navegador ni Next usan esas tablas (solo consultan `appointments`, `branches`, `staff`, `subscriptions`, `tenant_users` y `tenants`; Realtime solo `appointments`, `reviews` y `tenant_monthly_usage`). El backend usa `service_role`, que no se ve afectado.

| # | CLAUDE | CAMILO (SQL Editor del proyecto VIEJO) |
|---|---|---|
| U1 | `bash migration/13-close-no-rls-tables.sh --target old` (muestra el estado: 14 filas ABIERTA) | Supabase → proyecto viejo → **SQL Editor** → New query → pega el contenido de `migration/sql/13a-estado-14-tablas.sql` → **Run** (verificación ANTES) |
| U2 | | New query → pega `migration/sql/13b-cerrar-14-tablas.sql` → **Run**. Debe decir "Success" y mostrar 14 avisos "cerrada: public.xxx" |
| U3 | | New query → pega de nuevo `13a-estado-14-tablas.sql` → **Run** (verificación DESPUÉS): las 14 filas deben decir **CERRADA** |
| U4 | `bash migration/13-close-no-rls-tables.sh --target old` y `bash migration/14-check-anon-exposure.sh --target old` (desde afuera, con la llave pública: las 14 deben dar http 401/403) | Prueba rápida en el dashboard: Agenda, Staff, Servicios, Soporte y Calendario cargan normal |
| U5 | | **Si algo dejó de funcionar y no hay tiempo de investigar:** pega `migration/sql/13c-deshacer-cierre.sql` para volver al estado anterior y avísame |

El mismo cierre se aplica en el proyecto NUEVO en el ensayo (A10b) y `08-compare-schema.sh` falla si alguna de las 14 queda abierta.

## 1. ANTES DE EMPEZAR: qué debes revisar y traer

Marca cada casilla. Lo que dice **PENDIENTE** lo necesito antes de la Fase A.

### 1.1 Del proyecto NUEVO (Supabase → proyecto "Orbyx", ref `fqmdcbvtrgcnftlwcojc`)

- [ ] **Versión de Postgres.** Project Settings (engranaje abajo a la izquierda) → **Infrastructure** (o **General**) → versión de Postgres. Debe ser **17 o más**. → **PENDIENTE: ______**
  - También anota la versión del proyecto **viejo** (misma pantalla). → **PENDIENTE: ______** (el nuevo debe ser igual o mayor).
- [ ] **Tipo de llaves.** Project Settings → **API Keys**.
  - Si ves `sb_publishable_...` y `sb_secret_...` → llaves nuevas.
  - Si ves una pestaña **Legacy API keys** con `anon` y `service_role` (empiezan con `eyJ`) → llaves antiguas.
  - Anota cuáles hay y cuáles vas a usar. → **PENDIENTE: ______** (el script `01-preflight.sh` lo confirma).
- [ ] **Firma de los tokens.** Project Settings → **JWT Keys** (o JWT Settings). Anota si dice "JWT Signing Keys" con una clave activa tipo ECC/ES256 (rápido) o solo "Legacy JWT secret" (más lento, funciona igual). → **PENDIENTE: ______**
- [ ] **Plan del proyecto nuevo** (Free o Pro). Project Settings → **Billing**. → **PENDIENTE: ______** (decisión tuya; ver riesgo de pausa por inactividad en el plan).
- [ ] **Contraseña de la base de datos del nuevo.** Project Settings → **Database** → "Database password". Si no la recuerdas, "Reset database password" y guárdala en tu gestor. → **PENDIENTE**
- [ ] **URI del Session pooler del nuevo.** Botón **Connect** (arriba) → pestaña **Session pooler** → copia la URI (puerto 5432). Termina en `.pooler.supabase.com:5432/postgres`. → **PENDIENTE**
- [ ] **Llave secreta y llave pública del nuevo** (de la pantalla API Keys). → **PENDIENTE**

### 1.2 Del proyecto VIEJO

- [ ] **Contraseña y URI del Session pooler del viejo** (mismas pantallas que arriba, en el proyecto `vmxjqhndepvgoexajtfc`). → **PENDIENTE**
- [ ] **Llave `service_role` del viejo** (Project Settings → API Keys → Legacy API keys → `service_role` → Reveal). Es la que ya usan Render y Vercel hoy. → **PENDIENTE**
- [ ] **Configuración de Auth del viejo, para copiarla al nuevo** (abre el viejo en una pestaña y el nuevo en otra):
  - [ ] Lista de **Redirect URLs** (Authentication → URL Configuration). → **PENDIENTE: la lista**
  - [ ] Datos del **SMTP personalizado** (Authentication → Emails → SMTP Settings): host, puerto, usuario, remitente. **La contraseña SMTP no se ve: sácala de Resend o Zoho.** → **PENDIENTE**
  - [ ] **Plantillas de correo** (Authentication → Emails → Templates). → **PENDIENTE** (las copiamos asunto por asunto)
  - [ ] **Secret de Cloudflare Turnstile** (Cloudflare → Turnstile → tu widget → Secret key). → **PENDIENTE**
  - [ ] Valores de **Rate Limits** y reglas de contraseña (Authentication → Rate Limits; Sign In / Providers → Email). → **PENDIENTE**

### 1.3 De Render y Vercel (para poder volver atrás)

- [ ] **Guardar en tu gestor de contraseñas los valores ACTUALES** de estas variables, antes de tocar nada:
  - Render → servicio `orbyx-backend-virginia` → **Environment**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, y `SUPABASE_CAMPAIGN_IMAGES_BUCKET` si existe. (Usa el ojo para ver cada valor.)
  - Vercel → proyecto **orbyx-web** → Settings → **Environment Variables**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Production y Preview).
  - Vercel → proyecto **orbyx-dashboard**: las mismas tres.
- [ ] **ID del último deployment bueno** de cada proyecto de Vercel (Deployments → el de arriba con estado "Ready" y marcado "Production"). → **PENDIENTE: orbyx-web ______ · orbyx-dashboard ______**
- [ ] **Commit actual de `main`** del repo backend y de orbyx-web. → **PENDIENTE** (lo leo yo con `git log`)
- [ ] **Región de las funciones de Vercel**: en cada proyecto, Settings → **Functions** → "Function Region". Debe decir `iad1` (Washington D.C.). → **PENDIENTE: ______**
- [ ] **El proyecto `orbyx-dashboard`: qué dominio sirve.** → **PENDIENTE** (para saber qué probar en el humo)

### 1.4 Para las pruebas

- [ ] **Slug de un negocio de prueba** con al menos un servicio y un profesional. → **PENDIENTE: ______**
- [ ] **Correo y contraseña de una cuenta de prueba** del dashboard (la contraseña la escribes tú cuando el script la pida; yo no la veo). → **PENDIENTE: correo ______**
- [ ] **Tu cuenta admin** (para probar `/admin/login` con MFA) y tu app de autenticación a mano.
- [ ] **Cuándo** harás el corte: fecha y hora (evita las 04:30 de Chile, hora del respaldo diario). → **PENDIENTE: ______**

### 1.5 Herramientas en el computador donde corro los scripts

- [ ] **PostgreSQL 17 con "Command Line Tools"** (hoy **no está instalado** en este computador: `psql` y `pg_dump` no existen). CAMILO: descarga el instalador de PostgreSQL 17 para Windows (enterprisedb.com/downloads/postgres-postgresql-downloads), ejecútalo y **marca solo "Command Line Tools"** (puedes desmarcar el servidor y pgAdmin). Los scripts buscan automáticamente `C:\Program Files\PostgreSQL\17\bin`.
- [ ] Node.js (ya está: v24), `curl` y `gpg` (ya están, vienen con Git Bash).
- [ ] **Archivo de variables.** CLAUDE lo prepara así (una sola vez):
  ```bash
  cp migration/orbyx-migration.env.example ~/orbyx-migration.env
  notepad ~/orbyx-migration.env
  ```
  CAMILO: pega ahí las URIs, contraseñas y llaves de arriba, guarda y cierra. **Ese archivo queda fuera del repo** (está en tu carpeta de usuario). No me lo pegues en el chat; basta con que exista.

---

## 2. Mapa de scripts (carpeta `migration/`)

| Script | Qué hace | Toca |
|---|---|---|
| `00-inventory.sh` | Inventario (extensiones, triggers, políticas de Storage, cron, webhooks, Vault…) y archivos de apoyo | Viejo (lectura) |
| `01-preflight.sh` | Herramientas, **versión de Postgres**, extensiones, **tipo de llaves**, firma JWT, estado del nuevo | Ambos (lectura) |
| `02-dump-old.sh --mode full\|data` | Respaldo local. En `auth` solo `users`, `identities`, `mfa_factors` (**sin `schema_migrations`**) | Viejo (lectura) |
| `03-prepare-new.sh` | Crea extensiones y **quita los permisos por defecto de `anon`** antes de restaurar | Nuevo (escribe) |
| `04-restore-new.sh --mode full\|data` | Carga `auth` y luego `public` (modo `data` = todo o nada) | Nuevo (escribe) |
| `05-post-restore.sh` | **Realtime (incluye `reviews`)**, permisos por defecto del viejo, ANALYZE | Nuevo (escribe) |
| `06-copy-storage.js` | Crea los 5 buckets y copia los archivos; `--verify` compara | Viejo (lectura) / Nuevo (escribe) |
| `07-rewrite-urls.sh` | Cuenta y reescribe URLs con el ref viejo en **todas** las columnas de texto/JSON | Nuevo (escribe) |
| `08-compare-schema.sh` | Compara permisos, RLS, políticas, funciones, triggers, índices; **revisa que `anon` no vea nada** | Ambos (lectura) |
| `09-verify-data.sh` | Compara filas y md5 por tabla, usuarios, secuencias, buckets | Ambos (lectura) |
| `10-post-cutover-checks.sh` | Comprueba que orbyx.cl ya apunta al proyecto nuevo y que la API no devuelve URLs viejas | Web pública |
| `11-reset-new-data.sh` | Vacía los datos del nuevo (no el esquema) para repetir la carga | Nuevo (borra) |
| `12-test-password-grant.sh` | Prueba `verifyCurrentPassword` con la llave nueva (¿captcha?) | Nuevo |
| `13-close-no-rls-tables.sh --target old o new` | Verifica (y en el nuevo, con `--apply`, cierra) las 14 tablas sin RLS: RLS + REVOKE a `anon` y `authenticated` | Viejo (lectura) / Nuevo (escribe) |
| `14-check-anon-exposure.sh --target old o new` | Prueba desde afuera, con la llave pública, que las 14 tablas ya no responden | Solo lectura |
| `99-cleanup.sh` | Borra los respaldos locales sin cifrar | Solo tu carpeta local |

Cómo se resuelven los riesgos del plan:

| Riesgo | Dónde se resuelve |
|---|---|
| `auth.schema_migrations` en `auth-data.sql` | `02-dump-old.sh` vuelca solo 3 tablas y aborta si aparece `schema_migrations` |
| `REVOKE` a `anon` perdido por "Automatically expose new tables" | `03-prepare-new.sh` (antes) + `08-compare-schema.sh` (después, con criterio de aceptación explícito sobre las 9 tablas, `blocked_contacts`, `import_customers_batch`, `undo_customer_import`) |
| Versión de Postgres | `01-preflight.sh` falla si el nuevo es menor que el viejo o menor que 17 |
| Llaves `sb_` y `verifyCurrentPassword` | `01-preflight.sh` (tipo de llave) + `12-test-password-grant.sh` + "Plan B" abajo |
| Realtime sin `reviews` | `05-post-restore.sh` |
| URLs con el ref viejo | `07-rewrite-urls.sh` + `10-post-cutover-checks.sh` |

---

## 3. FASE A — Preparación y ensayo (1–2 días antes; sin tiempo caído)

Todo se corre desde la raíz del repo backend, en Git Bash: `bash migration/<script>`.

| # | CLAUDE ejecuta | CAMILO hace a mano |
|---|---|---|
| A1 | | Completa la sección 1 de este documento (todas las casillas) |
| A2 | | Instala PostgreSQL 17 "Command Line Tools" y crea `~/orbyx-migration.env` (sección 1.5) |
| A3 | `bash migration/01-preflight.sh` — debe terminar en "todo en orden". Si falla por versión de Postgres, **no seguir** (ver Riesgos) | |
| A4 | `bash migration/00-inventory.sh` — genera `~/orbyx-migration-out/inventory-old.txt` | |
| A5 | Reviso el inventario contigo. **Todo lo que aparezca en las secciones 4, 5, 7, 9b y 11 (triggers en `auth`/`storage`, funciones fuera de `public`, políticas de Storage, ajustes por rol, cron/webhooks/Vault) lo replicamos a mano antes del ensayo.** Esos casos no los automatiza ningún script | Pégame el contenido de `inventory-old.txt` o autoriza que lo lea |
| A6 | | Configura el proyecto **nuevo** en el panel (sección 4 de este documento) |
| A7 | `bash migration/02-dump-old.sh --mode full` (simulacro) y luego `bash migration/02-dump-old.sh --mode full --apply` | |
| A8 | `bash migration/03-prepare-new.sh` (simulacro) y luego `bash migration/03-prepare-new.sh --apply` (pide escribir `fqmdcbvtrgcnftlwcojc`) | Escribe el ref cuando el script lo pida |
| A9 | `bash migration/04-restore-new.sh --mode full --apply` | Escribe el ref cuando el script lo pida |
| A10 | `bash migration/05-post-restore.sh --apply` | Escribe el ref cuando el script lo pida |
| A10b | `bash migration/13-close-no-rls-tables.sh --target new --apply` (muestra ANTES, cierra las 14 tablas y muestra DESPUÉS: deben quedar 14 CERRADA) y luego `bash migration/14-check-anon-exposure.sh --target new` | Escribe el ref cuando el script lo pida |
| A11 | `node migration/06-copy-storage.js` (simulacro: lista archivos y peso) y luego `node migration/06-copy-storage.js --apply` | |
| A12 | `bash migration/07-rewrite-urls.sh --target old` (qué columnas tienen el ref viejo) y luego `bash migration/07-rewrite-urls.sh --target new --apply` | Escribe el ref cuando el script lo pida |
| A13 | `bash migration/08-compare-schema.sh` — **debe terminar en OK**. Si anon quedó con permisos de más, lo corrijo con los `REVOKE` que indique el diff y repito | |
| A14 | `bash migration/09-verify-data.sh` y `node migration/06-copy-storage.js --verify` — deben terminar en OK | |
| A15 | `bash migration/12-test-password-grant.sh <correo-de-la-cuenta-de-prueba>` | Escribe la contraseña de esa cuenta cuando el script la pida |
| A16 | Anoto los tiempos de cada paso para planear la hora del corte | Revisa en el panel del **nuevo**: Authentication → Users muestra los usuarios; Storage muestra los 5 buckets con archivos |

Criterio para pasar a la Fase B: A3, A13, A14 y A15 en OK, y A5 resuelto.
El ensayo deja datos en el proyecto nuevo; el día del corte se borran (`11-reset-new-data.sh`) y se cargan de nuevo solo los datos.

## 4. Configuración del panel del proyecto NUEVO (CAMILO, durante la Fase A)

Abre el viejo y el nuevo en dos pestañas y copia valor por valor. Los nombres del panel de Supabase cambian a veces; si una pantalla no se llama igual, busca la más parecida.

**Authentication** (barra izquierda del proyecto nuevo)
1. Authentication → **Sign In / Providers** → **Email**: iguala "Confirm email", "Secure email change", "Secure password change", "Minimum password length" y "Allow new users to sign up".
2. Mismo lugar: si el viejo tiene otros proveedores activos (Google, etc.), actívalos igual.
3. Authentication → **URL Configuration** → **Site URL**: `https://www.orbyx.cl`
4. Authentication → **URL Configuration** → **Redirect URLs**: agrega una por una las del viejo (la lista de la casilla 1.2).
5. Authentication → **Emails** → pestaña **SMTP Settings**: activa "Enable custom SMTP"; copia host, puerto, usuario, remitente (correo y nombre); escribe la contraseña SMTP.
6. Authentication → **Emails** → pestaña **Templates**: copia asunto y HTML de Confirm signup, Invite user, Magic link, Change email address, Reset password y Reauthentication.
7. Authentication → **Attack Protection**: activa Captcha, proveedor **Cloudflare Turnstile**, pega el **Secret key**.
8. Authentication → **Rate Limits**: iguala los valores del viejo.
9. Authentication → **Multi-Factor**: deja TOTP igual que el viejo.
10. Authentication → **Auth Hooks**: si el viejo tiene alguno, avísame (hay que recrear la función).

**Project Settings** (engranaje)
11. **Data API**: "Exposed schemas" igual que el viejo (normalmente `public, graphql_public`) y "Max rows" igual (el backend pagina de a 1.000).
12. **Database** → Extensions: lo que cree `03-prepare-new.sh` es suficiente; revisa que no falte ninguna del inventario.
13. **Realtime** → Settings (si existe): iguala valores del viejo.

**Storage** — no hace falta crear los buckets a mano: `06-copy-storage.js --apply` los crea con el mismo acceso (público/privado), tamaño máximo y tipos de archivo. Después revisa en Storage → Buckets que sean 5 y que `ticket-attachments` y `deposit-receipts` digan **Private**. **Decisión tomada:** NO se copian las políticas públicas de subir/borrar de `campaign-images` del viejo (Allow upload / Allow delete / Public read): el backend sube con la llave de servicio y el bucket es público para lectura, así que no hacen falta y dejaban abierta la subida y el borrado a cualquiera.

## 5. FASE B — Día del corte (tiempo caído esperado: 20–40 min)

Antes de empezar: Fase A completa, todas las casillas de la sección 1 con valor, y avisa que no se use el sistema durante ~1 hora.

| # | CLAUDE ejecuta | CAMILO hace a mano |
|---|---|---|
| B0 | `git log -1 --oneline` en ambos repos y confirmo que `main` es el commit anotado | Confirma que los valores actuales de Render y Vercel están guardados (1.3) |
| B1 | | **Suspender el backend.** Render → Dashboard → servicio `orbyx-backend-virginia` → **Settings** → baja hasta "Suspend Service" → confirma. Esto detiene las escrituras y los crons internos |
| B2 | `bash migration/02-dump-old.sh --mode data --apply` | |
| B3 | `bash migration/11-reset-new-data.sh --apply` (borra los datos del ensayo) | Escribe el ref `fqmdcbvtrgcnftlwcojc` cuando lo pida |
| B4 | `bash migration/04-restore-new.sh --mode data --apply` | Escribe el ref cuando lo pida |
| B5 | `bash migration/05-post-restore.sh --apply` | Escribe el ref cuando lo pida |
| B6 | `node migration/06-copy-storage.js --apply` y luego `node migration/06-copy-storage.js --verify` | |
| B7 | `bash migration/07-rewrite-urls.sh --target new --apply` | Escribe el ref cuando lo pida |
| B8 | `bash migration/08-compare-schema.sh` y `bash migration/09-verify-data.sh` — **ambos deben terminar en OK** | |
| B9 | **Punto de decisión 1:** si B8 falla y no se arregla en ~15 min → ir a "Vuelta atrás" (sección 7). El viejo no se ha tocado, así que basta reanudar Render | |
| B10 | `bash migration/12-test-password-grant.sh <cuenta-de-prueba>` | Escribe la contraseña cuando se pida |
| B11 | | **Cambiar variables en Render.** Render → servicio `orbyx-backend-virginia` → **Environment** → editar:<br>• `SUPABASE_URL` = `https://fqmdcbvtrgcnftlwcojc.supabase.co`<br>• `SUPABASE_SERVICE_ROLE_KEY` = la llave secreta del NUEVO<br>→ **Save Changes**.<br>Si Render no deja guardar con el servicio suspendido, primero reanuda (B12) y luego guarda (se reiniciará solo) |
| B12 | | **Reanudar el backend.** Render → mismo servicio → botón **Resume** (arriba a la derecha). Espera a que el estado sea **Live** |
| B13 | `curl -s https://api.orbyx.cl/health` debe responder `{"status":"ok"}`. Reviso los logs de Render por errores de Supabase al arrancar (los pegas tú si no tengo acceso) | Render → servicio → **Logs**: mira que no haya líneas con `ERROR` ni `Invalid API key` |
| B14 | | **Cambiar variables en Vercel, proyecto `orbyx-web`.** Vercel → proyecto **orbyx-web** → **Settings** → **Environment Variables**. Para cada una, ⋯ → **Edit** → pega el valor nuevo → **Save**, marcando **Production** y **Preview**:<br>• `NEXT_PUBLIC_SUPABASE_URL` = URL del nuevo<br>• `NEXT_PUBLIC_SUPABASE_ANON_KEY` = llave pública del NUEVO<br>• `SUPABASE_SERVICE_ROLE_KEY` = llave secreta del NUEVO |
| B15 | | **Lo mismo en el proyecto `orbyx-dashboard`** (las 3 variables) |
| B16 | | **Reconstruir los dos proyectos.** En cada uno: **Deployments** → el primero de la lista (Production) → ⋯ → **Redeploy** → **desmarca** "Use existing Build Cache" → **Redeploy**. Pueden construirse al mismo tiempo. Espera "Ready" en ambos |
| B17 | | **Actualizar el respaldo diario.** GitHub → repositorio **Orbyx-backend** → **Settings** → **Secrets and variables** → **Actions** → `SUPABASE_DB_URL` → lápiz (Update) → pega la URI **Session pooler del NUEVO** → **Update secret** |
| B18 | `bash migration/10-post-cutover-checks.sh <slug>` | |
| B19 | | **Punto de decisión 2:** si B18 falla en "ref VIEJO" → repite B16 sin cache. Si falla otra cosa y no se arregla en ~20 min → "Vuelta atrás" |
| B20 | Pruebas manuales (abajo) las voy guiando una por una | Haces los clics de cada prueba |
| B21 | | **Respaldo de prueba.** GitHub → **Actions** → "Respaldo diario de la base de datos" → **Run workflow**. Cuando termine verde, abre el resumen y compara `MANIFIESTO.txt` con el nuevo proyecto |
| B22 | | Si todo salió bien: **pausar el proyecto viejo.** Supabase → proyecto `vmxjqhndepvgoexajtfc` → Project Settings → **General** → **Pause project**. Déjalo pausado 1–2 semanas, sin borrarlo |

### Pruebas manuales (B20)

1. `https://www.orbyx.cl/login` con la cuenta de prueba → entra al dashboard → la Agenda carga.
2. Navegar entre Agenda, Clientes, Staff, Servicios: cada clic debe sentirse rápido (antes de ~2–5 s, ahora <1 s).
3. `https://www.orbyx.cl/admin/login` con tu cuenta admin + código MFA. Si el código no funciona → Plan C abajo.
4. Página pública `https://www.orbyx.cl/<slug>` → elegir servicio → profesional → ver horarios → **crear una reserva de prueba** (con el captcha). Debe llegar el correo y aparecer en la Agenda.
5. Con el dashboard abierto en otra pestaña, crear esa reserva: debe sonar/aparecer la notificación en vivo (prueba Realtime).
6. Dashboard → Mi negocio: subir un logo y un banner; Staff: subir una foto → se ven en la página pública (prueba Storage y URLs públicas).
7. Una reserva con depósito: subir un comprobante y verlo desde la Agenda (Storage privado, URL firmada).
8. Soporte: abrir un ticket **antiguo** con adjunto (la URL guardada trae el ref viejo; debe verse igual).
9. `https://www.orbyx.cl/signup` con un correo nuevo → llega el correo de confirmación (SMTP y captcha del proyecto nuevo) → confirmar → entrar.
10. "Olvidé mi contraseña" → llega por Resend → cambiar la contraseña → entrar.
11. Una prueba rápida de: WhatsApp de confirmación, Google Calendar y cambio de plan (no deberían verse afectados).
12. Logs de Render: buscar `[PERF]`. `tenantUsers` y `branchAccess` deben estar en decenas de milisegundos (antes, cientos). Esa es la medición real del beneficio.

## 6. FASE C — Después del corte

| # | CLAUDE | CAMILO |
|---|---|---|
| C1 | `bash migration/99-cleanup.sh --apply` cuando ya no se necesiten los respaldos locales (al menos 48 h después, por si hay que volver atrás) | Borra también `~/orbyx-migration.env` al final |
| C2 | Actualizo `docs/RESTORE.md` y `.github/workflows/db-backup.yml` (ver sección 9) | Aprueba esos cambios |
| C3 | Actualizo `CLAUDE.md` (nuevo ref, nueva región, nota de la migración) | |
| C4 | | A las 1–2 semanas: Supabase viejo → Project Settings → General → **Delete project**. Antes, rota/revoca las llaves del viejo si quedaron en algún lado |
| C5 | | Actualiza tu `.env` local (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) si usas los scripts locales; si no, apuntan al proyecto viejo pausado |

## 7. VUELTA ATRÁS

**Cuándo:** el login, la creación de reservas o el panel admin fallan y no se arreglan en el tiempo marcado en B9 / B19 (o en los primeros 30–60 min tras el corte).

**Qué se conserva:** el proyecto viejo no se modifica durante todo el proceso (solo se lee). Mientras no lo borres, sigue intacto.

**Qué se pierde:** todo lo que se haya guardado en el proyecto nuevo después del corte. Sin clientes reales, no importa. **Si ya hubiera clientes, avísame antes: se hace un volcado inverso solo de lo nuevo.**

| # | CAMILO hace a mano |
|---|---|
| R1 | Si el viejo ya estaba pausado: Supabase → proyecto `vmxjqhndepvgoexajtfc` → **Restore project** y espera a que diga "Healthy" (unos minutos). Si no, sigue activo |
| R2 | Render → servicio `orbyx-backend-virginia` → Environment → devuelve `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` a los valores **viejos** que guardaste en 1.3 → **Save Changes**. Si el servicio sigue suspendido, **Resume** |
| R3 | Vercel → **orbyx-web** → Deployments → el deployment bueno anotado en 1.3 → ⋯ → **Promote to Production** (esto devuelve la versión con la URL vieja ya incrustada, sin reconstruir) |
| R4 | Lo mismo en **orbyx-dashboard** |
| R5 | Si ya cambiaste variables en Vercel, devuélvelas también a los valores viejos (Settings → Environment Variables) para que el próximo build no use el proyecto nuevo |
| R6 | GitHub → Orbyx-backend → Settings → Secrets and variables → Actions → `SUPABASE_DB_URL` → devuelve la URI del **viejo** |
| R7 | Prueba: login, Agenda, reserva pública. Todos los usuarios tendrán que iniciar sesión de nuevo |

| # | CLAUDE |
|---|---|
| R8 | `curl -s https://api.orbyx.cl/health`, `bash migration/10-post-cutover-checks.sh <slug>` (debe mostrar el ref viejo otra vez) y reviso los logs que me pegues |

Después de volver atrás: no se borra nada del nuevo. Revisamos qué falló y repetimos el ensayo.

## 8. Plan B y Plan C

**Plan B — `verifyCurrentPassword` no funciona con la llave nueva** (`12-test-password-grant.sh` muestra "CAPTCHA" o un error de llave):
- Por qué importa: `server.js:25775` (`verifyCurrentPassword`) llama a `/auth/v1/token?grant_type=password` con la llave secreta como `apikey`. Hoy funciona aunque el captcha de Supabase esté activo, y **creo** que es porque el Auth trata la llave de servicio como administrador y se salta el captcha. Eso no está verificado: es justo lo que prueba el script con la llave nueva.
- Opciones, en este orden:
  1. Usar las **llaves "Legacy"** (`service_role` en formato `eyJ…`) del proyecto nuevo, si el panel las ofrece (Project Settings → API Keys → Legacy API keys). Cero cambio de código.
  2. Si solo hay llaves nuevas y falla: cambio de código en `server.js`. No cambiar a la llave pública sin pensar: con el captcha activo, esa llamada pediría un token de captcha y fallaría. Habría que diseñarlo (por ejemplo, desactivar temporalmente el captcha solo para esa verificación, o validar la contraseña de otra forma). **No lo preparé porque depende del resultado de la prueba.** Se decide en la Fase A (paso A15), no el día del corte.

**Plan C — el código TOTP de tu cuenta admin no funciona en el nuevo:** los factores MFA viajan en `auth.mfa_factors`, pero podrían no ser válidos si sus secretos dependían de una llave del proyecto viejo. Solución: yo borro el factor de tu usuario en el nuevo (`delete from auth.mfa_factors where user_id = '<tu id>'`, con tu OK) y vuelves a inscribirlo en `/admin/login` (tu fila de `admin_users` se conserva).

## 9. Cambios posteriores a la migración (no se hacen antes; requieren tu OK)

1. `.github/workflows/db-backup.yml`: agregar `--exclude-table-data='auth.schema_migrations'` en el dump de `auth` (hoy solo excluye 7 tablas transitorias). Es lo que ya resuelve `02-dump-old.sh` para la migración, pero el respaldo diario seguiría incluyéndola.
2. `docs/RESTORE.md`, paso 5.1: la línea `alter publication supabase_realtime add table …` debe incluir también `public.reviews`.
3. `docs/RESTORE.md`: apuntar a `migration/` como forma recomendada de restaurar, y recordar que los buckets se crean y rellenan con `06-copy-storage.js`.
4. `CLAUDE.md`: nuevo ref de Supabase, región, y la lección "los `REVOKE` a `anon` no viajan en el dump con 'Automatically expose new tables' activo".
5. Opcional: usar `06-copy-storage.js` como base de un respaldo periódico de Storage (hoy no hay).

## 10. Riesgos que quedan (resumen)

| Riesgo | Cómo se mitiga |
|---|---|
| Postgres del nuevo < 17 o < viejo | `01-preflight.sh` lo detecta antes de escribir nada. Si pasa, crear otro proyecto con versión mayor |
| `anon` con permisos de más tras restaurar | `03-prepare-new.sh` antes + `08-compare-schema.sh` después. **No reabrir el tráfico sin su "OK"** |
| URLs de imágenes con el ref viejo | `07-rewrite-urls.sh` + `10-post-cutover-checks.sh` |
| Vercel con variables viejas incrustadas | Redeploy sin cache en ambos proyectos; `10-post-cutover-checks.sh` revisa el JS publicado |
| Dos backends vivos a la vez (crons y cobros duplicados) | Solo un servicio activo; Render suspendido durante el corte |
| Auth del nuevo sin SMTP/Turnstile/redirects iguales | Sección 4; pruebas 9 y 10 |
| MFA admin | Plan C |
| SQL de los scripts nunca corrió contra Postgres real | El ensayo de la Fase A es la primera ejecución; cualquier error aparece ahí, no el día del corte |

## 11. PENDIENTES consolidados (datos que no tengo)

1. Versión de Postgres de ambos proyectos.
2. Tipo de llaves del proyecto nuevo (nuevas `sb_` o legacy) y cuál se usará.
3. Si el nuevo usa JWT Signing Keys asimétricas.
4. Plan (Free/Pro) del proyecto nuevo.
5. Contraseñas de base de datos y URIs de Session pooler (viejo y nuevo); llaves secretas/públicas.
6. Resultado del inventario del viejo (`inventory-old.txt`): extensiones, triggers en `auth`/`storage`, políticas de Storage, cron, webhooks, Vault, ajustes por rol.
7. Redirect URLs, datos y contraseña SMTP, plantillas de correo, secret de Turnstile, rate limits del Auth del viejo.
8. IDs del último deployment bueno de `orbyx-web` y `orbyx-dashboard`; región de funciones de Vercel; qué dominio sirve `orbyx-dashboard`.
9. Slug y servicio de un negocio de prueba; correo de la cuenta de prueba.
10. Fecha y hora del corte.
11. Si Render permite editar variables con el servicio suspendido (si no, se hace tras reanudar; no cambia el orden lógico).
12. Si el viejo tiene ajustes de "Data API → Max rows" distintos de 1.000.
