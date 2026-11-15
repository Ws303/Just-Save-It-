-- =============================================================================
-- Just-Save-It Unified Production PostgreSQL / Supabase Schema
-- =============================================================================
-- Auto-consolidated from the authoritative migration suite:
--   supabase/migrations/0001_extensions_and_types.sql
--   supabase/migrations/0002_core_tables.sql
--   supabase/migrations/0003_indexes.sql
--   supabase/migrations/0004_functions_and_triggers.sql
--   supabase/migrations/0005_rls_policies.sql
--   supabase/migrations/0006_storage_realtime_and_cron.sql
--
-- Safe & idempotent: can be pasted directly into Supabase SQL Editor as one run.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- SECTION: 0001_extensions_and_types.sql
-- -----------------------------------------------------------------------------

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


-- -----------------------------------------------------------------------------
-- SECTION: 0002_core_tables.sql
-- -----------------------------------------------------------------------------

-- 0002_core_tables.sql
-- Idempotent core 11-table schema for Just-Save-It Part 1.

-- 1. Profiles
create table if not exists public.profiles (
  id                         uuid primary key references auth.users(id) on delete cascade,
  display_name               text,
  avatar_url                 text,
  tier                       text not null default 'free' check (tier in ('free', 'pro')),
  locale                     text not null default 'th',
  preferred_summary_language text not null default 'th'
                               check (preferred_summary_language in ('th', 'en', 'auto')),
  default_timezone           text not null default 'Asia/Bangkok',
  updated_at                 timestamptz not null default now(),
  created_at                 timestamptz not null default now()
);

-- 2. Folders
create table if not exists public.folders (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 80),
  emoji      text,
  is_shared  boolean not null default false,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- 3. Folder Members
create table if not exists public.folder_members (
  folder_id  uuid not null references public.folders(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       public.folder_role not null default 'editor',
  joined_at  timestamptz not null default now(),
  primary key (folder_id, user_id)
);

-- 4. Folder Invites
create table if not exists public.folder_invites (
  token      text primary key default encode(gen_random_bytes(16), 'hex'),
  folder_id  uuid not null references public.folders(id) on delete cascade,
  role       public.folder_role not null default 'editor' check (role <> 'owner'),
  created_by uuid not null references public.profiles(id) on delete cascade,
  max_uses   int check (max_uses is null or max_uses > 0),
  use_count  int not null default 0 check (use_count >= 0),
  revoked_at timestamptz,
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now()
);

-- 5. Items (lossless TEXT for title/description/note/ai_summary, <=5 media_items)
create table if not exists public.items (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references public.profiles(id) on delete cascade,
  folder_id           uuid references public.folders(id) on delete set null,
  url                 text not null,
  canonical_url       text,
  url_hash            text not null default '',
  title               text,
  description         text,
  image_url           text,
  media_items         jsonb not null default '[]'::jsonb
                        check (jsonb_typeof(media_items) = 'array' and jsonb_array_length(media_items) <= 5),
  embed_type          text not null default 'none'
                        check (embed_type in ('none','youtube','tiktok','instagram','facebook','x','reddit','vimeo','spotify')),
  embed_url           text,
  site_name           text,
  favicon_url         text,
  content_type        text check (content_type is null or content_type in ('video','article','post','product','link','other')),
  platform            text,
  note                text,
  ai_summary          text,
  ai_summary_language text default 'th'
                        check (ai_summary_language is null or ai_summary_language in ('th','en','auto')),
  ai_tags             text[],
  is_favorite         boolean not null default false,
  status              public.item_status not null default 'inbox',
  enrich_status       public.enrich_status not null default 'pending',
  enrich_attempts     int not null default 0 check (enrich_attempts >= 0),
  enrich_error        text,
  unfurled_at         timestamptz,
  saved_at            timestamptz not null default now(),
  done_at             timestamptz,
  updated_at          timestamptz not null default now(),
  search_tsv          tsvector generated always as (
                        to_tsvector(
                          'simple',
                          coalesce(title, '') || ' ' ||
                          coalesce(description, '') || ' ' ||
                          coalesce(note, '') || ' ' ||
                          coalesce(ai_summary, '') || ' ' ||
                          coalesce(url, '')
                        )
                      ) stored,
  constraint uniq_owner_url unique (owner_id, url_hash)
);

-- 6. Tags
create table if not exists public.tags (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  name       text not null check (char_length(name) >= 1),
  color      text,
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

-- 7. Item Tags
create table if not exists public.item_tags (
  item_id    uuid not null references public.items(id) on delete cascade,
  tag_id     uuid not null references public.tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (item_id, tag_id)
);

-- 8. Reminders (1-time & every-N-days recurring)
create table if not exists public.reminders (
  id                uuid primary key default gen_random_uuid(),
  item_id           uuid not null references public.items(id) on delete cascade,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  schedule_type     public.reminder_schedule_type not null default 'once',
  remind_at         timestamptz not null,
  repeat_every_days int check (repeat_every_days is null or repeat_every_days between 1 and 365),
  remind_time       time,
  timezone          text not null default 'Asia/Bangkok',
  status            public.reminder_status not null default 'pending',
  title_snapshot    text,
  last_triggered_at timestamptz,
  sent_at           timestamptz,
  updated_at        timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (item_id, user_id),
  constraint chk_reminder_schedule_fields check (
    (schedule_type = 'once' and repeat_every_days is null) or
    (schedule_type = 'every_n_days' and repeat_every_days between 1 and 365 and remind_time is not null)
  )
);

-- 9. Devices (remote push + iOS pre-APNs local_sync with nullable unique push_token)
create table if not exists public.devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  platform      public.device_platform not null,
  delivery_mode public.device_delivery_mode not null default 'remote',
  push_token    text unique,
  web_push_sub  jsonb,
  is_active     boolean not null default true,
  last_seen     timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- 10. Daily AI Usage (monthly quota tracking)
create table if not exists public.daily_ai_usage (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  usage_month   text not null,
  request_count int not null default 0 check (request_count >= 0),
  last_used_at  timestamptz not null default now(),
  unique (user_id, usage_month)
);

-- 11. API Tokens (SHA-256 hashed MCP tokens)
create table if not exists public.api_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  token_hash   text not null unique,
  token_prefix text not null,
  name         text not null,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- SECTION: 0003_indexes.sql
-- -----------------------------------------------------------------------------

-- 0003_indexes.sql
-- Idempotent FK, partial, composite, FTS, and pg_trgm indexes for sub-10ms multi-language search.

-- Folders
create index if not exists folders_owner_idx
  on public.folders (owner_id);

-- Folder Members
create index if not exists folder_members_user_idx
  on public.folder_members (user_id);

-- Folder Invites (all FK columns covered)
create index if not exists folder_invites_folder_idx
  on public.folder_invites (folder_id);

create index if not exists folder_invites_created_by_idx
  on public.folder_invites (created_by);

-- Items: Keyset pagination, folder access, platform/content_type filters, unfurl cache & retry
create index if not exists items_owner_status_idx
  on public.items (owner_id, status, saved_at desc, id desc);

create index if not exists items_folder_idx
  on public.items (folder_id, saved_at desc, id desc);

create index if not exists items_owner_platform_idx
  on public.items (owner_id, platform, content_type, saved_at desc);

create index if not exists items_url_hash_cache_idx
  on public.items (url_hash, unfurled_at desc)
  where enrich_status in ('unfurled', 'done');

create index if not exists items_enrich_retry_idx
  on public.items (enrich_status, enrich_attempts)
  where enrich_status in ('pending', 'failed');

-- Items: Full-text search ('simple' config for multi-language) + pg_trgm for Thai/CJK unsegmented substrings
create index if not exists items_tsv_idx
  on public.items using gin (search_tsv);

create index if not exists items_title_trgm_idx
  on public.items using gin (title gin_trgm_ops);

create index if not exists items_4field_trgm_idx
  on public.items using gin (
    (
      coalesce(title, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(note, '') || ' ' ||
      coalesce(ai_summary, '')
    ) gin_trgm_ops
  );

-- Tags & Item Tags
create index if not exists tags_owner_idx
  on public.tags (owner_id);

create index if not exists item_tags_tag_idx
  on public.item_tags (tag_id);

-- Reminders
create index if not exists reminders_item_idx
  on public.reminders (item_id);

create index if not exists reminders_user_idx
  on public.reminders (user_id);

create index if not exists reminders_due_idx
  on public.reminders (remind_at)
  where status = 'pending';

create index if not exists reminders_sync_idx
  on public.reminders (user_id, remind_at asc)
  where status = 'pending';

-- Devices
create index if not exists devices_user_idx
  on public.devices (user_id);

create index if not exists devices_user_active_idx
  on public.devices (user_id, platform)
  where is_active = true;

-- Daily AI Usage
create index if not exists daily_ai_usage_user_idx
  on public.daily_ai_usage (user_id, usage_month);

-- API Tokens
create index if not exists api_tokens_user_idx
  on public.api_tokens (user_id);


-- -----------------------------------------------------------------------------
-- SECTION: 0004_functions_and_triggers.sql
-- -----------------------------------------------------------------------------

-- 0004_functions_and_triggers.sql
-- Idempotent canonicalization, triggers, access helpers, invite acceptance, reminder claims, and multi-language search RPC.

-- 1. Canonicalize URL (exact parity with backend/Database/text_hygiene.py::canonicalize_url)
create or replace function private.canonicalize_url(raw_url text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  cleaned text;
  parts text[];
  scheme text;
  authority text;
  path_part text;
  query_part text;
  filtered_params text[];
  sorted_query text;
begin
  cleaned := btrim(coalesce(raw_url, ''));
  if cleaned = '' then
    return '';
  end if;

  -- Strip fragment (#...)
  cleaned := split_part(cleaned, '#', 1);

  parts := regexp_match(cleaned, '^(https?)://([^/?]+)(/[^?]*)?(?:\?(.*))?$', 'i');
  if parts is null then
    return cleaned;
  end if;

  scheme := lower(parts[1]);
  authority := lower(parts[2]);

  if scheme = 'http' and authority like '%:80' then
    authority := left(authority, length(authority) - 3);
  elsif scheme = 'https' and authority like '%:443' then
    authority := left(authority, length(authority) - 4);
  end if;

  path_part := regexp_replace(coalesce(parts[3], ''), '/+$', '');
  query_part := parts[4];

  if query_part is null or query_part = '' then
    return scheme || '://' || authority || path_part;
  end if;

  select array_agg(kv order by lower(split_part(kv, '=', 1)), kv)
    into filtered_params
    from unnest(string_to_array(query_part, '&')) as kv
   where kv <> ''
     and lower(split_part(kv, '=', 1)) <> ''
     and lower(split_part(kv, '=', 1)) not like 'utm\_%' escape '\'
     and lower(split_part(kv, '=', 1)) not in (
       'fbclid', 'gclid', 'dclid', 'msclkid',
       'mc_cid', 'mc_eid',
       'igshid', 'igsh', 'si',
       'ref', 'ref_src', 'ref_url',
       'yclid', '_ga', '_gl', 'spm',
       'is_from_webapp', 'sender_device'
     );

  if filtered_params is null or array_length(filtered_params, 1) is null then
    return scheme || '://' || authority || path_part;
  end if;

  sorted_query := array_to_string(filtered_params, '&');
  return scheme || '://' || authority || path_part || '?' || sorted_query;
end;
$$;

-- 2. Trigger: Auto-fill canonical_url and url_hash on items insert/update
create or replace function private.set_item_url_hash()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.canonical_url is null or btrim(new.canonical_url) = '' or (tg_op = 'UPDATE' and new.url is distinct from old.url and new.canonical_url is not distinct from old.canonical_url) then
    new.canonical_url := private.canonicalize_url(new.url);
  else
    new.canonical_url := private.canonicalize_url(new.canonical_url);
  end if;
  new.url_hash := md5(lower(new.canonical_url));
  return new;
end;
$$;

drop trigger if exists trg_items_set_url_hash on public.items;
create trigger trg_items_set_url_hash
  before insert or update of url, canonical_url on public.items
  for each row execute function private.set_item_url_hash();

-- 3. Trigger: Maintain updated_at
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_touch_updated_at on public.profiles;
create trigger trg_profiles_touch_updated_at
  before update on public.profiles
  for each row execute function private.touch_updated_at();

drop trigger if exists trg_folders_touch_updated_at on public.folders;
create trigger trg_folders_touch_updated_at
  before update on public.folders
  for each row execute function private.touch_updated_at();

drop trigger if exists trg_items_touch_updated_at on public.items;
create trigger trg_items_touch_updated_at
  before update on public.items
  for each row execute function private.touch_updated_at();

drop trigger if exists trg_reminders_touch_updated_at on public.reminders;
create trigger trg_reminders_touch_updated_at
  before update on public.reminders
  for each row execute function private.touch_updated_at();

-- 4. Trigger: Auto-provision public.profiles row on auth.users signup
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- 5. Trigger: Auto-cancel pending reminders when item transitions to done or archived
create or replace function private.cancel_reminders_on_item_done()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('done', 'archived') and old.status is distinct from new.status then
    update public.reminders
       set status = 'cancelled',
           updated_at = now()
     where item_id = new.id
       and status = 'pending';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_items_cancel_reminders on public.items;
create trigger trg_items_cancel_reminders
  after update of status on public.items
  for each row execute function private.cancel_reminders_on_item_done();

-- 5b. Security Triggers: Protect profiles.tier and items.owner_id / items.folder_id from client tampering
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

drop trigger if exists trg_profiles_guard_tier on public.profiles;
create trigger trg_profiles_guard_tier
  before insert or update on public.profiles
  for each row execute function private.guard_profile_tier();

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

drop trigger if exists trg_items_guard_ownership on public.items;
create trigger trg_items_guard_ownership
  before update on public.items
  for each row execute function private.guard_item_ownership();

-- 6. Helper: Shared folder access check for RLS policies
create or replace function private.can_access_folder(
  fid uuid,
  min_role public.folder_role default 'viewer'
)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.folders f
     where f.id = fid
       and f.owner_id = (select auth.uid())
  ) or exists (
    select 1
      from public.folder_members m
     where m.folder_id = fid
       and m.user_id = (select auth.uid())
       and (min_role = 'viewer' or m.role in ('owner', 'editor'))
  );
$$;

grant usage on schema private to authenticated;
grant execute on function private.can_access_folder(uuid, public.folder_role) to authenticated;

-- 7. RPC: Atomic shared folder invite acceptance (for authenticated client & service_role proxy)
create or replace function public.accept_invite_for_user(p_user_id uuid, invite_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite record;
  v_owner_id uuid;
begin
  if p_user_id is null then
    raise exception 'Authentication required';
  end if;

  select *
    into v_invite
    from public.folder_invites
   where token = invite_token
   for update;

  if not found then
    raise exception 'Invite not found';
  end if;

  if v_invite.revoked_at is not null then
    raise exception 'Invite has been revoked';
  end if;

  if v_invite.expires_at <= now() then
    raise exception 'Invite has expired';
  end if;

  if v_invite.max_uses is not null and v_invite.use_count >= v_invite.max_uses then
    raise exception 'Invite max uses exceeded';
  end if;

  if v_invite.role = 'owner' then
    raise exception 'Owner role cannot be granted via invite';
  end if;

  select owner_id into v_owner_id
    from public.folders
   where id = v_invite.folder_id;

  if v_owner_id is distinct from p_user_id then
    insert into public.folder_members (folder_id, user_id, role)
    values (v_invite.folder_id, p_user_id, v_invite.role)
    on conflict (folder_id, user_id) do update
      set role = case
        when public.folder_members.role = 'owner'::public.folder_role then 'owner'::public.folder_role
        else excluded.role
      end;
  end if;

  update public.folder_invites
     set use_count = use_count + 1
   where token = invite_token;

  return jsonb_build_object(
    'status', 'accepted',
    'folder_id', v_invite.folder_id,
    'role', case when v_owner_id = p_user_id then 'owner' else v_invite.role::text end
  );
end;
$$;

revoke all on function public.accept_invite_for_user(uuid, text) from PUBLIC, anon, authenticated;
grant execute on function public.accept_invite_for_user(uuid, text) to service_role;

create or replace function public.accept_invite(invite_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.accept_invite_for_user(auth.uid(), invite_token);
end;
$$;

revoke all on function public.accept_invite(text) from PUBLIC, anon;
grant execute on function public.accept_invite(text) to authenticated;

-- 8. RPC: Atomic claim_due_reminders (service_role only, DST-safe every_n_days advance)
create or replace function public.claim_due_reminders(batch_limit int default 100)
returns table (
  reminder_id uuid,
  item_id uuid,
  user_id uuid,
  title_snapshot text,
  schedule_type public.reminder_schedule_type,
  repeat_every_days int,
  fired_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  rec record;
  next_local_date date;
  next_ts timestamptz;
begin
  for rec in
    select r.*
      from public.reminders r
     where r.status = 'pending'
       and r.remind_at <= now()
     order by r.remind_at asc
     limit batch_limit
     for update skip locked
  loop
    if rec.schedule_type = 'every_n_days'::public.reminder_schedule_type
       and rec.repeat_every_days is not null
       and rec.remind_time is not null then
      next_local_date := (rec.remind_at at time zone rec.timezone)::date + rec.repeat_every_days;
      next_ts := (next_local_date::timestamp + rec.remind_time) at time zone rec.timezone;
      while next_ts <= now() loop
        next_local_date := next_local_date + rec.repeat_every_days;
        next_ts := (next_local_date::timestamp + rec.remind_time) at time zone rec.timezone;
      end loop;

      update public.reminders
         set remind_at = next_ts,
             last_triggered_at = now(),
             sent_at = now(),
             updated_at = now()
       where id = rec.id;
    else
      update public.reminders
         set status = 'sent'::public.reminder_status,
             last_triggered_at = now(),
             sent_at = now(),
             updated_at = now()
       where id = rec.id;
    end if;

    reminder_id := rec.id;
    item_id := rec.item_id;
    user_id := rec.user_id;
    title_snapshot := rec.title_snapshot;
    schedule_type := rec.schedule_type;
    repeat_every_days := rec.repeat_every_days;
    fired_at := now();
    return next;
  end loop;
end;
$$;

revoke all on function public.claim_due_reminders(int) from PUBLIC, anon, authenticated;
grant execute on function public.claim_due_reminders(int) to service_role;

-- 9. RPC: Multi-language 4-field search (FTS + pg_trgm substring across owned + shared items)
create or replace function public.search_user_items(
  search_query text default null,
  filter_status public.item_status default null,
  filter_folder_id uuid default null,
  filter_platform text default null,
  filter_content_type text default null,
  result_limit int default 20,
  result_offset int default 0
)
returns setof public.items
language sql
security invoker
stable
set search_path = ''
as $$
  select i.*
    from public.items i
   where (
     i.owner_id = (select auth.uid())
     or (i.folder_id is not null and (select private.can_access_folder(i.folder_id)))
   )
     and (filter_status is null or i.status = filter_status)
     and (filter_folder_id is null or i.folder_id = filter_folder_id)
     and (filter_platform is null or i.platform = filter_platform)
     and (filter_content_type is null or i.content_type = filter_content_type)
     and (
       search_query is null
       or btrim(search_query) = ''
       or i.search_tsv @@ plainto_tsquery('simple', btrim(search_query))
       or (
         coalesce(i.title, '') || ' ' ||
         coalesce(i.description, '') || ' ' ||
         coalesce(i.note, '') || ' ' ||
         coalesce(i.ai_summary, '')
       ) ilike '%' || btrim(search_query) || '%'
       or coalesce(i.url, '') ilike '%' || btrim(search_query) || '%'
     )
   order by i.saved_at desc, i.id desc
   limit greatest(1, least(coalesce(result_limit, 20), 100))
   offset greatest(0, coalesce(result_offset, 0));
$$;

revoke all on function public.search_user_items(text, public.item_status, uuid, text, text, int, int) from PUBLIC, anon;
grant execute on function public.search_user_items(text, public.item_status, uuid, text, text, int, int) to authenticated;


-- -----------------------------------------------------------------------------
-- SECTION: 0005_rls_policies.sql
-- -----------------------------------------------------------------------------

-- 0005_rls_policies.sql
-- Idempotent Row-Level Security policies for all 11 tables using (select auth.uid()) InitPlan optimization.

-- 1. profiles
alter table public.profiles enable row level security;
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (id = (select auth.uid()));
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert with check (id = (select auth.uid()));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- 2. folders
alter table public.folders enable row level security;
drop policy if exists folders_select on public.folders;
create policy folders_select on public.folders
  for select using (
    owner_id = (select auth.uid())
    or (select private.can_access_folder(id))
  );
drop policy if exists folders_insert on public.folders;
create policy folders_insert on public.folders
  for insert with check (owner_id = (select auth.uid()));
drop policy if exists folders_update on public.folders;
create policy folders_update on public.folders
  for update using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
drop policy if exists folders_delete on public.folders;
create policy folders_delete on public.folders
  for delete using (owner_id = (select auth.uid()));

-- 3. folder_members
alter table public.folder_members enable row level security;
drop policy if exists folder_members_select on public.folder_members;
create policy folder_members_select on public.folder_members
  for select using (
    user_id = (select auth.uid())
    or (select private.can_access_folder(folder_id))
  );
drop policy if exists folder_members_insert on public.folder_members;
create policy folder_members_insert on public.folder_members
  for insert with check (
    exists (
      select 1 from public.folders f
       where f.id = folder_id and f.owner_id = (select auth.uid())
    )
  );
drop policy if exists folder_members_update on public.folder_members;
create policy folder_members_update on public.folder_members
  for update using (
    exists (
      select 1 from public.folders f
       where f.id = folder_id and f.owner_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.folders f
       where f.id = folder_id and f.owner_id = (select auth.uid())
    )
  );
drop policy if exists folder_members_delete on public.folder_members;
create policy folder_members_delete on public.folder_members
  for delete using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.folders f
       where f.id = folder_id and f.owner_id = (select auth.uid())
    )
  );

-- 4. folder_invites (owner manages invites; invitees accept strictly via public.accept_invite RPC)
alter table public.folder_invites enable row level security;
drop policy if exists folder_invites_owner_all on public.folder_invites;
create policy folder_invites_owner_all on public.folder_invites
  for all using (
    exists (
      select 1 from public.folders f
       where f.id = folder_id and f.owner_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.folders f
       where f.id = folder_id and f.owner_id = (select auth.uid())
    )
  );

-- 5. items
alter table public.items enable row level security;
drop policy if exists items_select on public.items;
create policy items_select on public.items
  for select using (
    owner_id = (select auth.uid())
    or (folder_id is not null and (select private.can_access_folder(folder_id)))
  );
drop policy if exists items_insert on public.items;
create policy items_insert on public.items
  for insert with check (
    owner_id = (select auth.uid())
    and (folder_id is null or (select private.can_access_folder(folder_id, 'editor')))
  );
drop policy if exists items_update on public.items;
create policy items_update on public.items
  for update using (
    owner_id = (select auth.uid())
    or (folder_id is not null and (select private.can_access_folder(folder_id, 'editor')))
  )
  with check (
    (
      owner_id = (select auth.uid())
      and (folder_id is null or (select private.can_access_folder(folder_id, 'editor')))
    )
    or (
      folder_id is not null
      and (select private.can_access_folder(folder_id, 'editor'))
    )
  );
drop policy if exists items_delete on public.items;
create policy items_delete on public.items
  for delete using (owner_id = (select auth.uid()));

-- 6. tags
alter table public.tags enable row level security;
drop policy if exists tags_owner_all on public.tags;
create policy tags_owner_all on public.tags
  for all using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- 7. item_tags
alter table public.item_tags enable row level security;
drop policy if exists item_tags_select on public.item_tags;
create policy item_tags_select on public.item_tags
  for select using (
    exists (
      select 1 from public.items i
       where i.id = item_id
         and (
           i.owner_id = (select auth.uid())
           or (i.folder_id is not null and (select private.can_access_folder(i.folder_id)))
         )
    )
  );
drop policy if exists item_tags_insert on public.item_tags;
create policy item_tags_insert on public.item_tags
  for insert with check (
    exists (
      select 1 from public.items i
       where i.id = item_id
         and (
           i.owner_id = (select auth.uid())
           or (i.folder_id is not null and (select private.can_access_folder(i.folder_id, 'editor')))
         )
    )
    and exists (
      select 1 from public.tags t
       where t.id = tag_id and t.owner_id = (select auth.uid())
    )
  );
drop policy if exists item_tags_delete on public.item_tags;
create policy item_tags_delete on public.item_tags
  for delete using (
    exists (
      select 1 from public.items i
       where i.id = item_id
         and (
           i.owner_id = (select auth.uid())
           or (i.folder_id is not null and (select private.can_access_folder(i.folder_id, 'editor')))
         )
    )
  );

-- 8. reminders
alter table public.reminders enable row level security;
drop policy if exists reminders_select on public.reminders;
create policy reminders_select on public.reminders
  for select using (user_id = (select auth.uid()));
drop policy if exists reminders_insert on public.reminders;
create policy reminders_insert on public.reminders
  for insert with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.items i
       where i.id = item_id
         and (
           i.owner_id = (select auth.uid())
           or (i.folder_id is not null and (select private.can_access_folder(i.folder_id)))
         )
    )
  );
drop policy if exists reminders_update on public.reminders;
create policy reminders_update on public.reminders
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
drop policy if exists reminders_delete on public.reminders;
create policy reminders_delete on public.reminders
  for delete using (user_id = (select auth.uid()));

-- 9. devices
alter table public.devices enable row level security;
drop policy if exists devices_owner_all on public.devices;
create policy devices_owner_all on public.devices
  for all using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 10. daily_ai_usage (read-only for owner; service_role manages counters)
alter table public.daily_ai_usage enable row level security;
drop policy if exists daily_ai_usage_select on public.daily_ai_usage;
create policy daily_ai_usage_select on public.daily_ai_usage
  for select using (user_id = (select auth.uid()));

-- 11. api_tokens
alter table public.api_tokens enable row level security;
drop policy if exists api_tokens_owner_all on public.api_tokens;
create policy api_tokens_owner_all on public.api_tokens
  for all using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));


-- -----------------------------------------------------------------------------
-- SECTION: 0006_storage_realtime_and_cron.sql
-- -----------------------------------------------------------------------------

-- 0006_storage_realtime_and_cron.sql
-- Idempotent Part 4 Cloud Setup & Backend Parity RPCs:
--   1. public.beta_feedback table + (select auth.uid()) RLS (REQ-005)
--   2. public.increment_monthly_ai_usage atomic quota RPC (service_role)
--   3. public.search_user_items_for_user keyset-paginated search RPC (service_role)
--   4. storage.buckets 'thumbnails' + storage.objects RLS policies
--   5. supabase_realtime publication tables
--   6. private.app_config + DB Webhook trigger + pg_cron schedules

-- =====================================================================
-- 1. Beta Feedback / Waitlist Table (REQ-005)
-- =====================================================================
create table if not exists public.beta_feedback (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  category      text not null default 'general'
                  check (category in ('bug', 'feature', 'waitlist', 'general')),
  message       text not null check (char_length(message) between 3 and 2000),
  contact_email text,
  allow_contact boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists idx_beta_feedback_user_created
  on public.beta_feedback (user_id, created_at desc);

alter table public.beta_feedback enable row level security;

drop policy if exists "beta_feedback_select_own" on public.beta_feedback;
create policy "beta_feedback_select_own" on public.beta_feedback
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "beta_feedback_insert_own" on public.beta_feedback;
create policy "beta_feedback_insert_own" on public.beta_feedback
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- =====================================================================
-- 2. Atomic Monthly AI Quota Increment RPC (service_role only)
-- =====================================================================
create or replace function public.increment_monthly_ai_usage(
  p_user_id uuid,
  p_usage_month text,
  p_limit int default 50
)
returns table (request_count int)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  insert into public.daily_ai_usage (user_id, usage_month, request_count, last_used_at)
  values (p_user_id, p_usage_month, 1, now())
  on conflict (user_id, usage_month) do update
    set request_count = public.daily_ai_usage.request_count + 1,
        last_used_at = now()
  where public.daily_ai_usage.request_count < greatest(1, p_limit)
  returning public.daily_ai_usage.request_count;
end;
$$;

revoke all on function public.increment_monthly_ai_usage(uuid, text, int) from PUBLIC, anon, authenticated;
grant execute on function public.increment_monthly_ai_usage(uuid, text, int) to service_role;

-- =====================================================================
-- 3. Service-Role Multi-Language Search + Keyset Pagination RPC
-- =====================================================================
create or replace function public.search_user_items_for_user(
  p_user_id uuid,
  p_query text default null,
  p_folder_id uuid default null,
  p_tag_name text default null,
  p_status public.item_status default null,
  p_platform text default null,
  p_content_type text default null,
  p_cursor_saved_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit int default 20,
  p_offset int default 0
)
returns setof public.items
language sql
security definer
stable
set search_path = ''
as $$
  select i.*
    from public.items i
   where (
     i.owner_id = p_user_id
     or (
       i.folder_id is not null
       and (
         exists (
           select 1 from public.folders f
            where f.id = i.folder_id and f.owner_id = p_user_id
         )
         or exists (
           select 1 from public.folder_members m
            where m.folder_id = i.folder_id and m.user_id = p_user_id
         )
       )
     )
   )
     and (p_status is null or i.status = p_status)
     and (p_folder_id is null or i.folder_id = p_folder_id)
     and (p_platform is null or i.platform = p_platform)
     and (p_content_type is null or i.content_type = p_content_type)
     and (
       p_tag_name is null
       or btrim(p_tag_name) = ''
       or exists (
         select 1
           from public.item_tags it
           join public.tags t on t.id = it.tag_id
          where it.item_id = i.id
            and lower(t.name) = lower(btrim(p_tag_name))
       )
     )
     and (
       p_query is null
       or btrim(p_query) = ''
       or i.search_tsv @@ plainto_tsquery('simple', btrim(p_query))
       or (
         coalesce(i.title, '') || ' ' ||
         coalesce(i.description, '') || ' ' ||
         coalesce(i.note, '') || ' ' ||
         coalesce(i.ai_summary, '')
       ) ilike '%' || btrim(p_query) || '%'
       or coalesce(i.url, '') ilike '%' || btrim(p_query) || '%'
     )
     and (
       p_cursor_saved_at is null
       or p_cursor_id is null
       or (i.saved_at, i.id) < (p_cursor_saved_at, p_cursor_id)
     )
   order by i.saved_at desc, i.id desc
   limit greatest(1, least(coalesce(p_limit, 20), 100))
   offset case
     when p_cursor_saved_at is not null and p_cursor_id is not null then 0
     else greatest(0, coalesce(p_offset, 0))
   end;
$$;

revoke all on function public.search_user_items_for_user(uuid, text, uuid, text, public.item_status, text, text, timestamptz, uuid, int, int) from PUBLIC, anon, authenticated;
grant execute on function public.search_user_items_for_user(uuid, text, uuid, text, public.item_status, text, text, timestamptz, uuid, int, int) to service_role;

-- =====================================================================
-- 4. Supabase Storage: 'thumbnails' Public Bucket & Write Policies
-- =====================================================================
do $$
begin
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'storage' and table_name = 'buckets'
  ) then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'thumbnails',
      'thumbnails',
      true,
      2097152,
      array['image/webp', 'image/jpeg', 'image/png']
    )
    on conflict (id) do update
      set public = excluded.public,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if exists (
    select 1 from information_schema.tables
     where table_schema = 'storage' and table_name = 'objects'
  ) then
    execute 'drop policy if exists "thumbnails_public_read" on storage.objects';
    execute 'create policy "thumbnails_public_read" on storage.objects for select to public using (bucket_id = ''thumbnails'')';

    execute 'drop policy if exists "thumbnails_service_write" on storage.objects';
    execute 'create policy "thumbnails_service_write" on storage.objects for all to service_role using (bucket_id = ''thumbnails'') with check (bucket_id = ''thumbnails'')';
  end if;
end
$$;

-- =====================================================================
-- 5. Supabase Realtime Publication (items, folders, folder_members, reminders)
-- =====================================================================
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

-- =====================================================================
-- 6. Webhook Config, Item-Created Trigger & pg_cron Schedules
-- =====================================================================
create table if not exists private.app_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

revoke all on table private.app_config from PUBLIC, anon, authenticated;

create or replace function private.invoke_backend_endpoint(
  p_path text,
  p_header_name text,
  p_secret_key text,
  p_body jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base_url text;
  v_secret text;
  v_headers jsonb;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return;
  end if;

  select value into v_base_url from private.app_config where key = 'backend_base_url';
  if v_base_url is null or btrim(v_base_url) = '' then
    return;
  end if;

  select value into v_secret from private.app_config where key = p_secret_key;
  v_headers := jsonb_build_object('Content-Type', 'application/json');
  if v_secret is not null and btrim(v_secret) <> '' then
    v_headers := v_headers || jsonb_build_object(p_header_name, v_secret);
  end if;

  perform net.http_post(
    url := rtrim(v_base_url, '/') || p_path,
    headers := v_headers,
    body := coalesce(p_body, '{}'::jsonb)
  );
end;
$$;

revoke all on function private.invoke_backend_endpoint(text, text, text, jsonb) from PUBLIC, anon, authenticated;

create or replace function private.trg_items_after_insert_webhook()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.invoke_backend_endpoint(
    '/hooks/item-created',
    'X-Webhook-Secret',
    'webhook_secret',
    jsonb_build_object('type', 'INSERT', 'table', 'items', 'record', to_jsonb(new))
  );
  return new;
end;
$$;

drop trigger if exists trg_items_created_webhook on public.items;
create trigger trg_items_created_webhook
  after insert on public.items
  for each row execute function private.trg_items_after_insert_webhook();

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'just_save_it_cron_reminders') then
      perform cron.unschedule('just_save_it_cron_reminders');
    end if;
    perform cron.schedule(
      'just_save_it_cron_reminders',
      '* * * * *',
      $cron$select private.invoke_backend_endpoint('/cron/reminders', 'X-Cron-Secret', 'cron_secret', '{}'::jsonb);$cron$
    );

    if exists (select 1 from cron.job where jobname = 'just_save_it_cron_retry_enrich') then
      perform cron.unschedule('just_save_it_cron_retry_enrich');
    end if;
    perform cron.schedule(
      'just_save_it_cron_retry_enrich',
      '*/10 * * * *',
      $cron$select private.invoke_backend_endpoint('/cron/retry-enrich', 'X-Webhook-Secret', 'webhook_secret', '{}'::jsonb);$cron$
    );
  end if;
end
$$;
