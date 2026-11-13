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
