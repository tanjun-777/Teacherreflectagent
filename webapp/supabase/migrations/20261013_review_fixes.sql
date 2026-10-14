-- ============================================================
-- 2026-10-13 教师端审查修复（可安全重复执行）
-- 1) 操作日志独立表 session_operation_logs（消除 draft_snapshot 并发覆盖丢数据）
-- 2) profiles 补 school 列（侧栏展示）
-- 3) 管理员只读旁路：problems / causes / measures / reflection_reports / improvement_plans
-- ============================================================

-- 1. 会话操作日志独立表（append-only，天然无并发覆盖）
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

-- 2. profiles 补 school 列（侧栏展示学校）
alter table public.profiles add column if not exists school text;

-- 3. 管理员只读旁路：子表默认策略仅限会话归属教师，管理员读取为空导致管理端详情/导出失效
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
