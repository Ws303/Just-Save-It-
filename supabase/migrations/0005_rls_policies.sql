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
