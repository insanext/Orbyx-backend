-- PREPARAR EL PROYECTO NUEVO ANTES DE RESTAURAR (se corre en el NUEVO, como postgres).
--
-- Por que: el proyecto nuevo tiene "Automatically expose new tables" activo, o sea, permisos por defecto que
-- le dan a anon/authenticated/service_role acceso a toda tabla/funcion/secuencia nueva en public. pg_dump escribe
-- los GRANT de cada objeto, pero NO un REVOKE explicito por rol. Si estos permisos por defecto siguen activos al
-- restaurar, anon queda con permisos que en el proyecto viejo se le quitaron (REVOKE del 2026-09-30,
-- import_customers_batch, undo_customer_import, etc.).
-- Quitandolos ANTES, los unicos permisos que quedan son los GRANT explicitos del dump = exactamente los del viejo.
-- Al terminar, 05-post-restore.sh re-aplica los permisos por defecto que tenia el viejo (solo afectan objetos futuros).

\echo --- permisos por defecto ANTES
select defaclrole::regrole as rol, defaclnamespace::regnamespace as esquema, defaclobjtype as tipo, defaclacl
from pg_default_acl order by 1,2,3;

alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;

\echo --- permisos por defecto DESPUES
select defaclrole::regrole as rol, defaclnamespace::regnamespace as esquema, defaclobjtype as tipo, defaclacl
from pg_default_acl order by 1,2,3;
