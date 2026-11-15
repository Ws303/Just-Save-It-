-- 0009_private_revoke_and_realtime_check.sql
-- Additive, idempotent security & Realtime hardening:
--   1. Ensure private schema tables and functions cannot be accessed by PUBLIC or anon
--   2. Ensure Realtime publication contains public.items, public.folders, public.folder_members, public.reminders

revoke all on schema private from PUBLIC, anon;
revoke all on all tables in schema private from PUBLIC, anon;
revoke all on all routines in schema private from PUBLIC, anon;

grant usage on schema private to authenticated, service_role;

do $$
declare
  tbl text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach tbl in array array['items', 'folders', 'folder_members', 'reminders'] loop
      if not exists (
        select 1
          from pg_publication_tables
         where pubname = 'supabase_realtime'
           and schemaname = 'public'
           and tablename = tbl
      ) then
        execute format('alter publication supabase_realtime add table public.%I', tbl);
      end if;
    end loop;
  end if;
end
$$;

notify pgrst, 'reload schema';
