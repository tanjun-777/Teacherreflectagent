-- ============================================================
-- 安全修复迁移脚本（2026-10 部署前审查 · 阻断项 2 与 4）
-- 适用问题：
--   1) 注册触发器信任客户端 role metadata，存在自助注册直接提权为 admin 的风险
--   2) audio-uploads / doc-uploads 存储桶为 public，录音与文档可被匿名下载
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴全文执行（可重复执行，幂等）
-- 配套要求：
--   · 在 Supabase Dashboard → Authentication → Providers → Email
--     关闭 "Allow new users to sign up"（本项目账户由管理端统一创建）
--   · 应用代码已适配私有桶（ASR/解析走服务端签名，教师端播放走客户端签名），
--     先执行本脚本再部署新代码
-- ============================================================

-- ------------------------------------------------------------
-- 1. 替换注册触发器函数：新用户 role 一律写死 'teacher'
--    管理员账号仅由管理端创建接口（service_role）显式设置
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

-- 清理历史脏数据：将曾通过 metadata 注入的非法 admin 账户降回 teacher
-- （如有合法管理员，请在其重新被管理端显式设置前不会被误删，仅降级 role）
-- 执行前请先查看：select id, name, role from public.profiles where role = 'admin';
-- update public.profiles set role = 'teacher'
-- where role = 'admin' and id not in (
--   select (auth.users.raw_user_meta_data->>'created_by_admin')::uuid from auth.users
--   where raw_user_meta_data->>'created_by_admin' is not null
-- );

-- ------------------------------------------------------------
-- 2. 存储桶转私有（on conflict 保证幂等，且不会改回 public）
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('audio-uploads', 'audio-uploads', false)
on conflict (id) do update set public = excluded.public;

insert into storage.buckets (id, name, public)
values ('doc-uploads', 'doc-uploads', false)
on conflict (id) do update set public = excluded.public;

-- ------------------------------------------------------------
-- 3. 核对既有 RLS 策略存在（缺则补建，与 schema.sql 一致）
-- ------------------------------------------------------------
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
-- 4. 验证查询（执行后核对输出）
-- ------------------------------------------------------------
-- 4.1 触发器函数应为 'teacher'（security_definer + search_path=public）
select p.proname, pg_get_functiondef(p.oid)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'handle_new_user';

-- 4.2 应有 2 行且 public = false
select id, name, public from storage.buckets
where id in ('audio-uploads', 'doc-uploads');

-- 4.3 应有 4 条策略（insert×2 / select / delete）
select policyname, cmd from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by policyname;
