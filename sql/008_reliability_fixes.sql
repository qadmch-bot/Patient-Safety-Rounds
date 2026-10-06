-- Patient Safety Rounds — reliability fixes
-- Run once in Supabase SQL Editor after deploying this version.

-- Storage migration compatibility: signed URLs are generated server-side.
-- The legacy file_url column must not block inserts that use storage_path.
alter table if exists evidence alter column file_url drop not null;

-- One finding per submitted observation. Prevents duplicate corrective plans
-- and duplicate WhatsApp plan requests even if the approval request is retried.
create unique index if not exists findings_observation_uidx
  on findings (observation_id)
  where observation_id is not null;

-- One corrective plan per finding.
create unique index if not exists improvement_plans_finding_uidx
  on improvement_plans (finding_id);

-- Keep reminder idempotency enforced at the database layer.
create unique index if not exists whatsapp_reminders_event_key_uidx
  on whatsapp_reminders (event_key)
  where event_key is not null;
