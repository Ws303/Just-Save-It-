-- =====================================================================
-- Just-Save-It: Supabase PostgreSQL Database Schema
-- Architecture Specification: PRODUCT_SPEC.md §7 & BACKEND_LOGIN_DB_PLAN.md
-- =====================================================================

-- ===== Extensions =====
create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm";
create extension if not exists "vector";

-- ===== Custom Enums =====
do $$ begin
  create type item_status as enum ('inbox', 'todo', 'done', 'archived');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type enrich_status as enum ('pending', 'unfurled', 'done', 'failed');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type folder_role as enum ('owner', 'editor', 'viewer');
exception
  when duplicate_object then null;
end $$;

-- ===== Profiles =====
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  tier text not null default 'free' check (tier in ('free', 'pro')),
  locale text not null default 'th',
  timezone text not null default 'Asia/Bangkok',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Trigger: auto-create profile on new user signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  raw_name text;
begin
  raw_name := coalesce(
    new.raw_user_meta_data->>'display_name',
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'name',
    split_part(new.email, '@', 1)
  );
  insert into public.profiles (id, display_name, avatar_url, tier, locale, timezone)
  values (
    new.id,
    raw_name,
    new.raw_user_meta_data->>'avatar_url',
    'free',
    'th',
    'Asia/Bangkok'
  )
  on conflict (id) do update set
    display_name = coalesce(excluded.display_name, public.profiles.display_name),
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===== Folders & Members (Shared) =====
create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  emoji text,
  cover_url text,
  is_shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.folder_members (
  folder_id uuid references public.folders(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  role folder_role not null default 'editor',
  joined_at timestamptz not null default now(),
  primary key (folder_id, user_id)
);

create table if not exists public.folder_invites (
  token text primary key default encode(gen_random_bytes(16), 'hex'),
  folder_id uuid not null references public.folders(id) on delete cascade,
  role folder_role not null default 'editor' check (role <> 'owner'),
  created_by uuid not null references public.profiles(id),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now()
);

-- ===== Items (Saved Links) =====
create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  folder_id uuid references public.folders(id) on delete set null,
  url text not null,
  url_hash text generated always as (md5(lower(url))) stored,
  title text,
  description text,
  image_url text,
  site_name text,
  favicon_url text,
  content_type text default 'link',
  platform text,
  note text,
  ai_summary text,
  ai_tags text[],
  favorite boolean not null default false,
  status item_status not null default 'inbox',
  enrich_status enrich_status not null default 'pending',
  enrich_attempts int not null default 0,
  saved_at timestamptz not null default now(),
  done_at timestamptz,
  search_tsv tsvector generated always as (
    to_tsvector('simple',
      coalesce(title, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(note, '') || ' ' ||
      coalesce(ai_summary, '') || ' ' ||
      url)
  ) stored,
  constraint uniq_owner_url unique (owner_id, url_hash)
);

create index if not exists items_owner_status_idx on public.items (owner_id, status, saved_at desc);
create index if not exists items_folder_idx on public.items (folder_id, saved_at desc);
create index if not exists items_tsv_idx on public.items using gin (search_tsv);
create index if not exists items_title_trgm_idx on public.items using gin (title gin_trgm_ops);

-- ===== Tags =====
create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  color text,
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

create table if not exists public.item_tags (
  item_id uuid references public.items(id) on delete cascade,
  tag_id uuid references public.tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (item_id, tag_id)
);

-- ===== Reminders =====
create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  remind_at timestamptz not null,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists reminders_due_idx on public.reminders (remind_at) where sent_at is null;

-- ===== Devices (Push Notifications) =====
create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text not null check (platform in ('android', 'ios', 'web', 'extension')),
  push_token text not null unique,
  last_seen timestamptz not null default now()
);

-- ===== API Tokens (Personal Access Tokens for MCP) =====
create table if not exists public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null unique,
  token_prefix text not null,
  name text not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- ===== AI Usage Tracking =====
create table if not exists public.daily_ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  usage_date date not null default current_date,
  count int not null default 0,
  unique (user_id, usage_date)
);

-- ===== Security Helper: Folder Access Check =====
create or replace function public.can_access_folder(fid uuid, min_role folder_role default 'viewer')
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.folders f where f.id = fid and f.owner_id = auth.uid()
  ) or exists (
    select 1 from public.folder_members m
    where m.folder_id = fid and m.user_id = auth.uid()
      and (min_role = 'viewer' or m.role in ('owner', 'editor'))
  );
$$;

-- ===== Accept Invite Helper =====
create or replace function public.accept_invite(invite_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  inv record;
  current_uid uuid;
  folder_name text;
begin
  current_uid := auth.uid();
  if current_uid is null then
    raise exception 'Unauthorized';
  end if;

  select * into inv from public.folder_invites
  where token = invite_token and expires_at > now();

  if not found then
    raise exception 'Invalid or expired invite token';
  end if;

  select name into folder_name from public.folders where id = inv.folder_id;

  insert into public.folder_members (folder_id, user_id, role)
  values (inv.folder_id, current_uid, inv.role)
  on conflict (folder_id, user_id) do update set role = excluded.role;

  return json_build_object(
    'folder_id', inv.folder_id,
    'folder_name', folder_name,
    'role', inv.role
  );
end;
$$;

-- ===== Enable Row Level Security (RLS) =====
alter table public.profiles enable row level security;
alter table public.folders enable row level security;
alter table public.folder_members enable row level security;
alter table public.folder_invites enable row level security;
alter table public.items enable row level security;
alter table public.tags enable row level security;
alter table public.item_tags enable row level security;
alter table public.reminders enable row level security;
alter table public.devices enable row level security;
alter table public.api_tokens enable row level security;
alter table public.daily_ai_usage enable row level security;

-- Profiles Policies
create policy profiles_select on public.profiles for select using (true);
create policy profiles_update on public.profiles for update using (id = auth.uid());

-- Items Policies
create policy items_select on public.items for select using (
  owner_id = auth.uid() or (folder_id is not null and can_access_folder(folder_id))
);
create policy items_insert on public.items for insert with check (
  owner_id = auth.uid() and (folder_id is null or can_access_folder(folder_id, 'editor'))
);
create policy items_update on public.items for update using (
  owner_id = auth.uid() or (folder_id is not null and can_access_folder(folder_id, 'editor'))
);
create policy items_delete on public.items for delete using (
  owner_id = auth.uid()
);
