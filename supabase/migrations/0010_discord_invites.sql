-- 0010_discord_invites.sql
-- Idempotent migration enabling Discord-style folder invite expiration presets
-- (including "never expires" with expires_at IS NULL).

alter table if exists public.folder_invites
  alter column expires_at drop not null;

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

  if v_invite.expires_at is not null and v_invite.expires_at <= now() then
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
