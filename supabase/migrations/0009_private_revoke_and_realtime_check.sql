-- 0009_private_revoke_and_realtime_check.sql
-- Additive, idempotent security, trigger role detection & Realtime hardening:
--   1. Ensure private schema tables and functions cannot be accessed by PUBLIC or anon
--   2. Update guard_profile_tier / guard_item_ownership for PostgREST v12+ (claims JSON / auth.role() / current_user)
--   3. Ensure Realtime publication contains public.items, public.folders, public.folder_members, public.reminders

revoke all on schema private from PUBLIC, anon;
revoke all on all tables in schema private from PUBLIC, anon;
revoke all on all routines in schema private from PUBLIC, anon;

grant usage on schema private to authenticated, service_role;

create or replace function private.guard_profile_tier()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'), ''),
    (select auth.role())
  );
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin')
     and coalesce(v_jwt_role, '') is distinct from 'service_role' then
    if tg_op = 'INSERT' then
      new.tier := 'free';
    elsif tg_op = 'UPDATE' and new.tier is distinct from old.tier then
      raise exception 'Profile tier can only be updated by service_role';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.guard_item_ownership()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'), ''),
    (select auth.role())
  );
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin')
     and coalesce(v_jwt_role, '') is distinct from 'service_role' then
    if new.owner_id is distinct from old.owner_id then
      raise exception 'Item owner_id is immutable';
    end if;
    if new.folder_id is distinct from old.folder_id and old.owner_id is distinct from (select auth.uid()) then
      raise exception 'Only item owner can move item across folders';
    end if;
  end if;
  return new;
end;
$$;

grant execute on function private.guard_profile_tier() to authenticated, service_role;
grant execute on function private.guard_item_ownership() to authenticated, service_role;

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
