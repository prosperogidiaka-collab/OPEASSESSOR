create table if not exists public.ope_quizzes (
  quiz_id text primary key,
  teacher_id text not null default '',
  title text not null default '',
  created_at timestamptz,
  updated_at timestamptz,
  synced_at timestamptz,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists ope_quizzes_teacher_id_idx on public.ope_quizzes (teacher_id);
create index if not exists ope_quizzes_updated_at_idx on public.ope_quizzes (updated_at);
create index if not exists ope_quizzes_synced_at_idx on public.ope_quizzes (synced_at desc);

create table if not exists public.ope_submissions (
  submission_id text primary key,
  quiz_id text not null default '',
  student_email text not null default '',
  submitted_at timestamptz,
  updated_at timestamptz,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists ope_submissions_quiz_id_idx on public.ope_submissions (quiz_id);
create index if not exists ope_submissions_student_email_idx on public.ope_submissions (student_email);
create index if not exists ope_submissions_submitted_at_idx on public.ope_submissions (submitted_at);

create table if not exists public.ope_teachers (
  teacher_id text primary key,
  email text not null default '',
  role text not null default 'teacher',
  created_at timestamptz,
  updated_at timestamptz,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists ope_teachers_email_idx on public.ope_teachers (email);
create index if not exists ope_teachers_updated_at_idx on public.ope_teachers (updated_at);

create table if not exists public.ope_students (
  teacher_id text not null,
  student_key text not null,
  name text not null default '',
  email text not null default '',
  registration_no text not null default '',
  uploaded_at timestamptz,
  updated_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  primary key (teacher_id, student_key)
);

create index if not exists ope_students_email_idx on public.ope_students (email);
create index if not exists ope_students_registration_no_idx on public.ope_students (registration_no);
create index if not exists ope_students_updated_at_idx on public.ope_students (updated_at);

create table if not exists public.ope_token_transactions (
  transaction_id text primary key,
  user_id text not null default '',
  type text not null default '',
  created_at timestamptz,
  updated_at timestamptz,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists ope_token_transactions_user_id_idx on public.ope_token_transactions (user_id);
create index if not exists ope_token_transactions_created_at_idx on public.ope_token_transactions (created_at);
