-- Out-of-bounds question log for the Foodie Coaches Marketing AI.
-- Run this in the Supabase web SQL editor of the NEW project created for this tool.
-- Plain SQL only (no psql meta-commands).
--
-- Privacy posture (locked): we store question text, route, deferral, modules and the prompt
-- version only. No IPs, no member identifiers, no conversation history.

create table if not exists oob_questions (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  question       text        not null,
  route          text        not null check (route in ('oob', 'partial')),
  deferral       text        not null check (deferral in ('none', 'monday_call', 'coach', 'people_assistant')),
  modules        text[]      not null default '{}',
  prompt_version text        not null
);

-- The Monday-call review reads newest first.
create index if not exists oob_questions_created_at_idx on oob_questions (created_at desc);

-- Belt and braces: RLS on, no policies. The Worker uses the service-role key, which bypasses
-- RLS, so inserts still work; the anon/public key can read or write nothing.
alter table oob_questions enable row level security;

-- Verify after deploy (run as its own statement):
--   select * from oob_questions order by created_at desc limit 5;
