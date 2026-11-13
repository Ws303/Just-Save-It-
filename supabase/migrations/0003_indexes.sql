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
