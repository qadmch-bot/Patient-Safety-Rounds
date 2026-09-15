-- =====================================================================
-- Patient Safety Rounds — Supabase schema migration
-- Maternity & Children Hospital — Hafr Al Batin Health Cluster
--
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query).
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / ON CONFLICT).
--
-- This migration is additive only — it does not touch or drop the existing
-- whatsapp_reminders table's data, it only ensures the columns
-- api/process-reminders.js already depends on are present.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. whatsapp_reminders  (already exists in production — declared here so
--    a fresh environment can be stood up identically; columns match
--    exactly what api/process-reminders.js already reads/writes)
-- ---------------------------------------------------------------------
create table if not exists whatsapp_reminders (
  id                 bigint generated always as identity primary key,
  round_id           text not null,
  department         text,
  recipient_name     text,
  recipient_phone    text not null,
  reminder_type      text not null,              -- '24h' | '1h' | 'test'
  message            text not null,
  event_key          text,                        -- round_id+recipient+reminder_type, for de-duplication
  status             text not null default 'pending', -- pending | processing | sent | failed | cancelled
  attempts           integer not null default 0,
  scheduled_at       timestamptz not null,
  processing_at      timestamptz,
  sent_at            timestamptz,
  twilio_message_sid text,
  error_message      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- De-duplication: one 24h / one 1h reminder per round+recipient (spec section 9 / 53)
create unique index if not exists whatsapp_reminders_event_key_uidx
  on whatsapp_reminders (event_key) where event_key is not null;

create index if not exists whatsapp_reminders_status_scheduled_idx
  on whatsapp_reminders (status, scheduled_at);

-- ---------------------------------------------------------------------
-- 2. round_members  ("Patient Safety Rounds Members" — spec section 4)
-- ---------------------------------------------------------------------
create table if not exists round_members (
  id                  bigint generated always as identity primary key,
  full_name           text not null,
  job_title           text,
  department          text,                       -- department code, or 'ALL'
  mobile              text,                        -- +9665XXXXXXXX
  preferred_language  text not null default 'ar',  -- 'ar' | 'en'
  whatsapp_enabled    boolean not null default false,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. rounds  (Patient Safety Rounds — spec section 6)
-- ---------------------------------------------------------------------
create table if not exists rounds (
  id                       text primary key,        -- e.g. 'PSR-2026-013'
  departments              text[] not null default '{}',
  planned_date             date not null,
  planned_time             time not null default '10:00',
  team                     text,
  lead_reviewer            text,
  department_representative text,
  notes                    text,
  status                   text not null default 'Scheduled',
    -- Scheduled | Reminder Sent | Ready | In Progress | Awaiting QPS Review |
    -- Findings Approved | Corrective Actions Open | Follow-up | Completed |
    -- Cancelled | Rescheduled
  secure_token             text unique,              -- opaque token for the no-login round link
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists rounds_planned_date_idx on rounds (planned_date);

-- ---------------------------------------------------------------------
-- 4. round_participants  (which members are assigned to which round)
-- ---------------------------------------------------------------------
create table if not exists round_participants (
  round_id   text not null references rounds(id) on delete cascade,
  member_id  bigint not null references round_members(id) on delete cascade,
  primary key (round_id, member_id)
);

-- ---------------------------------------------------------------------
-- 5. observations  (raw member submissions — "Submitted for QPS Review")
-- ---------------------------------------------------------------------
create table if not exists observations (
  id                    bigint generated always as identity primary key,
  round_id              text not null references rounds(id) on delete cascade,
  member_name           text,
  member_role           text,
  department            text not null,
  domain                text not null,              -- QMPS | PHARM | LAB | FMS | HR | IPCD | NURSING
  checklist_item        text not null,
  observation_text      text not null,
  location              text,
  immediate_action      text,
  suggested_action      text,
  evidence_url          text,
  status                text not null default 'Submitted for QPS Review',
    -- Submitted for QPS Review | Approved | Rejected | Clarification Requested
  qps_reviewer           text,
  qps_decision_notes     text,
  qps_decision_at        timestamptz,
  risk_level             text,                        -- Low | Moderate | High | Critical
  responsible_department text,
  responsible_person     text,
  corrective_required    boolean,
  submitted_at           timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists observations_round_idx on observations (round_id);
create index if not exists observations_status_idx on observations (status);

-- ---------------------------------------------------------------------
-- 6. findings  (created only from an APPROVED observation)
-- ---------------------------------------------------------------------
create table if not exists findings (
  id                      bigint generated always as identity primary key,
  observation_id          bigint not null references observations(id) on delete cascade,
  round_id                text not null references rounds(id) on delete cascade,
  department              text not null,
  domain                  text not null,
  checklist_item          text,
  risk_level              text not null,
  responsible_department  text,
  responsible_person      text,
  corrective_required     boolean not null default false,
  is_recurring            boolean not null default false,
  status                  text not null default 'Approved',
    -- Approved | Plan Requested | Plan Submitted | Plan Revision Required |
    -- Plan Accepted | Implementation | Evidence Submitted | Under Verification |
    -- Effective | Ineffective | Closed | Reopened
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists findings_round_idx on findings (round_id);
create index if not exists findings_department_domain_idx on findings (department, domain, checklist_item);

-- ---------------------------------------------------------------------
-- 7. improvement_plans
-- ---------------------------------------------------------------------
create table if not exists improvement_plans (
  id                 bigint generated always as identity primary key,
  finding_id          bigint not null references findings(id) on delete cascade,
  start_date          date,                          -- day after the round
  due_date            date,                          -- 1 day before next round for same dept (or manual override)
  due_date_is_manual  boolean not null default false,
  due_date_override_reason text,
  plan_file_name      text,
  plan_file_url        text,
  plan_uploaded_by     text,
  plan_uploaded_at     timestamptz,
  plan_version         integer not null default 0,
  status               text not null default 'Plan Requested',
  secure_token         text unique,                  -- opaque token for the no-login plan-upload link
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 8. evidence
-- ---------------------------------------------------------------------
create table if not exists evidence (
  id                  bigint generated always as identity primary key,
  plan_id             bigint not null references improvement_plans(id) on delete cascade,
  file_name           text not null,
  file_url            text not null,
  description         text,
  category             text,
  uploaded_by          text,
  uploaded_at          timestamptz not null default now(),
  verification_status  text not null default 'Pending' -- Pending | Accepted | Rejected
);

-- ---------------------------------------------------------------------
-- 9. audit_trail
-- ---------------------------------------------------------------------
create table if not exists audit_trail (
  id             bigint generated always as identity primary key,
  action         text not null,
  entity_type    text not null,          -- round | member | observation | finding | plan | evidence | reminder
  entity_id      text,
  actor          text,
  previous_value jsonb,
  new_value      jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists audit_trail_entity_idx on audit_trail (entity_type, entity_id);

-- ---------------------------------------------------------------------
-- Row Level Security
-- All writes go through the Vercel serverless functions using the
-- SUPABASE_SECRET_KEY (service role), which bypasses RLS by design.
-- The browser never talks to Supabase directly, so RLS below simply
-- makes sure that remains true even if a key is ever mis-scoped later:
-- no anonymous/public role has any access.
-- ---------------------------------------------------------------------
alter table whatsapp_reminders  enable row level security;
alter table round_members       enable row level security;
alter table rounds              enable row level security;
alter table round_participants  enable row level security;
alter table observations        enable row level security;
alter table findings            enable row level security;
alter table improvement_plans   enable row level security;
alter table evidence            enable row level security;
alter table audit_trail         enable row level security;

-- (No policies are created for anon/authenticated roles — service-role
--  requests from the API routes bypass RLS automatically and are the
--  only intended access path.)
