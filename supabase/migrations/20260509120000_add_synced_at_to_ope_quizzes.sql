alter table public.ope_quizzes
  add column if not exists synced_at timestamptz;

create index if not exists ope_quizzes_synced_at_idx on public.ope_quizzes (synced_at desc);
