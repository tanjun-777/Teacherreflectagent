-- ============================================================
-- TeacherReflect — Supabase Database Schema (safe re-run)
-- ============================================================

create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------
-- 1. profiles
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  role              text not null default 'teacher' check (role in ('teacher','admin')),
  name              text,
  subject           text,
  grade             text,
  textbook_version  text,
  avatar_url        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- 新增 textbook_version 字段（如已有 school 列可选保留）
alter table public.profiles add column if not exists textbook_version text;

alter table public.profiles enable row level security;

-- 辅助函数：获取当前用户 role，使用 security definer 绕过 RLS 避免递归
create or replace function public.get_my_role()
returns text language sql security definer stable as $$
  select role from public.profiles where id = auth.uid() limit 1;
$$;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='profiles' and policyname='用户可读写自己的 profile') then
    execute 'create policy "用户可读写自己的 profile" on public.profiles for all using (auth.uid() = id) with check (auth.uid() = id)';
  end if;
  -- 管理员策略改用 get_my_role() 函数，避免在策略中直接查询 profiles 表导致无限递归
  if not exists (select 1 from pg_policies where tablename='profiles' and policyname='管理员可读所有 profile') then
    execute 'create policy "管理员可读所有 profile" on public.profiles for select using (public.get_my_role() = ''admin'')';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. reflection_sessions
-- ------------------------------------------------------------
create table if not exists public.reflection_sessions (
  id                  uuid primary key default uuid_generate_v4(),
  teacher_id          uuid not null references public.profiles(id) on delete cascade,
  title               text not null,
  class_date          date,
  subject             text,
  grade               text,
  lesson_topic        text,
  teaching_design     text,
  self_review         text,
  peer_review         text,
  audio_url           text,
  audio_transcript    text,
  current_stage       int not null default 0 check (current_stage between 0 and 5),
  status              text not null default 'draft' check (status in ('draft','analyzing','done')),
  draft_snapshot      jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.reflection_sessions enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='reflection_sessions' and policyname='教师只能访问自己的会话') then
    execute 'create policy "教师只能访问自己的会话" on public.reflection_sessions for all using (teacher_id = auth.uid()) with check (teacher_id = auth.uid())';
  end if;
  if not exists (select 1 from pg_policies where tablename='reflection_sessions' and policyname='管理员可读所有会话') then
    execute 'create policy "管理员可读所有会话" on public.reflection_sessions for select using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = ''admin''))';
  end if;
end $$;

-- ------------------------------------------------------------
-- 3. problems
-- ------------------------------------------------------------
create table if not exists public.problems (
  id              uuid primary key default uuid_generate_v4(),
  session_id      uuid not null references public.reflection_sessions(id) on delete cascade,
  description     text not null,
  evidence        jsonb,
  source          text[],
  specificity     text check (specificity in ('none','vague','specific')),
  confirmed       boolean not null default false,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now()
);

alter table public.problems enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='problems' and policyname='会话归属教师可操作问题') then
    execute 'create policy "会话归属教师可操作问题" on public.problems for all using (exists (select 1 from public.reflection_sessions s where s.id = session_id and s.teacher_id = auth.uid()))';
  end if;
end $$;

-- ------------------------------------------------------------
-- 4. causes
-- ------------------------------------------------------------
create table if not exists public.causes (
  id              uuid primary key default uuid_generate_v4(),
  session_id      uuid not null references public.reflection_sessions(id) on delete cascade,
  problem_id      uuid not null references public.problems(id) on delete cascade,
  description     text not null,
  confirmed       boolean not null default false,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now()
);

alter table public.causes enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='causes' and policyname='会话归属教师可操作归因') then
    execute 'create policy "会话归属教师可操作归因" on public.causes for all using (exists (select 1 from public.reflection_sessions s where s.id = session_id and s.teacher_id = auth.uid()))';
  end if;
end $$;

-- ------------------------------------------------------------
-- 5. measures
-- ------------------------------------------------------------
create table if not exists public.measures (
  id              uuid primary key default uuid_generate_v4(),
  session_id      uuid not null references public.reflection_sessions(id) on delete cascade,
  problem_id      uuid not null references public.problems(id) on delete cascade,
  cause_id        uuid references public.causes(id) on delete set null,
  description     text not null,
  confirmed       boolean not null default false,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now()
);

alter table public.measures enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='measures' and policyname='会话归属教师可操作措施') then
    execute 'create policy "会话归属教师可操作措施" on public.measures for all using (exists (select 1 from public.reflection_sessions s where s.id = session_id and s.teacher_id = auth.uid()))';
  end if;
end $$;

-- ------------------------------------------------------------
-- 6. reflection_reports
-- ------------------------------------------------------------
create table if not exists public.reflection_reports (
  id              uuid primary key default uuid_generate_v4(),
  session_id      uuid not null unique references public.reflection_sessions(id) on delete cascade,
  content         text,
  ai_draft        text,
  finalized_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.reflection_reports enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='reflection_reports' and policyname='会话归属教师可操作报告') then
    execute 'create policy "会话归属教师可操作报告" on public.reflection_reports for all using (exists (select 1 from public.reflection_sessions s where s.id = session_id and s.teacher_id = auth.uid()))';
  end if;
end $$;

-- ------------------------------------------------------------
-- 7. improvement_plans
-- ------------------------------------------------------------
create table if not exists public.improvement_plans (
  id              uuid primary key default uuid_generate_v4(),
  session_id      uuid not null references public.reflection_sessions(id) on delete cascade,
  measure_id      uuid references public.measures(id) on delete set null,
  goal            text not null,
  actions         text,
  timeline        text,
  success_criteria text,
  status          text not null default 'pending' check (status in ('pending','in_progress','done')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.improvement_plans enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='improvement_plans' and policyname='会话归属教师可操作改进计划') then
    execute 'create policy "会话归属教师可操作改进计划" on public.improvement_plans for all using (exists (select 1 from public.reflection_sessions s where s.id = session_id and s.teacher_id = auth.uid()))';
  end if;
end $$;

-- ------------------------------------------------------------
-- updated_at 触发器
-- ------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname='trg_profiles_updated_at') then
    execute 'create trigger trg_profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at()';
  end if;
  if not exists (select 1 from pg_trigger where tgname='trg_sessions_updated_at') then
    execute 'create trigger trg_sessions_updated_at before update on public.reflection_sessions for each row execute function public.set_updated_at()';
  end if;
  if not exists (select 1 from pg_trigger where tgname='trg_reports_updated_at') then
    execute 'create trigger trg_reports_updated_at before update on public.reflection_reports for each row execute function public.set_updated_at()';
  end if;
  if not exists (select 1 from pg_trigger where tgname='trg_plans_updated_at') then
    execute 'create trigger trg_plans_updated_at before update on public.improvement_plans for each row execute function public.set_updated_at()';
  end if;
end $$;

-- ------------------------------------------------------------
-- 新用户自动建 profile
-- 安全说明：role 一律写死 'teacher'，绝不信任客户端注册时传入的
-- raw_user_meta_data.role（防止自助注册携带 role:"admin" 直接提权）。
-- 管理员账号由管理端创建接口（service_role）显式设置 role。
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.email),
    'teacher'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname='on_auth_user_created') then
    execute 'create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user()';
  end if;
end $$;

-- ------------------------------------------------------------
-- 8. storage buckets + policies（防止 Bucket not found）
--    桶为私有：录音/文档属敏感教学数据，下载一律经短期签名 URL
--    （服务端 service_role 签名后供 ASR/解析使用；教师端播放用
--     客户端签名，RLS 策略允许用户读取自己目录下的文件）
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('audio-uploads', 'audio-uploads', false)
on conflict (id) do update set public = excluded.public;

insert into storage.buckets (id, name, public)
values ('doc-uploads', 'doc-uploads', false)
on conflict (id) do update set public = excluded.public;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects' and policyname='用户可上传自己的音频文件'
  ) then
    execute 'create policy "用户可上传自己的音频文件" on storage.objects for insert to authenticated with check (bucket_id = ''audio-uploads'' and (storage.foldername(name))[1] = auth.uid()::text)';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects' and policyname='用户可上传自己的文档文件'
  ) then
    execute 'create policy "用户可上传自己的文档文件" on storage.objects for insert to authenticated with check (bucket_id = ''doc-uploads'' and (storage.foldername(name))[1] = auth.uid()::text)';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects' and policyname='用户可读自己的上传文件'
  ) then
    execute 'create policy "用户可读自己的上传文件" on storage.objects for select to authenticated using ((bucket_id in (''audio-uploads'',''doc-uploads'')) and ((storage.foldername(name))[1] = auth.uid()::text))';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects' and policyname='用户可删除自己的上传文件'
  ) then
    execute 'create policy "用户可删除自己的上传文件" on storage.objects for delete to authenticated using ((bucket_id in (''audio-uploads'',''doc-uploads'')) and ((storage.foldername(name))[1] = auth.uid()::text))';
  end if;
end $$;

-- ------------------------------------------------------------
-- 9. 阶段1 数据收集扩展字段（学生表现 / 学习结果 / 外部智慧教研系统反馈）
-- ------------------------------------------------------------
alter table public.reflection_sessions add column if not exists student_performance text;
alter table public.reflection_sessions add column if not exists learning_outcomes text;
alter table public.reflection_sessions add column if not exists external_feedback text;
alter table public.problems add column if not exists specificity text check (specificity in ('none','vague','specific'));

-- ------------------------------------------------------------
-- 10. 会话操作日志独立表（2026-10 审查修复：消除 draft_snapshot 并发覆盖）
-- ------------------------------------------------------------
create table if not exists public.session_operation_logs (
  id            bigint generated always as identity primary key,
  session_id    uuid not null references public.reflection_sessions(id) on delete cascade,
  logged_at     timestamptz not null default now(),
  stage         int not null check (stage between 1 and 4),
  action        text not null,
  target_type   text not null,
  target_id     uuid,
  summary       text,
  before_value  text,
  after_value   text
);

create index if not exists idx_session_operation_logs_session
  on public.session_operation_logs (session_id, logged_at);

alter table public.session_operation_logs enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='session_operation_logs' and policyname='教师可追加自己的会话日志') then
    execute 'create policy "教师可追加自己的会话日志" on public.session_operation_logs for insert with check (exists (select 1 from public.reflection_sessions s where s.id = session_id and s.teacher_id = auth.uid()))';
  end if;
  if not exists (select 1 from pg_policies where tablename='session_operation_logs' and policyname='教师或管理员可读会话日志') then
    execute 'create policy "教师或管理员可读会话日志" on public.session_operation_logs for select using (exists (select 1 from public.reflection_sessions s where s.id = session_id and (s.teacher_id = auth.uid() or public.get_my_role() = ''admin'')))';
  end if;
end $$;

-- ------------------------------------------------------------
-- 11. profiles 补 school 列（侧栏展示学校）
-- ------------------------------------------------------------
alter table public.profiles add column if not exists school text;

-- ------------------------------------------------------------
-- 12. 管理员只读旁路（2026-10 审查修复：管理端详情/导出读取子表为空）
-- ------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_policies where tablename='problems' and policyname='管理员可读所有问题') then
    execute 'create policy "管理员可读所有问题" on public.problems for select using (public.get_my_role() = ''admin'')';
  end if;
  if not exists (select 1 from pg_policies where tablename='causes' and policyname='管理员可读所有归因') then
    execute 'create policy "管理员可读所有归因" on public.causes for select using (public.get_my_role() = ''admin'')';
  end if;
  if not exists (select 1 from pg_policies where tablename='measures' and policyname='管理员可读所有措施') then
    execute 'create policy "管理员可读所有措施" on public.measures for select using (public.get_my_role() = ''admin'')';
  end if;
  if not exists (select 1 from pg_policies where tablename='reflection_reports' and policyname='管理员可读所有报告') then
    execute 'create policy "管理员可读所有报告" on public.reflection_reports for select using (public.get_my_role() = ''admin'')';
  end if;
  if not exists (select 1 from pg_policies where tablename='improvement_plans' and policyname='管理员可读所有改进计划') then
    execute 'create policy "管理员可读所有改进计划" on public.improvement_plans for select using (public.get_my_role() = ''admin'')';
  end if;
end $$;

