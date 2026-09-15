-- =====================================================================
-- Patient Safety Rounds — migration 003
-- Moves file storage from base64-in-Postgres to Supabase Storage.
-- Run this BEFORE any real files are uploaded (i.e. before go-live) —
-- since this system has not been deployed yet, there is no base64 data
-- to migrate, so this is purely additive/structural.
-- =====================================================================

alter table improvement_plans add column if not exists plan_storage_bucket text;
alter table improvement_plans add column if not exists plan_storage_path text;
-- plan_file_url is kept only as a legacy column (no longer written to) so
-- nothing breaks if it's still referenced anywhere; new code uses
-- plan_storage_bucket + plan_storage_path and resolves a short-lived
-- signed URL at read time (see lib/storage.js). It is safe to drop this
-- column later with: alter table improvement_plans drop column plan_file_url;

alter table evidence add column if not exists storage_bucket text;
alter table evidence add column if not exists storage_path text;
-- file_url is likewise kept as a legacy/unused column; new code uses
-- storage_bucket + storage_path. Safe to drop later with:
-- alter table evidence drop column file_url;

-- Required Supabase Storage buckets (created automatically, idempotently,
-- by the API the first time it's used — see lib/storage.js — but you can
-- also create them manually in the Supabase Dashboard → Storage):
--   corrective-plans   (private)
--   evidence           (private)
-- Both must be PRIVATE. The app never marks them public and never returns
-- a permanent public URL — only short-lived signed URLs generated
-- server-side with the service-role key, which never reaches the browser.
