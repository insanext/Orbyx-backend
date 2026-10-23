# Cómo restaurar un respaldo de Orbyx

Cada noche (~04:30 hora de Chile) GitHub genera un respaldo de la base de datos de Supabase, lo cifra y lo guarda **30 días**. Esta guía explica cómo usarlo para dejar Orbyx funcionando en un proyecto Supabase nuevo.

> El respaldo contiene datos personales de clientes. Trátalo como información confidencial: no lo subas a ningún lado ni lo compartas sin cifrar. Los archivos que salen del paso 3 **no están cifrados**: bórralos cuando termines.

## Qué incluye y qué no

| Incluye | No incluye |
|---|---|
| Todas las tablas, datos, funciones y reglas de seguridad (RLS) del schema `public` | Los **archivos** de Supabase Storage (logos, fotos de staff, comprobantes, imágenes de campañas, adjuntos de tickets) |
| Usuarios para iniciar sesión (`auth.users`, identidades, factores MFA, con sus contraseñas ya cifradas) | Ajustes del panel de Supabase (captcha de Turnstile, URLs de redirección, plantillas de correo) |
| | Sesiones abiertas: todos tendrán que iniciar sesión de nuevo |

## Qué necesitas

1. La **passphrase** del respaldo (el secret `BACKUP_PASSPHRASE` de GitHub; debería estar también en tu gestor de contraseñas). **Sin ella el respaldo no se puede abrir.**
2. Un computador con **GnuPG** (para descifrar) y **psql 17** (para cargar la base).
   - Windows: instala *Gpg4win* (gpg4win.org) y *PostgreSQL 17* (en el instalador basta marcar solo "Command Line Tools").
   - Mac: `brew install gnupg libpq` y luego `brew link --force libpq`.
3. Un proyecto Supabase **nuevo y vacío**.

## Paso 1: bajar el respaldo

1. Entra a GitHub → repositorio **Orbyx-backend** → pestaña **Actions** → **Respaldo diario de la base de datos**.
2. Abre la ejecución (fecha) que quieres restaurar y baja el archivo de la sección **Artifacts**. GitHub lo entrega dentro de un `.zip`: descomprímelo y obtendrás `orbyx-backup-AAAA-MM-DD_HHMM.tar.gz.gpg`.

## Paso 2: descifrar

En una terminal, en la carpeta donde dejaste el archivo (cambia el nombre por el real):

```bash
gpg --output backup.tar.gz --decrypt orbyx-backup-2026-10-23_0730.tar.gz.gpg
```

Te pedirá la passphrase. Luego descomprime:

```bash
tar -xzf backup.tar.gz
```

Quedan tres archivos: `public.sql`, `auth-data.sql` y `MANIFIESTO.txt`. Abre `MANIFIESTO.txt`: dice la fecha del respaldo y cuántos usuarios, negocios y reservas tenía. Lo usarás para comprobar al final.

## Paso 3: preparar el proyecto Supabase nuevo

1. Crea el proyecto en supabase.com (elige la misma región que el anterior si puedes).
2. En el proyecto: botón **Connect** (arriba) → **Session pooler** → copia la URI. Se ve así:
   `postgresql://postgres.xxxxxxxx:[YOUR-PASSWORD]@aws-0-REGION.pooler.supabase.com:5432/postgres`
   Reemplaza `[YOUR-PASSWORD]` por la contraseña de la base de datos (Project Settings → Database; si no la recuerdas, puedes restablecerla ahí).

## Paso 4: cargar los datos

Define la URI en una variable para no escribirla cada vez.

Mac / Linux / Git Bash:

```bash
export DB_URL='postgresql://postgres.xxxxxxxx:TU_CLAVE@aws-0-REGION.pooler.supabase.com:5432/postgres'
export PGOPTIONS='-c session_replication_role=replica'
```

Windows PowerShell:

```powershell
$env:DB_URL = 'postgresql://postgres.xxxxxxxx:TU_CLAVE@aws-0-REGION.pooler.supabase.com:5432/postgres'
$env:PGOPTIONS = '-c session_replication_role=replica'
```

Carga **primero los usuarios y después la base** (en ese orden, porque las tablas de Orbyx apuntan a los usuarios):

```bash
psql "$DB_URL" -f auth-data.sql
psql "$DB_URL" -f public.sql
```

En PowerShell usa `$env:DB_URL` en lugar de `"$DB_URL"`.

Pueden aparecer algunos mensajes de tipo `already exists` (cosas que Supabase ya trae de fábrica): son normales. Un error que **no** es normal es uno que diga `relation ... does not exist` o `violates foreign key`; si lo ves, avísale a quien te ayude con soporte técnico y guarda el texto completo.

## Paso 5: dejar lista la parte que el respaldo no trae

1. **Realtime** (para las notificaciones en vivo del dashboard). En Supabase → SQL Editor, ejecuta:

   ```sql
   alter publication supabase_realtime add table public.appointments, public.tenant_monthly_usage;
   ```

2. **Storage**. Crea estos buckets en Supabase → Storage: `business-logos`, `staff-photos`, `campaign-images` y `ticket-attachments` (con la misma configuración pública que tenían en el proyecto anterior) y `deposit-receipts` (**privado**: son comprobantes de pago). Los archivos que tenían no vuelven con este respaldo; los registros en la base seguirán apuntando a ellos hasta que se suban de nuevo.
3. **Auth**. Authentication → Attack Protection: activar Captcha con Turnstile (con el mismo secret). Authentication → URL Configuration: dejar `https://www.orbyx.cl` como Site URL y volver a agregar las URLs de redirección que usaba el proyecto anterior.
4. **Variables de entorno**. Con el proyecto nuevo, actualiza las claves de Supabase en los dos servicios:
   - Render (backend): la URL de Supabase y la service role key.
   - Vercel (orbyx-web): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`.
   Después haz un redeploy en ambos.

## Paso 6: comprobar

En Supabase → SQL Editor:

```sql
select count(*) from auth.users;
select count(*) from public.tenants;
select count(*) from public.appointments;
```

Los números deben coincidir con `MANIFIESTO.txt`. Luego entra a `https://www.orbyx.cl/login` con una cuenta real, abre el dashboard y revisa que la agenda cargue.

## Paso 7: limpiar

Borra `backup.tar.gz`, `public.sql`, `auth-data.sql` y `MANIFIESTO.txt` del computador (están sin cifrar).
