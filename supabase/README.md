# Just-Save-It Supabase Migrations

Idempotent PostgreSQL migrations for Parts 1 & 4 (12 tables including `beta_feedback`, RLS with `(select auth.uid())`, multi-language FTS + `pg_trgm` indexes, keyset pagination & atomic quota RPCs, `thumbnails` Storage bucket, `supabase_realtime`, and `pg_cron` / webhook dispatch).

## Apply via Supabase CLI

```powershell
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>
supabase db push
```

## Apply Manually via Supabase Dashboard SQL Editor

Run the files in strict numerical order (`0001` through `0007`), then reload the PostgREST schema cache (`NOTIFY pgrst, 'reload schema';`):

1. `supabase/migrations/0001_extensions_and_types.sql`
2. `supabase/migrations/0002_core_tables.sql`
3. `supabase/migrations/0003_indexes.sql`
4. `supabase/migrations/0004_functions_and_triggers.sql`
5. `supabase/migrations/0005_rls_policies.sql`
6. `supabase/migrations/0006_storage_realtime_and_cron.sql`
7. `supabase/migrations/0007_ui_parity_fixes.sql` (additive `items.is_favorite` + partial index & `folders.cover_url` parity migration)

All migrations are idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP ... IF EXISTS`).

## Configure Cloud Webhooks & `pg_cron` Endpoint Secrets

After applying `0006_storage_realtime_and_cron.sql` in Supabase Cloud (ensure `pg_net` and `pg_cron` extensions are enabled in Database > Extensions), populate `private.app_config` once:

```sql
insert into private.app_config (key, value) values
  ('backend_base_url', 'https://your-fastapi-domain.example.com'),
  ('webhook_secret', '<SAME AS INTERNAL_WEBHOOK_SECRET>'),
  ('cron_secret', '<SAME AS INTERNAL_WEBHOOK_SECRET>')
on conflict (key) do update set value = excluded.value, updated_at = now();
```

## Post-Apply Verification Queries

```sql
-- Verify all 12 tables exist and have RLS enabled
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in (
    'profiles', 'folders', 'folder_members', 'folder_invites',
    'items', 'tags', 'item_tags', 'reminders',
    'devices', 'daily_ai_usage', 'api_tokens', 'beta_feedback'
  )
order by tablename;

-- Verify service_role-only RPCs
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in ('claim_due_reminders', 'increment_monthly_ai_usage', 'search_user_items_for_user');
```
