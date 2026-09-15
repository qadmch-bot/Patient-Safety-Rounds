-- =====================================================================
-- Patient Safety Rounds — migration 002
-- Adds the columns needed for: QPS observation review, department-grouped
-- findings, corrective-plan secure upload/review, and effectiveness
-- verification. Purely additive — safe to run after 001_init_schema.sql,
-- and safe to re-run (every statement uses IF NOT EXISTS).
-- =====================================================================

alter table improvement_plans add column if not exists plan_comment text;
alter table improvement_plans add column if not exists verified_by text;
alter table improvement_plans add column if not exists verification_date date;
alter table improvement_plans add column if not exists verification_result text; -- Effective | Partially Effective | Not Effective | Requires Further Action
alter table improvement_plans add column if not exists verification_comments text;
alter table improvement_plans add column if not exists evidence_reviewed boolean not null default false;
alter table improvement_plans add column if not exists effectiveness_confirmed boolean not null default false;
alter table improvement_plans add column if not exists closure_date date;
alter table improvement_plans add column if not exists last_reminder_type text;
alter table improvement_plans add column if not exists last_reminder_sent_at timestamptz;

alter table findings add column if not exists responsible_member_id bigint references round_members(id);
create index if not exists observations_status_dept_idx on observations (status, department);
create index if not exists findings_status_idx on findings (status);
create index if not exists improvement_plans_status_due_idx on improvement_plans (status, due_date);

-- File storage note: plan_file_url / evidence.file_url store the uploaded
-- file as a base64 data: URI directly in Postgres for this delivery, to
-- avoid requiring a separate Supabase Storage bucket to be provisioned.
-- This is real, persisted storage (not simulated) but is best swapped for
-- Supabase Storage (or S3) once file sizes/volume justify it — the API
-- contract (plan_file_url is "a URL the browser can open") does not change
-- if you do that later.
