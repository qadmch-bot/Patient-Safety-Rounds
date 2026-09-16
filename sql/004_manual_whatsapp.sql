-- =====================================================================
-- Patient Safety Rounds — migration 004
-- Adds tables for the "Manual WhatsApp Send" admin feature. Purely
-- additive; does not touch the existing whatsapp_reminders (automatic
-- 24h/1h + plan reminders) table or its cron-driven behavior at all.
-- =====================================================================

create table if not exists whatsapp_manual_messages (
  id               bigint generated always as identity primary key,
  round_id         text,
  recipient_name   text,
  recipient_mobile text not null,
  language         text not null default 'ar',
  template_name    text not null,
  message_sid      text,
  status           text not null default 'pending', -- pending | sent | failed
  failure_reason   text,
  sent_by          text,
  sent_at          timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists whatsapp_manual_messages_round_idx on whatsapp_manual_messages (round_id);
create index if not exists whatsapp_manual_messages_status_idx on whatsapp_manual_messages (status);

-- Template approval tracking. This system cannot query Meta/Twilio's real
-- template-approval status automatically (that needs a separate Twilio
-- Content API integration, not built here) — Quality marks the status
-- here manually once a template is approved in the Twilio console, and
-- api/whatsapp-manual-send.js refuses to send against a non-Approved one.
create table if not exists whatsapp_templates (
  name       text primary key,
  status     text not null default 'Pending', -- Approved | Pending | Rejected
  language   text not null default 'ar',
  updated_at timestamptz not null default now()
);

insert into whatsapp_templates (name, status, language) values
  ('patient_safety_round_24h_reminder', 'Pending', 'ar'),
  ('patient_safety_round_1h_reminder', 'Pending', 'ar'),
  ('corrective_plan_request', 'Pending', 'ar'),
  ('corrective_plan_reminder', 'Pending', 'ar'),
  ('test_message', 'Pending', 'ar')
on conflict (name) do nothing;
