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
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role' then
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
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role' then
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
