-- ============================================================
-- 高危项修复迁移：管理操作审计表
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴执行（幂等，可重复执行）
-- 依赖：无（独立于 fix-security.sql，执行顺序不限）
-- ============================================================

-- 管理端不可逆操作（删除用户/删除反思记录）的审计日志
-- 由服务端 service_role 直写，前端不读写
create table if not exists public.admin_audit_logs (
  id          bigint generated always as identity primary key,
  admin_id    uuid not null,
  action      text not null,
  target_type text not null,
  target_id   text not null,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists admin_audit_logs_created_at_idx on public.admin_audit_logs (created_at desc);
create index if not exists admin_audit_logs_admin_id_idx on public.admin_audit_logs (admin_id);

-- 开启 RLS 且不给任何前端策略：anon/authenticated 均不可读写，仅 service_role（绕过 RLS）可写
alter table public.admin_audit_logs enable row level security;

comment on table public.admin_audit_logs is '管理端不可逆操作审计：删除用户/删除反思记录等，由 API 路由以 service_role 写入';
