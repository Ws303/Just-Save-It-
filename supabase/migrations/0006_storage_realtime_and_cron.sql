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

grant execute on function private.trg_items_after_insert_webhook() to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'just_save_it_cron_reminders') then
      perform cron.unschedule('just_save_it_cron_reminders');
    end if;
    perform cron.schedule(
      'just_save_it_cron_reminders',
      '*/5 * * * *',
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
