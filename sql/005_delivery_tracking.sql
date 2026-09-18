-- WhatsApp delivery/read/failure tracking. Additive and safe to re-run.
alter table whatsapp_reminders add column if not exists delivered_at timestamptz;
alter table whatsapp_reminders add column if not exists read_at timestamptz;
alter table whatsapp_reminders add column if not exists failed_at timestamptz;
alter table whatsapp_reminders add column if not exists error_code text;

alter table whatsapp_manual_messages add column if not exists delivered_at timestamptz;
alter table whatsapp_manual_messages add column if not exists read_at timestamptz;
alter table whatsapp_manual_messages add column if not exists failed_at timestamptz;
alter table whatsapp_manual_messages add column if not exists error_code text;
alter table whatsapp_manual_messages add column if not exists updated_at timestamptz not null default now();

-- Secure-link activity, separate from WhatsApp delivery state.
create table if not exists secure_link_activity (
  id bigint generated always as identity primary key,
  link_type text not null check (link_type in ('round','plan')),
  entity_id text not null,
  recipient_name text,
  recipient_phone text,
  first_opened_at timestamptz not null default now(),
  last_opened_at timestamptz not null default now(),
  open_count integer not null default 1,
  action_completed_at timestamptz,
  unique(link_type, entity_id, recipient_phone)
);
create index if not exists secure_link_activity_entity_idx on secure_link_activity(link_type,entity_id);
