-- Department corrective-plan response fields.
-- Additive / idempotent: safe to run after migrations 001-006.
alter table improvement_plans add column if not exists root_cause text;
alter table improvement_plans add column if not exists corrective_action text;
alter table improvement_plans add column if not exists preventive_action text;
alter table improvement_plans add column if not exists department_responsible_person text;
alter table improvement_plans add column if not exists department_submitted_at timestamptz;
