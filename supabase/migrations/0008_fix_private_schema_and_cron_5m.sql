-- 0008_fix_private_schema_and_cron_5m.sql
-- Additive, idempotent cloud fixes:
-- 1. Grant schema private usage + trigger function execute to service_role (fixes 42501 on FastAPI writes)
-- 2. Reschedule pg_cron reminder sweep to every 5 minutes (*/5 * * * *)

grant usage on schema private to authenticated, service_role;

grant execute on function private.canonicalize_url(text) to authenticated, service_role;
grant execute on function private.set_item_url_hash() to authenticated, service_role;
grant execute on function private.touch_updated_at() to authenticated, service_role;
grant execute on function private.cancel_reminders_on_item_done() to authenticated, service_role;
grant execute on function private.guard_profile_tier() to authenticated, service_role;
grant execute on function private.guard_item_ownership() to authenticated, service_role;
grant execute on function private.can_access_folder(uuid, public.folder_role) to authenticated, service_role;

do $$
begin
  if to_regprocedure('private.trg_items_after_insert_webhook()') is not null then
    grant execute on function private.trg_items_after_insert_webhook() to authenticated, service_role;
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'just_save_it_cron_reminders') then
      perform cron.unschedule('just_save_it_cron_reminders');
    end if;
    perform cron.schedule(
      'just_save_it_cron_reminders',
      '*/5 * * * *',
      $cron$select private.invoke_backend_endpoint('/cron/reminders', 'X-Cron-Secret', 'cron_secret', '{}'::jsonb);$cron$
    );
  end if;
end
$$;
