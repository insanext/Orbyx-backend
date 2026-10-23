-- REESCRITURA DE URLs QUE LLEVAN EL REF VIEJO (genera avisos por cada columna afectada).
-- Recorre TODAS las columnas text / varchar / json / jsonb / text[] / varchar[] del esquema public.
-- Variables (las pone 07-rewrite-urls.sh):  old_ref, new_ref, do_apply ('0' = solo contar, '1' = reemplazar)
-- Funciona por GUC porque psql no interpola variables dentro de bloques $$.

select set_config('orbyx.old_ref', :'old_ref', false);
select set_config('orbyx.new_ref', :'new_ref', false);
select set_config('orbyx.apply',   :'do_apply', false);
-- Con triggers apagados: no se toca updated_at ni se dispara nada.
set session_replication_role = replica;

do $$
declare
  r record;
  old_ref text := current_setting('orbyx.old_ref');
  new_ref text := current_setting('orbyx.new_ref');
  apply   boolean := current_setting('orbyx.apply') = '1';
  cond text; setexpr text; n bigint; total bigint := 0; cols int := 0;
begin
  for r in
    select c.table_name, c.column_name, c.data_type, c.udt_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
      and t.table_type = 'BASE TABLE'
      and c.is_generated = 'NEVER'
      and (c.data_type in ('text','character varying','json','jsonb')
           or (c.data_type = 'ARRAY' and c.udt_name in ('_text','_varchar')))
    order by 1, 2
  loop
    if r.data_type in ('text','character varying') then
      cond    := format('%I like %L', r.column_name, '%' || old_ref || '%');
      setexpr := format('%I = replace(%I, %L, %L)', r.column_name, r.column_name, old_ref, new_ref);
    elsif r.data_type in ('json','jsonb') then
      cond    := format('%I::text like %L', r.column_name, '%' || old_ref || '%');
      setexpr := format('%I = replace(%I::text, %L, %L)::%s', r.column_name, r.column_name, old_ref, new_ref, r.data_type);
    else -- text[] / varchar[]
      cond    := format('array_to_string(%I, chr(31)) like %L', r.column_name, '%' || old_ref || '%');
      setexpr := format('%I = (select array_agg(replace(x, %L, %L)) from unnest(%I) as x)::%s[]',
                        r.column_name, old_ref, new_ref, r.column_name, case r.udt_name when '_varchar' then 'varchar' else 'text' end);
    end if;

    execute format('select count(*) from public.%I where %s', r.table_name, cond) into n;
    if n > 0 then
      cols := cols + 1; total := total + n;
      raise notice '%.%  (%): % fila(s) con el ref viejo', r.table_name, r.column_name, r.data_type, n;
      if apply then
        execute format('update public.%I set %s where %s', r.table_name, setexpr, cond);
        raise notice '   -> reescritas';
      end if;
    end if;
  end loop;
  raise notice 'RESUMEN: % columna(s), % fila(s) %', cols, total, case when apply then 'REESCRITAS' else '(solo conteo, no se cambio nada)' end;
end $$;
