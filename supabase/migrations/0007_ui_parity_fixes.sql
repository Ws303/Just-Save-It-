-- 0007_ui_parity_fixes.sql
-- Additive, idempotent schema parity fixes for live Cloud deployments.

-- 1. Ensure items.is_favorite exists even on databases provisioned before 0002 updated.
alter table if exists public.items
  add column if not exists is_favorite boolean not null default false;

create index if not exists idx_items_owner_favorite_saved_at
  on public.items (owner_id, is_favorite, saved_at desc)
  where is_favorite = true;

-- 2. Persist selected folder cover preset/URL in public.folders.
alter table if exists public.folders
  add column if not exists cover_url text;
