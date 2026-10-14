-- ============================================================
-- 修复脚本：新建反思"保存不成功"（上传失败）
-- 适用问题：Storage 桶未创建 / Storage RLS 策略缺失 / 新字段缺失
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴全文执行（可重复执行，幂等）
-- ============================================================

-- ------------------------------------------------------------
-- 1. 创建/修正存储桶（私有：访问一律经短期签名 URL）
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('audio-uploads', 'audio-uploads', false)
on conflict (id) do update set public = excluded.public;

insert into storage.buckets (id, name, public)
values ('doc-uploads', 'doc-uploads', false)
on conflict (id) do update set public = excluded.public;

-- ------------------------------------------------------------
-- 2. Storage 上传/读取/删除策略（RLS）
--    路径第一段必须是用户自己的 UUID，即 {userId}/xxx
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
-- 3. 补齐阶段1数据收集新字段（防止下一步插入会话时报列缺失）
-- ------------------------------------------------------------
alter table public.reflection_sessions add column if not exists student_performance text;
alter table public.reflection_sessions add column if not exists learning_outcomes text;
alter table public.reflection_sessions add column if not exists external_feedback text;
alter table public.problems add column if not exists specificity text check (specificity in ('none','vague','specific'));

-- ------------------------------------------------------------
-- 4. 验证查询（执行后核对输出）
-- ------------------------------------------------------------
-- 4.1 应有 2 行且 public = false
select id, name, public from storage.buckets
where id in ('audio-uploads', 'doc-uploads');

-- 4.2 应有 4 条策略（insert×2 / select / delete）
select policyname, cmd from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by policyname;

-- 4.3 应有 3 行（student_performance / learning_outcomes / external_feedback）
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'reflection_sessions'
  and column_name in ('student_performance', 'learning_outcomes', 'external_feedback');
