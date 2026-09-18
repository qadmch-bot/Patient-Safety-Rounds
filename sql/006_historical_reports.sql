-- Historical official Patient Safety Round reports (real hospital records only).
create table if not exists historical_round_reports (
  id bigint generated always as identity primary key,
  round_id text,
  report_date date not null,
  departments text[] not null default '{}',
  title text not null,
  notes text,
  storage_bucket text not null default 'round-reports',
  storage_path text not null,
  file_name text not null,
  uploaded_by text,
  uploaded_at timestamptz not null default now()
);
create index if not exists historical_round_reports_date_idx on historical_round_reports(report_date desc);
alter table historical_round_reports enable row level security;
