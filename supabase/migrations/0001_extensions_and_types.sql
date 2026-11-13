-- 0001_extensions_and_types.sql
-- Idempotent extensions, private schema, and enum types for Just-Save-It Part 1.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create schema if not exists private;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'item_status' and n.nspname = 'public'
  ) then
    create type public.item_status as enum ('inbox', 'todo', 'done', 'archived');
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'enrich_status' and n.nspname = 'public'
  ) then
    create type public.enrich_status as enum ('pending', 'unfurled', 'done', 'failed');
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'folder_role' and n.nspname = 'public'
  ) then
    create type public.folder_role as enum ('owner', 'editor', 'viewer');
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'reminder_schedule_type' and n.nspname = 'public'
  ) then
    create type public.reminder_schedule_type as enum ('once', 'every_n_days');
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'reminder_status' and n.nspname = 'public'
  ) then
    create type public.reminder_status as enum ('pending', 'sent', 'cancelled');
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'device_platform' and n.nspname = 'public'
  ) then
    create type public.device_platform as enum ('android', 'ios', 'web', 'extension');
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'device_delivery_mode' and n.nspname = 'public'
  ) then
    create type public.device_delivery_mode as enum ('remote', 'local_sync');
  end if;
end
$$;
