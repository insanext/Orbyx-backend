# Orbyx — Medición de latencia y plan de migración de Supabase a Virginia

Fecha del análisis: 2026-10-23. Solo diagnóstico: no se modificó código, no se tocó ninguna base de datos (ni la vieja ni la nueva), no hay commits.

Proyecto viejo: `vmxjqhndepvgoexajtfc` (São Paulo). Proyecto nuevo (vacío): `fqmdcbvtrgcnftlwcojc` (us-east-1).

---

## 0. Lo primero que debes saber

**Veredicto: la migración vale la pena y no encontré nada que la desaconseje.** Con una condición de fondo: **hacerla ANTES de que llegue el primer cliente.** Sin clientes, el corte es barato y volver atrás no pierde datos. Con clientes, volver atrás pierde lo que se haya guardado en el proyecto nuevo.

Hallazgos que cambian cómo hay que hacerla (ordenados por importancia):

1. **Una consulta a Supabase no costará 1–2 ms, costará unos 10–30 ms.** El backend no habla directo con Postgres: usa la API REST de Supabase (`supabase-js`), que pasa por un gateway antes de llegar a la base. Hoy medí que **una sola consulta cuesta ~0,44 s** (mediana). En Virginia esperaría ~0,02 s. Es una mejora de unas 20 veces, pero no de 100 veces.

2. **El respaldo actual NO alcanza para migrar tal cual.** Hay seis cosas que `public.sql` + `auth-data.sql` no traen o traen mal (detalle en la sección 6):
   - **Permisos de `anon` (riesgo de seguridad).** `pg_dump` no escribe un `REVOKE` explícito para `anon`. El proyecto nuevo tiene "Automatically expose new tables" activado, así que al restaurar las tablas nacen con permisos para `anon`. El `REVOKE` del 2026-09-30 podría quedar deshecho, incluso en funciones como `import_customers_batch`. Esto se arregla con un paso previo (sección 6.2) y se verifica comparando permisos entre los dos proyectos.
   - **`auth-data.sql` incluye `auth.schema_migrations`.** El workflow no la excluye. Podría chocar con las migraciones internas del Auth del proyecto nuevo. Hay que excluirla o volcar solo `users`, `identities` y `mfa_factors`.
   - **La tabla `reviews` está en la publicación de Realtime** (migración `2026-09-13-review-replies-and-reactions.sql`), pero `docs/RESTORE.md` solo agrega `appointments` y `tenant_monthly_usage`.
   - **Las URLs públicas de Storage guardadas en la base llevan el ref viejo.** Hay que reescribirlas (sección 7).
   - **No viajan** la configuración de los buckets, sus políticas, los archivos, las extensiones, los triggers sobre `auth`/`storage`, los ajustes de rol, los webhooks de base de datos ni los secretos de Vault. No sé si existen; el script de inventario (anexo B) lo dice en 2 minutos.
   - **Versión de Postgres:** el dump lo hace `pg_dump` 17. El proyecto nuevo debe ser Postgres 17 o superior; si fuera menor, el restore falla.

3. **Las claves de API del proyecto nuevo probablemente son del sistema nuevo** (`sb_publishable_…` / `sb_secret_…`) y no las `anon`/`service_role` en formato JWT que usa el viejo (el bundle público de orbyx.cl contiene una `anon` JWT HS256 firmada con el secreto antiguo). `supabase-js ^2.98` y `@supabase/ssr ^0.10.3` las aceptan, pero hay **un punto a probar**: `verifyCurrentPassword` (`server.js:25775`) manda la service key como header `apikey` a `/auth/v1/token`. Si el proyecto nuevo solo entrega `sb_secret_…`, conviene que use la publishable key. Es un cambio de una línea y se decide en la sesión de ejecución.

4. **Hay una ganancia extra:** el middleware de Next (`middleware.ts`) y `dashboard-access.ts` llaman `getClaims()`. Según CLAUDE.md, con el secreto HS256 antiguo cae a `getUser()` por red. Si el proyecto nuevo usa JWT Signing Keys asimétricas (lo normal en proyectos nuevos), la verificación es local y se ahorran 1–2 llamadas de red por navegación del dashboard. **A verificar** en Project Settings → JWT Keys del proyecto nuevo.

5. **No existe "modo mantenimiento"** en el código (busqué en `server.js` y `orbyx-web`; solo hay `SIGNUP_MAINTENANCE_SECRET`, que es otra cosa). Como aún no hay clientes, no hace falta construirlo: basta suspender el servicio de Render durante el corte (sección 9).

6. **Plan Free en producción.** El proyecto nuevo también es Free (500 MB de base, 1 GB de Storage, sin respaldos propios, pausa tras 7 días sin actividad). Que sea Free no impide migrar, pero con el primer cliente real conviene pasar a Pro. No cambia la latencia por región, pero evita la pausa por inactividad y da respaldos. Es una decisión tuya, fuera de este plan.

---

## Parte 1 — Medición

### 1.1 Cuántas consultas a Supabase hace cada acción

Conté los `await supabase…` del camino de ejecución leyendo `server.js` con grep dirigido. Todos los números son **aproximados**: varían con los datos (cuántos profesionales, cuántas páginas de 1.000 filas) y con helpers que hacen 1 o 2 consultas según el caso.

"Secuenciales" son consultas que esperan a la anterior. **En ninguno de los siete flujos hay `Promise.all`** entre consultas de la ruta crítica; la única excepción es el par email/teléfono de la reserva (2 consultas en paralelo). Cada ida y vuelta se paga completa.

| Acción | Ruta (backend) | Consultas | Secuenciales | Notas |
|---|---|---|---|---|
| Cargar página pública `/[slug]` | Next `/api/public-services` → `GET /public/services/:slug` (+ `/public/reviews/:slug` en paralelo) | ~14 | **~12** | tenants, subscriptions, branch ×3, service_groups, horarios ×3, calendars, services, staff_services. Reseñas: ~2 más, en paralelo |
| Elegir servicio → staff | `GET /public/staff/:slug/:service_id` | 6 | **6** | tenants, branch ×2, services, staff_services, staff |
| Horarios disponibles (1 profesional) | `GET /public/slots/:slug/:service_id` | ~17 | **~17** | 8 previas + ~8 **por profesional** (en un `for` secuencial) + 1 de capacidad |
| Horarios disponibles (3 profesionales) | ídem | ~33 | **~33** | cada profesional extra suma ~8 consultas secuenciales |
| Crear reserva pública | `POST /appointments/slot` | **~45–50** | **~45–50** | calendars, branch, tenants, estado de plan, antiabuso (4), servicio, duplicados, disponibilidad (~9), cliente (~4), traslape, insert, mascota, recálculo (3), sync de calendario (~4), emails y WhatsApp (~6). Además llamadas externas a Google, Resend y Twilio, que no cambian |
| Agenda semanal | `GET /appointments/by-range/:slug` | ~7 | **~7** | auth: tenants-por-slug + tenant_users + branch_access (3 secuenciales) + appointments, services, staff, reviews |
| Clientes | `GET /customers/:slug` | ~9–11 | **~9–11** | auth (3) + tenant + clientes (1 por cada 1.000) + categorías (citas, por bloques) + reseñas + opt-out. Crece con los datos |
| Indicadores | `GET /stats/:slug` | ~27–30 | **~27–30** | auth (3) + tenant, branches, appointments, conteos de customers, categorías, addons, `checkMonthlyUsage` ×3 (2 consultas c/u), pets, followups, campaign_history, delivery logs. Todo secuencial |

Costo fijo de cada request autenticado del dashboard: **3 consultas** (`enforceSlugOwnership` + `resolveTenantMembership`) más una llamada a Supabase Auth (`getUser`) cuando el caché de 30 s no la tiene. Cada carga de página dispara 11–14 requests en paralelo; cada una paga sus 3 consultas.

Archivos y líneas: `server.js` 2131 (`requireTenantAuth`), 2152 (`resolveTenantMembership`), 2348 (`enforceSlugOwnership`), 3004 (`getEffectiveBusinessAvailability`), 3173 (`getEffectiveStaffAvailability`), 7195 (`POST /appointments/slot`), 8302 (`by-range`), 8819 (`/stats`), 9892 (`/customers`), 20678 (`/public/services`), 21014 (`/public/staff`), 21127 (`/public/slots`).

También hay **3 consultas desde Vercel en cada navegación del dashboard**: `lib/dashboard-access.ts` (`template.tsx`) lee `tenants`, `tenant_users` y `subscriptions` en secuencia. Ese código corre en el servidor de Vercel (iad1, Virginia) y consulta Supabase directo. Hoy cruza a São Paulo.

### 1.2 Latencia medida (desde este computador, Chile, 2026-10-23)

Medí con `curl -w`, 6–8 repeticiones, solo lecturas (sin claves privadas; usé la clave `anon` pública que ya viaja en el JavaScript de orbyx.cl).

| Qué | ttfb (tiempo hasta el primer byte) |
|---|---|
| `api.orbyx.cl/health` (sin base de datos) | **0,19–0,22 s** (estable; la primera vez 0,62 s por conexión fría) |
| `api.orbyx.cl/public/business/<slug inexistente>` (**exactamente 1 consulta**) | **0,42–0,83 s**, mediana 0,64 s |
| `api.orbyx.cl/public/services/<slug inexistente>` (1 consulta) | 0,38–0,71 s |
| Supabase viejo, `auth/v1/settings`, desde Chile | 0,12–0,24 s (mediana ~0,14) |
| Supabase viejo, `rest/v1/tenants?limit=1` (llega a la base), desde Chile | 0,14–0,39 s |

**Costo medido de una consulta backend→Supabase hoy:** restando el `/health` de cada par, el sobrecosto de una sola consulta fue 0,21 / 0,38 / 0,40 / 0,44 / 0,44 / 0,46 / 0,50 / 0,65 s → **mediana ≈ 0,44 s**. Es más de lo que da la ida y vuelta pura Virginia↔São Paulo (~0,12 s) porque también se suma el gateway de Supabase, PostgREST y el plan Free. Parte de ese tiempo podría no ser de red; por eso doy un rango abajo.

**Límites de esta medición (importante):**
- No tengo un slug real de tu base, así que no pude medir `/public/services/<slug>` real, ni slots, ni reserva. Los extrapolo con el costo por consulta.
- Un `curl` a la API de Supabase desde Chile **no mide Render→Supabase**; mide Chile→Supabase. Un `GET` sin clave a ambos proyectos (viejo y nuevo) responde en ~60 ms: lo contesta el borde de Cloudflare sin llegar a la región. **No sirve para comparar regiones.**
- La medición buena y gratis ya existe: tu backend registra `[PERF]` en cada request del dashboard, con milisegundos de `getUser`, `tenantUsers`, `branchAccess` y `slugTenantLookup` (`server.js:1941-1945`). Son consultas reales Render→Supabase. Mira los logs de Render (Logs → buscar `[PERF]`) **antes y después** de migrar. El comentario del código, del 2026-09-07, ya cita `getUser` en ~200–250 ms con picos de 600 ms.

**Script para que lo corras tú** (PowerShell, solo lectura; pégame el resultado). Si tienes un slug real, pásalo. Guárdalo como `medir-latencia.ps1`:

```powershell
param([string]$Slug = "", [string]$ServiceId = "", [string]$AnonKey = "", [string]$SupabaseUrl = "https://vmxjqhndepvgoexajtfc.supabase.co")
$fmt = "ttfb=%{time_starttransfer}s total=%{time_total}s http=%{http_code}\n"
function Medir($titulo, $url, $headers = @()) {
  Write-Host "`n== $titulo"
  1..8 | ForEach-Object {
    $a = @("-s","-o","NUL","-w",$fmt) + $headers + @($url)
    & curl.exe @a
  }
}
Medir "Backend /health (sin base de datos)" "https://api.orbyx.cl/health"
Medir "Backend, slug inexistente (1 consulta)" "https://api.orbyx.cl/public/business/zz-no-existe"
if ($Slug) {
  Medir "Backend /public/business/$Slug"  "https://api.orbyx.cl/public/business/$Slug"
  Medir "Backend /public/services/$Slug"  "https://api.orbyx.cl/public/services/$Slug"
  if ($ServiceId) {
    Medir "Backend /public/staff/$Slug/$ServiceId" "https://api.orbyx.cl/public/staff/$Slug/$ServiceId"
    $fecha = (Get-Date).AddDays(2).ToString("yyyy-MM-dd")
    Medir "Backend /public/slots (fecha $fecha)" "https://api.orbyx.cl/public/slots/$Slug/${ServiceId}?date=$fecha"
  }
}
if ($AnonKey) {
  Medir "Supabase auth/v1/settings" "$SupabaseUrl/auth/v1/settings" @("-H","apikey: $AnonKey")
  Medir "Supabase rest (tenants)"   "$SupabaseUrl/rest/v1/tenants?select=id&limit=1" @("-H","apikey: $AnonKey","-H","Authorization: Bearer $AnonKey")
}
```

Uso: `.\medir-latencia.ps1 -Slug mi-negocio -ServiceId <uuid-de-un-servicio>`. (La `anon key` es pública; está en el JS de orbyx.cl, pestaña Network de las herramientas de desarrollo.) El parámetro del endpoint de slots (`date`) debe coincidir con lo que espera `/public/slots`; si responde 400, mírame el mensaje y lo ajusto.

### 1.3 Tiempo estimado: hoy vs todo en Virginia

Fórmula: tiempo ≈ 0,25 s fijos (Chile↔Render + salto de Next) + consultas secuenciales × costo por consulta.
- **Hoy:** costo por consulta entre 0,15 s (teórico) y 0,44 s (medido).
- **Virginia:** 0,02 s (rango 0,01–0,03; incluye el gateway de la API).

| Acción | Consultas seq. | Hoy (estimado) | Virginia (estimado) |
|---|---|---|---|
| Página pública `/[slug]` | ~12 | 2,0 – 5,5 s | **~0,5 s** |
| Staff de un servicio | 6 | 1,2 – 2,9 s | ~0,4 s |
| Horarios (1 profesional) | ~17 | 2,8 – 7,7 s | ~0,6 s |
| Horarios (3 profesionales) | ~33 | 5,2 – 14,8 s | ~0,9 s |
| Crear reserva pública | ~48 | 7,5 – 21 s | ~1,2 s + externos (Google/Resend/Twilio ~1–2 s) ≈ **2–3,5 s** |
| Agenda semanal | ~7 | 1,3 – 3,3 s | ~0,4 s |
| Clientes | ~10 | 1,8 – 4,7 s | ~0,45 s |
| Indicadores | ~28 | 4,5 – 12,6 s | ~0,8 s |

Son estimaciones. El extremo alto extrapola una sola medición, pero coincide con lo que reportaste el 2026-09-06 ("~5 s" en Agenda, Staff, Servicios, Sucursales y Negocio). La reserva pública es el caso más grave: ~48 consultas secuenciales significan que hoy un cliente podría esperar muchos segundos al confirmar. Migrar la lleva a un orden razonable, y reducir consultas (ver 1.6) la bajaría más.

### 1.4 Llamadas del navegador directo a Supabase

Estas hoy van Chile→São Paulo y pasarán a Chile→Virginia. Estimo Chile→SP ≈ 75–100 ms de ida y vuelta (medido: `auth/v1/settings` 0,12–0,24 s con establecimiento de conexión) y Chile→Virginia ≈ 140–150 ms (el `/health` de Render, que está en Virginia, da ttfb 0,19–0,22 s). Cada llamada directa pierde ~50–80 ms.

| Dónde | Llamadas | Efecto |
|---|---|---|
| `/login` (`login/page.tsx`) | `signInWithPassword`, `getUser`, lectura de `tenant_users` y `tenants` (~4–5 en secuencia) | **+0,25–0,4 s** al iniciar sesión |
| Dashboard `layout.tsx` | `getUser` al cargar (1) + canal Realtime (WebSocket a `appointments`) | +~0,07 s una vez; Realtime +~0,07 s por evento (irrelevante) |
| `AccountStatusWidget` | canal Realtime de `tenant_monthly_usage` (solo al abrir el menú) | Irrelevante |
| `configuracion`, `soporte`, `invite`, `completar-registro`, `actualizar-password`, `signup`, `admin/*` | `getUser`/`signIn`/`updateUser`/`verifyOtp` puntuales | +0,05–0,08 s por llamada; no se nota |
| `apiFetch` (`lib/api.ts`) | `getSession()` en cada request al backend | Lee el almacenamiento local: **sin red** (salvo refresco de token) |
| Página pública `/[slug]` | **Ninguna.** Todo va por `/api/public-*` → backend | Sin cambio en el navegador; mejora por el lado del servidor |

**Lo que sí mejora mucho y no es del navegador:** `template.tsx` + `dashboard-access.ts` corren en Vercel (iad1) y hacen 3 consultas secuenciales en **cada navegación del dashboard** (más el `getClaims` del middleware). Hoy 3 × 0,15–0,44 s ≈ **0,45–1,3 s** extra en cada clic. Con Virginia↔Virginia queda en ~0,06 s.

**Neto:** el inicio de sesión pierde unos 0,3 s; todas las demás pantallas ganan segundos. Los cálculos de pantalla no cambian por Chile↔Virginia (~0,15 s por request), que es lo mínimo hasta mover el backend, y que ya aceptaste.

### 1.5 Conclusión en una línea

**Sí vale la pena:** pasar de ~0,15–0,44 s a ~0,02 s por consulta reduce la reserva pública de 8–20 s a 2–3 s y las pantallas del dashboard de 2–5 s a menos de 1 s; el costo es medio día de preparación y menos de una hora caída, sin clientes en producción.

### 1.6 Extra (fuera del alcance de esta migración, pero conviene anotarlo)

Aun en Virginia, la reserva pública hace ~48 consultas seguidas. La migración la deja bien; si más adelante quieres bajarla a ~1 s, hay que paralelizar con `Promise.all` o juntar consultas. Eso es cambiar código de disponibilidad y reserva (alto riesgo según CLAUDE.md). No lo propongo ahora.

---

## Parte 2 — Plan de migración (NO ejecutar todavía)

Leyenda: **[CLAUDE]** lo hago yo en una sesión posterior (scripts/comandos). **[CAMILO]** lo haces tú con clics, un paso por línea.

### 2. Qué sirve del respaldo actual y qué falta

El workflow `db-backup.yml` y `docs/RESTORE.md` están bien armados y ya probaste una restauración. **Sirve tal cual:** `pg_dump` 17 por Session pooler, dump de `public` con esquema y datos, dump de `auth` solo datos, cifrado con gpg, restauración con `session_replication_role=replica` (no dispara triggers ni valida llaves foráneas durante la carga), orden `auth` → `public`.

**Hay que ajustar para migrar:**

| # | Tema | Qué pasa | Qué hacer |
|---|---|---|---|
| a | Permisos `anon`/`authenticated`/`service_role` | `pg_dump` escribe los `GRANT` pero no un `REVOKE` explícito por rol. En el proyecto nuevo, las tablas y funciones nacen con los permisos por defecto de Supabase (`anon` incluido). Resultado probable: el `REVOKE` del 2026-09-30 sobre 9 tablas y el de `import_customers_batch`/`undo_customer_import` (solo `service_role`) no se reproduce | Antes de restaurar, quitar los `DEFAULT PRIVILEGES` del esquema `public` para esos roles (anexo C). Después comparar permisos entre ambos proyectos (anexo C). Re-aplicar a mano lo que falte |
| b | `auth.schema_migrations` | `auth-data.sql` la incluye (el workflow solo excluye 7 tablas transitorias) | Para migrar, volcar solo `auth.users`, `auth.identities`, `auth.mfa_factors` (y `auth.instances` si tiene filas) con `--table` + `--data-only` |
| c | Realtime | Solo se listan 2 tablas en RESTORE.md, pero `reviews` también está en la publicación | Agregar las 3. La lista exacta se saca del inventario (anexo B, consulta 3) |
| d | Storage | Ni archivos ni configuración de buckets viajan | Sección 3 |
| e | Extensiones, triggers sobre `auth`/`storage`, `pg_cron`, webhooks, Vault, `ALTER ROLE … SET` | No sé si existen. `pg_dump --schema=public` no los incluye | Inventario (anexo B). Lo que aparezca se replica con SQL |
| f | Versión de Postgres | `pg_dump` 17 genera SQL que un servidor menor a 17 rechaza | Confirmar que el proyecto nuevo es ≥ 17: Project Settings → Infrastructure (o `select version();`) |
| g | Secuencias | `pg_dump` ya incluye `setval` | Nada que hacer; verificar en la comparación |
| h | MFA | `mfa_factors` viaja; si los secretos TOTP estuvieran cifrados con una llave del proyecto viejo, no funcionarían | Riesgo bajo: solo tu cuenta de admin usa MFA. Plan B: borrar el factor con SQL y volver a inscribirlo (el `admin_users.user_id` se conserva, así que el acceso al panel admin sigue) |

#### 2.1 Qué hago yo ([CLAUDE], sesión de ejecución)

Scripts nuevos en `scripts/migration/` (no existen hoy; los creo entonces):
1. `00-inventory.sql` — anexo B, solo lectura, corre en el proyecto viejo.
2. `01-dump-old.sh` — dump del viejo: `public` esquema+datos; `auth` solo `users/identities/mfa_factors`; cifrado y limpieza como en el workflow.
3. `02-prepare-new.sql` — quita los permisos por defecto de `public` (anexo C), crea lo que el inventario muestre (extensiones, etc.).
4. `03-restore-new.sh` — carga `auth` y luego `public` con `PGOPTIONS='-c session_replication_role=replica'`.
5. `04-copy-storage.js` — copia los 5 buckets (sección 3).
6. `05-rewrite-urls.sql` — reescribe URLs (sección 7).
7. `06-verify.sql` / `06-verify.js` — compara conteos por tabla, `max(id)`/`count`, RLS activo, políticas, permisos, publicaciones, buckets y objetos entre viejo y nuevo.
8. `07-reset-new-data.sql` — vacía los datos del proyecto nuevo (TRUNCATE de tablas `public` y de `auth.users` en cascada, sin tocar esquema) para repetir la carga el día del corte.

**Estrategia de ensayo (recomendada):** restaurar completo en el proyecto nuevo (esquema + datos) una vez para validar, comprobar, y el día del corte usar `07-reset` y una carga **solo de datos** (`--data-only`). Así el esquema, los permisos y las políticas se prueban una vez y el corte es solo mover datos. Requiere tu OK para escribir en el proyecto nuevo (en esta sesión no lo hice).

### 3. Storage

Buckets conocidos (del código): `business-logos` (público; también guarda banners), `staff-photos` (público), `campaign-images` (público, configurable con `SUPABASE_CAMPAIGN_IMAGES_BUCKET`), `ticket-attachments` (privado), `deposit-receipts` (privado).

**Configuración que no viaja:** si el bucket es público, el tope de tamaño de archivo (`file_size_limit`), los tipos MIME permitidos y las políticas de `storage.objects`. Se lee en el viejo con la consulta 6–7 del anexo B y se replica en el nuevo.

**Herramienta para copiar los archivos:** un script Node (`04-copy-storage.js`) con `@supabase/supabase-js`, que ya está en el repo. Es el método más simple porque no instala nada nuevo. Para cada bucket lista objetos recursivamente (con paginación de 1.000), descarga del viejo con la service role y sube al nuevo **con la misma ruta y el mismo `contentType`**, de forma idempotente (omite si ya existe con el mismo tamaño), así sirve para un ensayo previo y una pasada final. Alternativa: `rclone` contra el endpoint S3 de Supabase de cada proyecto (necesita crear las llaves S3 en cada proyecto). Elijo Node porque son pocos archivos pequeños (el pipeline de compresión los deja en WebP/JPEG livianos).

Detalles a cuidar:
- Las rutas en la base (`file_path`, `deposit_receipt_path`) **no cambian**, porque se copia con la misma ruta.
- Nunca se copian filas de `storage.objects` a mano: siempre por la API.
- Tamaño estimado: lo da la consulta 8 del anexo B (`storage.objects` agrupado por bucket).
- **Esto aprovecha para cerrar un hueco:** CLAUDE.md dice que Storage no tiene respaldo. El mismo script, corrido de forma periódica hacia un bucket o carpeta aparte, sería el respaldo de archivos. Queda como mejora aparte.

### 4. Lo que NO viaja en el dump y debes replicar a mano ([CAMILO])

Las rutas de abajo son aproximadas: el panel de Supabase cambia de nombre y orden seguido. En cada pantalla, abre el proyecto **viejo** en una pestaña y el **nuevo** en otra, y copia lo que veas.

**Atajo opcional:** con un token personal de Supabase (Account → Access Tokens) yo puedo leer la configuración de Auth del proyecto viejo por la Management API (`GET /v1/projects/{ref}/config/auth`), mostrarte la diferencia y aplicarla en el nuevo. Elimina casi todos los pasos de Auth de abajo. Quedan a tu mano las contraseñas (SMTP, secret de Turnstile), que la API no devuelve. Es una credencial sensible: crea el token, úsalo en la sesión y bórralo al terminar. Tú decides.

**Orden recomendado: haz todo esto ANTES del día del corte** (no depende de los datos).

#### 4.1 Authentication

Proyecto nuevo → barra izquierda → **Authentication**:

1. **Sign In / Up** (puede llamarse "Providers" o "Sign In / Providers"): abre "Email". Iguala: Confirm email, Secure email change, Secure password change, Minimum password length, Allow new users to sign up. Anota también si hay otros proveedores activados en el viejo (Google, etc.) e iguálalos.
2. **URL Configuration**: Site URL = `https://www.orbyx.cl`. En Redirect URLs, copia una por una las que tiene el proyecto viejo. Incluye las de `/login`, `/actualizar-password`, `/completar-registro`, `/invite/*` y las de Vercel de preview, si las hay.
3. **Emails** → pestaña **SMTP Settings**: activa "Enable custom SMTP" y copia host, puerto, usuario, remitente (correo y nombre). **La contraseña SMTP la escribes tú de nuevo** (no se ve en el viejo; sácala de Resend o Zoho).
4. **Emails** → pestaña **Templates**: copia el asunto y el HTML de cada plantilla (Confirm signup, Invite user, Magic link, Change email address, Reset password, Reauthentication). Las de contraseña olvidada ya no se usan (van por Resend), pero iguala igualmente.
5. **Attack Protection** (o "Protection"): activa Captcha, proveedor **Cloudflare Turnstile**, pega el **Secret key** del widget (Cloudflare dashboard → Turnstile → tu widget). Iguala también la protección de contraseñas filtradas, si el viejo la tiene.
6. **Rate Limits**: copia los valores del viejo (emails por hora, sign-ups/sign-ins por 5 min, etc.).
7. **Multi-Factor**: igual que el viejo (TOTP enabled; si el viejo permite "Enroll", igual).
8. **Sessions** (si aparece): copia time-box e inactividad (algunas opciones son de pago).
9. **Auth Hooks** (si aparece): anota si el viejo tiene alguno. Si lo tiene, hay que recrear la función en `public` y apuntarlo.

#### 4.2 Project Settings (engranaje, abajo a la izquierda)

1. **API Keys**: copia la URL del proyecto, la **publishable/anon key** y la **secret/service_role key**. Si hay una pestaña "Legacy API keys", dime cuál usar. Estas claves van a Render y Vercel en la sección 5.
2. **JWT Keys** (o "JWT Settings"): anota si el nuevo usa "JWT Signing Keys" (asimétricas). Es lo que acelera el middleware.
3. **Data API**: Exposed schemas (en el viejo, tal cual; normalmente `public, graphql_public`), Max rows (si el viejo tiene un valor distinto de 1.000, iguálalo: el backend pagina de a 1.000), Extra search path.
4. **Database**: copia la contraseña de la base nueva (o restablécela y guárdala en tu gestor). Copia la URI de **Session pooler** (Connect → Session pooler) para el secret `SUPABASE_DB_URL` de GitHub.
5. **Infrastructure / General**: confirma la versión de Postgres (≥ 17) y anótala junto con la del viejo.

#### 4.3 Realtime y base de datos

1. **Database → Publications** (puede llamarse "Replication"): en `supabase_realtime`, activa `appointments`, `tenant_monthly_usage` y `reviews` (o las que liste el inventario). Si prefieres SQL, lo hago yo: `alter publication supabase_realtime add table …`.
2. **Realtime → Settings**: iguala "Allow public access" y "Max concurrent clients", si el viejo los cambió.
3. **Database → Extensions**: activa las mismas extensiones que el viejo (lista en el inventario, consulta 2). Lo normal es que `pgcrypto` ya esté.
4. **Database → Webhooks** y **Integrations → Cron**: si el viejo tiene alguno, recréalo (probablemente no hay; el backend usa `node-cron`).
5. **Project Settings → Vault**: si el viejo tiene secretos, hay que recrearlos.
6. **Edge Functions**: si el viejo tiene, hay que desplegarlas (lo más probable es que no).

#### 4.4 Storage

**Storage → Files / Buckets** → "New bucket", uno por cada uno de los 5, con el mismo nombre exacto y la misma configuración (el inventario te da `public`, tamaño máximo y tipos permitidos de cada uno):

- `business-logos`: **Public ON**.
- `staff-photos`: **Public ON**.
- `campaign-images`: **Public ON**.
- `ticket-attachments`: **Public OFF**.
- `deposit-receipts`: **Public OFF**.

Después, **Storage → Policies**: copia las políticas del viejo, si el inventario muestra alguna (lo habitual es que no haya, porque el backend sube con service role). **Storage → Settings**: iguala el tope global de tamaño.

### 5. Referencias al proyecto viejo y variables a cambiar

#### 5.1 Referencias dentro del código

Busqué `vmxjqhndepvgoexajtfc`, `fqmdcbvtrgcnftlwcojc` y `supabase.co` en todo el repo (sin `node_modules` ni `.next`):

- **No hay ningún ref ni URL de Supabase escrita en el código.** Todo viene de variables de entorno. Las únicas coincidencias están en `docs/RESTORE.md` (ejemplos genéricos), `ORBYX_PRELAUNCH_DIAGNOSTIC.md` y `next.config.ts`.
- `orbyx-web/next.config.ts:80-90`: la CSP (hoy en modo *Report-Only*) arma su origen con `NEXT_PUBLIC_SUPABASE_URL` y cae a `https://*.supabase.co`/`wss://*.supabase.co`. **No requiere cambio de código.**
- No hay `next/image` ni `images.remotePatterns` en `next.config.ts`: no hay lista de dominios de imágenes que actualizar.
- `email.js` usa `tenants.logo_url` tal cual; no tiene URL de Supabase propia.
- **El ref viejo sí está dentro del JavaScript ya desplegado de orbyx.cl** (lo comprobé en el bundle público): `NEXT_PUBLIC_SUPABASE_URL` se incrusta al compilar. Por eso **hay que redesplegar (reconstruir) Vercel**, no basta con cambiar la variable.
- La cookie de sesión se llama `sb-<ref>-auth-token`, así que al cambiar el ref **todos los usuarios quedan sin sesión** automáticamente.

#### 5.2 Variables a cambiar (nombres exactos)

| Dónde | Variable | Cambia a | ¿Redeploy? |
|---|---|---|---|
| **Render** (`orbyx-backend-virginia`) | `SUPABASE_URL` | `https://fqmdcbvtrgcnftlwcojc.supabase.co` | Sí (al guardar reinicia) |
| Render | `SUPABASE_SERVICE_ROLE_KEY` | secret/service_role del proyecto nuevo | Sí |
| Render | `SUPABASE_CAMPAIGN_IMAGES_BUCKET` | Si existe, dejarla igual (el bucket nuevo se llama igual) | No |
| **Vercel `orbyx-web`**, Production y Preview | `NEXT_PUBLIC_SUPABASE_URL` | URL nueva | **Sí, reconstruir** (se incrusta en el build) |
| Vercel `orbyx-web` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publishable/anon nueva | **Sí, reconstruir** |
| Vercel `orbyx-web` | `SUPABASE_SERVICE_ROLE_KEY` | secret/service_role nueva (la usan las rutas `/api/upload-*` y `public-business-fallback`) | Sí |
| **Vercel `orbyx-dashboard`** (el segundo proyecto, mismo repo) | las 3 anteriores | iguales | Sí |
| **GitHub** → Orbyx-backend → Settings → Secrets and variables → Actions | `SUPABASE_DB_URL` | URI **Session pooler** del proyecto nuevo (`postgres.fqmdcbvtrgcnftlwcojc@aws-0-us-east-1.pooler.supabase.com:5432`) | No; correr el workflow a mano una vez para comprobar |
| GitHub | `BACKUP_PASSPHRASE` | Sin cambio | — |
| `.env` local en la raíz | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Actualizar solo si usas los scripts locales (`scripts/*.js`); si no, un script local apuntaría al proyecto viejo pausado | No |
| `orbyx-web/.env.local` | (no tiene variables de Supabase) | — | — |

Sin cambio: `ORBYX_PROXY_SECRET`, `NEXT_PUBLIC_BACKEND_URL` (o su valor por defecto `https://api.orbyx.cl`), claves de Flow, Twilio, Resend, Google, Turnstile (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`).

**Antes de tocar nada, guarda los valores actuales** (Render y Vercel, ambos proyectos, Production y Preview) en tu gestor de contraseñas: son tu plan de vuelta atrás.

Un punto de las claves: si el proyecto nuevo solo da `sb_publishable`/`sb_secret`, hay que revisar `verifyCurrentPassword` (`server.js:25775`) y confirmar que ninguna llamada use la service role como si fuera un JWT. No encontré otro uso fuera de `supabase-js` (los usos están en `supabaseClient.js`, `server.js:49-50` y 5 archivos de `orbyx-web`).

### 6. Base de datos (detalle de ejecución)

#### 6.1 Antes: inventario

[CLAUDE] o [CAMILO]: corre el anexo B en **SQL Editor del proyecto viejo** (solo `select`). Pega el resultado. Con eso sé qué más hay que replicar. Yo no tengo acceso a la base (el `SUPABASE_DB_URL` solo existe como secret de GitHub).

#### 6.2 Preparar el proyecto nuevo ([CLAUDE])

1. Confirmar versión de Postgres ≥ la del viejo y ≥ 17.
2. Activar extensiones del inventario.
3. Quitar los permisos por defecto de `public` para `anon`/`authenticated`/`service_role` (anexo C, paso 1), para que el dump reproduzca los permisos exactos.
4. Cargar `auth` → `public` (comandos y orden de RESTORE.md, con el cambio (b) de la tabla de la sección 2).
5. Restaurar los permisos por defecto como estaban en el viejo (`pg_default_acl` del inventario), para que las tablas futuras se comporten igual.
6. Correr las migraciones que no estén en el dump, si el inventario las muestra (publicaciones, buckets).
7. Comparación viejo vs nuevo (anexo C, pasos 2–4 y `06-verify`): conteos por tabla, RLS, políticas, funciones, triggers, permisos, publicaciones.

#### 6.3 Lo que incluye el dump de `public` (sirve)

Tablas, datos, índices, constraints, funciones (`appointments_booking_guard`, `import_customers_batch`, `undo_customer_import`, `delete_tenant_cascade`, etc.), triggers sobre tablas de `public` (`appointments_booking_guard_trg`), RLS activado y políticas, secuencias con su valor actual. El RLS de las 9 tablas con `REVOKE` de `anon` y el de `blocked_contacts` se restauran como políticas; **los `REVOKE` son lo que hay que verificar** (ver (a) arriba).

### 7. URLs de Storage guardadas en la base

Columnas que guardan una URL pública con el ref viejo (por el código):

- `tenants.logo_url`, `tenants.banner_url`
- `branches.banner_url` (y `branches.logo_url`, si existe)
- `staff.photo_url`
- `campaign_images.public_url`
- Posiblemente otras: `campaign_history` y plantillas de campaña (`hero_image_url` se usa en el envío), `support_tickets.attachments` y `support_ticket_messages.attachments`.

**No hay que reescribir** los adjuntos de tickets ni los comprobantes de depósito: el bucket es privado y el código obtiene una URL firmada nueva en cada consulta. `extractTicketAttachmentPath()` busca el texto `/ticket-attachments/` en la URL guardada y no depende del host. `deposit_receipt_path` es una ruta, no una URL.

**Cómo detectar todas** (lectura, corre en el proyecto restaurado o en el viejo):

```sql
select c.table_name, c.column_name,
  (xpath('/row/n/text()', query_to_xml(
     format('select count(*) as n from public.%I where %I::text like %L',
            c.table_name, c.column_name, '%vmxjqhndepvgoexajtfc%'),
     false, true, '')))[1]::text::int as filas
from information_schema.columns c
join information_schema.tables t using (table_schema, table_name)
where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
  and c.data_type in ('text','character varying','jsonb','json','ARRAY')
order by filas desc, c.table_name;
```

**Reescritura propuesta (NO ejecutada).** El patrón es el mismo en cada columna; el resultado de la consulta anterior define la lista final:

```sql
-- Ejemplo para las columnas conocidas (se corre en el proyecto NUEVO, después de copiar los archivos)
update public.tenants          set logo_url   = replace(logo_url,   'vmxjqhndepvgoexajtfc', 'fqmdcbvtrgcnftlwcojc') where logo_url   like '%vmxjqhndepvgoexajtfc%';
update public.tenants          set banner_url = replace(banner_url, 'vmxjqhndepvgoexajtfc', 'fqmdcbvtrgcnftlwcojc') where banner_url like '%vmxjqhndepvgoexajtfc%';
update public.branches         set banner_url = replace(banner_url, 'vmxjqhndepvgoexajtfc', 'fqmdcbvtrgcnftlwcojc') where banner_url like '%vmxjqhndepvgoexajtfc%';
update public.staff            set photo_url  = replace(photo_url,  'vmxjqhndepvgoexajtfc', 'fqmdcbvtrgcnftlwcojc') where photo_url  like '%vmxjqhndepvgoexajtfc%';
update public.campaign_images  set public_url = replace(public_url, 'vmxjqhndepvgoexajtfc', 'fqmdcbvtrgcnftlwcojc') where public_url like '%vmxjqhndepvgoexajtfc%';
-- Columnas jsonb que aparezcan en la detección:
-- update public.<tabla> set <col> = replace(<col>::text, 'vmxjqhndepvgoexajtfc','fqmdcbvtrgcnftlwcojc')::jsonb where <col>::text like '%vmxjqhndepvgoexajtfc%';
```

Se corre con los triggers desactivados (`session_replication_role=replica`) para no tocar `updated_at` ni disparar nada. Verificación posterior: repetir la detección; todo debe dar 0 filas.

Nota: los correos de campaña **ya enviados** tienen imágenes con el ref viejo. Cuando se elimine el proyecto viejo (pasadas 1–2 semanas) esas imágenes dejarán de verse en correos ya recibidos. No se puede arreglar y no afecta funcionalidad.

### 8. Integraciones externas

| Integración | Apunta a | ¿Cambia? |
|---|---|---|
| Flow (webhook y retorno) | `api.orbyx.cl` (backend) | No |
| Twilio (statusCallback) | `api.orbyx.cl` | No |
| Google Calendar OAuth (callback) | `api.orbyx.cl` | No |
| Resend (correos del backend y reset de contraseña) | Sale desde el backend | No |
| Meta/WhatsApp webhook | Pendiente; irá al backend | No |
| Cloudflare Turnstile | El widget valida el dominio de orbyx.cl | No (cambia solo el **secret** copiado en Supabase Auth, ver 4.1) |
| cron-job.org | CLAUDE.md dice que los jobs corren con `node-cron` interno; no hay jobs externos | No |
| **Supabase Auth → SMTP (Zoho/Resend)** | Directo desde Supabase hacia el proveedor | **Sí:** configurar en el proyecto nuevo (4.1, paso 3) |
| **Supabase Auth → Turnstile** | Directo desde Supabase | **Sí:** secret en el nuevo (4.1, paso 5) |
| **GitHub Actions (respaldo)** | Supabase por Session pooler | **Sí:** secret `SUPABASE_DB_URL` |
| Navegador → Supabase (Auth, Realtime, lecturas) | Por `NEXT_PUBLIC_SUPABASE_URL` | Sí, por variable (sección 5.2) |

### 9. Procedimiento de corte (mínimo tiempo caído)

Supuesto: aún sin clientes reales. Por eso no hace falta construir un modo mantenimiento: el corte se hace **suspendiendo el servicio de Render**. Si ya hubiera clientes, habría que agregar un middleware que devuelva 503 en el backend y en el middleware de Next, con una excepción para `/health`.

**Fase A — Preparación (sin tiempo caído, 1–2 días antes)**

1. [CLAUDE] Inventario (anexo B) y ajuste de scripts.
2. [CAMILO] Configuración de panel del proyecto nuevo (sección 4).
3. [CLAUDE] **Ensayo completo:** restaurar `auth` + `public` en el proyecto nuevo, copiar Storage, reescribir URLs, correr `06-verify` y la comparación de permisos. Corregir lo que falle. Los datos de ensayo se borran con `07-reset`.
4. [CAMILO] Guardar en tu gestor los valores actuales de variables de Render y Vercel (para volver atrás).
5. [CAMILO] Elegir una hora tranquila, **lejos de las 04:30 (hora de Chile) del respaldo diario**, y anotar el commit actual de `main` de ambos repos.

**Fase B — Corte (tiempo caído estimado: 20–40 min)**

| # | Quién | Paso |
|---|---|---|
| 1 | CAMILO | Render → `orbyx-backend-virginia` → **Suspend Service**. Esto detiene escrituras y los crons internos (`node-cron`), incluido `chargeRecurringAddons`. Las páginas siguen cargando, pero las acciones fallan |
| 2 | CLAUDE | Dump final del viejo → `07-reset` en el nuevo → carga solo de datos (`auth`, luego `public`) |
| 3 | CLAUDE | `04-copy-storage.js` (pasada final, omite lo ya copiado) |
| 4 | CLAUDE | `05-rewrite-urls.sql` y verificación (0 filas con el ref viejo) |
| 5 | CLAUDE | `06-verify`: conteos de tablas, `auth.users`, buckets y objetos, permisos, publicaciones. Debe coincidir con el viejo |
| 6 | CAMILO | Render: cambiar `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` → guardar → **Resume Service**. Esperar a `Live` y a que `https://api.orbyx.cl/health` responda |
| 7 | CAMILO | Vercel, **ambos proyectos**: cambiar `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Production y Preview) → Deployments → último → ⋯ → **Redeploy** con "Use existing Build Cache" **desmarcado** (las `NEXT_PUBLIC_*` se incrustan al compilar). Los dos proyectos pueden construirse a la vez |
| 8 | CAMILO | GitHub → Orbyx-backend → Settings → Secrets and variables → Actions → actualizar `SUPABASE_DB_URL` |
| 9 | CLAUDE + CAMILO | Pruebas de humo (abajo) |
| 10 | CAMILO | Si todo sale bien, **pausar el proyecto viejo** (Project Settings → General → Pause project) y dejarlo 1–2 semanas |

El orden 6 antes que 7 hace que, durante unos minutos, el frontend viejo (con la URL vieja incrustada) hable con un backend en la base nueva. Es esperable que falle el inicio de sesión en ese intervalo; no hay usuarios. Si prefieres evitar la ventana, redespliega Vercel justo después de que Render esté `Live`.

**Pruebas de humo (paso 9)**

1. `https://api.orbyx.cl/health` → `{"status":"ok"}` y en los logs de Render, sin errores de Supabase al arrancar.
2. `https://www.orbyx.cl/login` con tu cuenta de pruebas → entra al dashboard → la Agenda carga.
3. `/admin/login` con tu cuenta admin (incluye MFA). Si el TOTP no funciona, plan B de la fila (h).
4. Página pública de un negocio → elegir servicio → ver horarios → **crear una reserva de prueba** (con Turnstile) → llega el correo y aparece en la Agenda.
5. Notificación en vivo: crear una reserva y ver la campana del dashboard (prueba la publicación Realtime de `appointments`).
6. Subir un logo, un banner y una foto de staff → se ven en el sitio público (prueba escritura de Storage y URLs públicas).
7. Subir un comprobante de depósito → se ve con URL firmada desde la Agenda (bucket privado).
8. Un ticket con adjunto: abrir uno antiguo (la URL guardada tiene el ref viejo) y verlo con URL firmada.
9. Registro nuevo en `/signup` → llega el correo de confirmación (SMTP + captcha de Supabase) → confirmar → entrar.
10. "Olvidé mi contraseña" → llega por Resend → cambiar la contraseña.
11. Cambiar el plan, WhatsApp de confirmación y Google Calendar: no deberían cambiar, pero conviene una prueba rápida de cada uno.
12. Correr a mano el workflow de respaldo (Actions → "Respaldo diario de la base de datos" → Run workflow) y comparar `MANIFIESTO.txt` con el nuevo proyecto.
13. Logs de Render con `[PERF]`: `tenantUsers` y `branchAccess` deben bajar de cientos de milisegundos a ~10–40 ms. Esa es tu medición real del beneficio.

**Qué pasa con lo que está abierto**
- **Sesiones:** todos deben volver a iniciar sesión (cookie `sb-<ref>-auth-token` nueva y llaves de firma distintas).
- **Enlaces ya enviados** (confirmación de registro, reset): los generados antes del corte quedan inválidos. Los tokens de invitación de equipo (`tenant_invitations`) son de la app y siguen válidos.
- **Crons:** quedan detenidos mientras Render está suspendido. Los trabajos con ventana (recordatorios de WhatsApp y de correo cada 15 min, expiración de depósitos cada 5 min, cobros recurrentes) se ponen al día en la siguiente ejecución. Con `DISABLE_INTERNAL_CRONS` en `false` en el servicio activo. No dejes dos servicios del backend vivos a la vez: cada uno ejecuta los crons y los cobros se duplicarían (lo anotó CLAUDE.md en la migración de dominio).
- **Webhooks de Flow/Twilio durante la suspensión:** fallarán y Flow reintenta. Hoy Flow está en sandbox.

### 10. Plan de vuelta atrás

**Cuándo decidir:** si en los primeros 30–60 min fallan el login, la creación de reservas o el panel admin, y la causa no se arregla rápido.

1. [CAMILO] Render: restaurar `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` con los valores del viejo (los guardaste en la fase A) → el servicio se reinicia.
2. [CAMILO] Supabase viejo: si ya lo pausaste, Project → **Restore project** (tarda unos minutos).
3. [CAMILO] Vercel, ambos proyectos: restaurar las tres variables y Redeploy, o desde Deployments → el último build bueno → ⋯ → **Promote to Production**. Para hacerlo mejor, anota en la fase A el ID del último deployment bueno de cada proyecto.
4. [CAMILO] GitHub: restaurar `SUPABASE_DB_URL`.
5. Todos vuelven a iniciar sesión.

**Qué pasa con los datos:** el proyecto viejo conserva todo lo anterior al corte. Lo que se haya escrito en el nuevo después del corte **se pierde al volver**, salvo que lo copiemos a mano con un volcado inverso solo de lo nuevo. Sin clientes eso no importa; **por eso conviene migrar antes del primer cliente.**

Mientras el viejo siga pausado (1–2 semanas) y no eliminado, la vuelta atrás existe. En Free, un proyecto pausado se puede restaurar por un período limitado; no lo dejes pasar de esa ventana antes de borrarlo. Al borrarlo, rota o revoca sus claves (`service_role`) en todos los lugares donde estaban.

### 11. Riesgos concretos y qué podría romperse

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| **Permisos de `anon` no reproducidos** tras el restore (el `REVOKE` de 2026-09-30 se pierde, y `import_customers_batch` queda ejecutable por `anon`) | **Media-alta** si no se hace el paso previo | **Alto** (fuga de datos entre negocios) | Anexo C, pasos 1 y 2. Verificación obligatoria antes de reabrir el tráfico |
| `auth.schema_migrations` pisando migraciones del Auth nuevo | Media | Medio (Auth falla o restore con errores) | Volcar solo `users/identities/mfa_factors` |
| Claves del proyecto nuevo en formato nuevo (`sb_…`) | Media | Medio: `verifyCurrentPassword` | Probar en el ensayo. Cambio de una línea si hace falta |
| Postgres nuevo < 17 | Baja | Alto (restore falla) | Verificar versión antes |
| Imágenes rotas por URLs con ref viejo | Alta si se olvida | Bajo-medio (logos, banners, fotos de staff, campañas) | Detección y reescritura (sección 7); prueba de humo n.° 6 |
| Realtime sin eventos (publicación incompleta) | Media | Bajo (campana y cupo) | Revisar publicación; `reviews` incluida |
| Auth sin SMTP/Turnstile/redirects iguales | Media | Medio (registro y reset rotos) | Sección 4.1; pruebas 9 y 10 |
| Dos servicios backend vivos a la vez (crons y cobros duplicados) | Baja | **Alto** | Suspender antes, reanudar solo uno |
| Vercel con `NEXT_PUBLIC_*` viejas por cache de build | Media | Alto (el navegador seguiría hablando con el proyecto viejo) | Redeploy sin cache en ambos proyectos; revisar que el bundle ya no contenga el ref viejo |
| Cuenta admin sin MFA operativo | Baja | Bajo (solo tú) | Borrar factor y reinscribir |
| Free: pausa por 7 días sin actividad / sin respaldos propios | Media si no hay uso | Alto en producción | Pasar a Pro antes del primer cliente (decisión tuya); el respaldo diario por GitHub ya existe |
| Rollback con datos nuevos | Aplica solo después del primer cliente | Alto | Migrar antes del primer cliente |
| Sesiones y enlaces en vuelo invalidados | Cierta | Bajo | Esperado; sin clientes |
| Las ~48 consultas de la reserva siguen siendo muchas | Cierta | Bajo tras migrar | Optimización posterior |

### 12. Estimación de tiempo

| Fase | Quién | Tiempo |
|---|---|---|
| Inventario, scripts y ajuste de RESTORE.md | CLAUDE | 1–1,5 h |
| Ensayo completo y comparación de permisos/esquema | CLAUDE | 1–1,5 h |
| Configuración de panel del proyecto nuevo (sección 4) | CAMILO | 45–60 min a mano (≈15 min con el atajo de la Management API) |
| Guardar variables actuales | CAMILO | 10 min |
| **Total de preparación** | | **medio día de trabajo efectivo (3–4 h de mi parte + ~1 h de la tuya)** |
| Corte (pasos 1–8 de la fase B) | ambos | 15–25 min |
| Pruebas de humo (paso 9) | ambos | 15–20 min |
| **Tiempo caído** | | **~20–40 min** (de la suspensión de Render a que Vercel termina de construir; el backend vuelve antes) |
| Después | CAMILO | Pausar el viejo; eliminar a las 1–2 semanas |

---

## Anexo A — Archivos y líneas relevantes

- Cliente Supabase del backend: `supabaseClient.js`, `server.js:49-50`; Auth directo con service role: `server.js:25775` (`verifyCurrentPassword`).
- Storage en backend: `server.js:13137` (`deposit-receipts`, URL firmada), `22513-22525` (campaign-images), `22630-22634` (`ticket-attachments`), `22740-22785` (`extractTicketAttachmentPath`), `24360-24509` (borrado de carpetas por tenant).
- Storage en Next: `orbyx-web/app/api/upload-business-logo`, `upload-business-banner`, `upload-staff-photo`, `upload-deposit-receipt` (todas con service role).
- Auth y datos en el navegador: `orbyx-web/lib/supabase/client.ts`, `lib/supabase/server.ts`, `lib/api.ts`, `middleware.ts`, `lib/dashboard-access.ts`, `app/login/page.tsx`, `app/dashboard/[slug]/layout.tsx`.
- CSP: `orbyx-web/next.config.ts:80-90`.
- Respaldo: `.github/workflows/db-backup.yml`, `docs/RESTORE.md`.
- Migraciones con Realtime: `2026-08-02-tenant-monthly-usage-rls.sql:57`, `2026-09-13-review-replies-and-reactions.sql:56`. Buckets: `2026-05-28-global-logo-branch-local-fields.sql:20`, `2026-08-02-deposit-required.sql:91`. `REVOKE anon`: `2026-09-30-rls-close-anon-tables.sql:100-108`. Funciones solo `service_role`: `2026-10-12-customer-import.sql:213-219`.

## Anexo B — Inventario del proyecto viejo (solo lectura)

Para pegar en SQL Editor del proyecto viejo. Cada bloque es un `select`; si alguno da error ("schema … does not exist"), significa que esa función no se usa.

```sql
-- 1. Versión y zona horaria
select version(), current_setting('TimeZone') as tz, pg_size_pretty(pg_database_size(current_database())) as tamano;

-- 2. Extensiones
select e.extname, e.extversion, n.nspname as esquema from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by 1;

-- 3. Publicación de Realtime
select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 2;

-- 4. Triggers fuera de public (auth/storage) que no son de Supabase
select event_object_schema, event_object_table, trigger_name, action_statement
from information_schema.triggers where event_object_schema in ('auth','storage');

-- 5. Funciones propias fuera de public
select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname not in ('pg_catalog','information_schema','auth','storage','extensions','realtime','graphql','graphql_public','pgsodium','pgsodium_masks','vault','supabase_functions','net','pgbouncer','public','_realtime','supabase_migrations');

-- 6. Buckets
select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by id;

-- 7. Políticas de Storage
select policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'storage';

-- 8. Archivos por bucket
select bucket_id, count(*) as archivos, pg_size_pretty(sum((metadata->>'size')::bigint)) as peso from storage.objects group by 1 order by 1;

-- 9. Permisos por defecto y ajustes de rol
select defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl from pg_default_acl;
select * from pg_db_role_setting;

-- 10. Estado de RLS en public
select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forzado
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1;

-- 11. pg_cron, webhooks, Vault (pueden dar error: es lo esperado si no se usan)
select * from cron.job;
select * from supabase_functions.hooks;
select count(*) from vault.secrets;

-- 12. Auth: conteos de control
select (select count(*) from auth.users) as usuarios,
       (select count(*) from auth.identities) as identidades,
       (select count(*) from auth.mfa_factors) as factores_mfa;

-- 13. Conteo de filas por tabla de public (estimado)
select relname, n_live_tup from pg_stat_user_tables where schemaname = 'public' order by 2 desc;
```

## Anexo C — Permisos y comparación entre proyectos

**Paso 1 — antes de restaurar, en el proyecto NUEVO** (como `postgres`; el objetivo es que los `GRANT` del dump definan los permisos y no los valores por defecto de Supabase):

```sql
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;
```

(El inventario, consulta 9, muestra los valores originales, para dejarlos igual al terminar.)

**Paso 2 — después de restaurar, correr en AMBOS proyectos y comparar** (deben ser idénticos):

```sql
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as permisos
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon','authenticated','service_role')
group by 1,2 order by 1,2;

select routine_name, grantee, string_agg(privilege_type, ',') as permisos
from information_schema.routine_privileges
where specific_schema = 'public' and grantee in ('PUBLIC','anon','authenticated','service_role')
group by 1,2 order by 1,2;

select schemaname, tablename, policyname, cmd, roles from pg_policies where schemaname = 'public' order by 1,2,3;
```

**Criterio de aceptación para reabrir el tráfico:** las 9 tablas del `REVOKE` de 2026-09-30, `blocked_contacts`, `import_customers_batch` y `undo_customer_import` no deben tener ningún permiso para `anon`, ni `PUBLIC` en las dos funciones; y las políticas deben ser idénticas.

## Anexo D — Qué NO verifiqué (para que no lo des por hecho)

- No tuve acceso a ninguna base. Lo que dice el código sobre tablas, columnas y buckets es lo que el código usa; el inventario (Anexo B) confirma la realidad en vivo. Como ya vimos con `appointments` y `legal_acceptances`, los `.sql` del repo no son un inventario fiable de lo que hay en producción.
- No pude medir Render→Supabase directamente; el costo por consulta sale de la diferencia entre `/health` y una ruta con una sola consulta, y de los logs `[PERF]` que ya tienes.
- No sé si la región de funciones de Vercel es realmente `iad1` (lo diste por hecho). Se confirma en cada proyecto de Vercel → Settings → Functions → Function Region.
- Las claves, el tipo de firma JWT y la versión de Postgres del proyecto nuevo son hipótesis hasta que las mires en el panel.
