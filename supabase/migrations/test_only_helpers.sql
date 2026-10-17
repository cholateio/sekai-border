-- supabase/migrations/test_only_helpers.sql  (apply ONLY to the test schema)
create table if not exists test.event_rankings (id bigserial primary key, created_at timestamptz default now(), rank int, score bigint, event_id text);
revoke all on test.event_rankings from public, anon, authenticated; revoke all on sequence test.event_rankings_id_seq from public, anon, authenticated;
grant all on test.event_rankings to service_role; grant usage, select on sequence test.event_rankings_id_seq to service_role;   -- tests read it through the service-role client
create or replace function test.sekai_border_test_seed_legacy(p_rows jsonb) returns void language sql security definer set search_path = test as $$
    insert into test.event_rankings (event_id, rank, score, created_at) select r->>'event_id', (r->>'rank')::int, (r->>'score')::bigint, (r->>'created_at')::timestamptz from jsonb_array_elements(p_rows) r; $$;
create or replace function test.sekai_border_test_clear_legacy() returns void language sql security definer set search_path = test as $$ delete from test.event_rankings where id is not null; $$;   -- Supabase safeupdate rejects DELETE without WHERE

-- legacy vs compat views on the same data (spec §8.2): row diff via EXCEPT (type-incompatible columns make EXCEPT itself fail, which is also a finding);
-- column types via format_type (information_schema.data_type says only ARRAY for bigint[] vs integer[])
create or replace function test.sekai_border_test_view_diff() returns jsonb language plpgsql security definer set search_path = test as $$
declare d1 int; d2 int; t1 jsonb; t2 jsonb; t3 jsonb; t4 jsonb;
begin
    select count(*) into d1 from ((select * from test.view_all_ranking_report except select * from test.sekai_border_current_report) union all (select * from test.sekai_border_current_report except select * from test.view_all_ranking_report)) x;
    select count(*) into d2 from ((select * from test.view_day_ranking_report except select * from test.sekai_border_daily_report) union all (select * from test.sekai_border_daily_report except select * from test.view_day_ranking_report)) x;
    select jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) order by a.attnum) into t1 from pg_attribute a where a.attrelid = 'test.view_all_ranking_report'::regclass and a.attnum > 0 and not a.attisdropped;
    select jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) order by a.attnum) into t2 from pg_attribute a where a.attrelid = 'test.sekai_border_current_report'::regclass and a.attnum > 0 and not a.attisdropped;
    select jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) order by a.attnum) into t3 from pg_attribute a where a.attrelid = 'test.view_day_ranking_report'::regclass and a.attnum > 0 and not a.attisdropped;
    select jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) order by a.attnum) into t4 from pg_attribute a where a.attrelid = 'test.sekai_border_daily_report'::regclass and a.attnum > 0 and not a.attisdropped;
    return jsonb_build_object('current_diff', d1, 'daily_diff', d2, 'current_types_equal', t1 = t2, 'daily_types_equal', t3 = t4);
end $$;

-- run finalize under a given session timezone (spec §3.2: bucketing must not depend on it)
create or replace function test.sekai_border_test_finalize_in_tz(p_event_id int, p_finals jsonb, p_tz text) returns jsonb language plpgsql security definer set search_path = test as $$
begin perform set_config('timezone', p_tz, true); return test.sekai_border_finalize(p_event_id, p_finals); end $$;

-- fault injection: when test.fail_compaction is 'on', the first DELETE on rankings raises (between finals upsert and compaction)
create or replace function test.sekai_border_test_fail_delete() returns trigger language plpgsql as $$
begin if current_setting('test.fail_compaction', true) = 'on' then raise exception 'injected failure before compaction'; end if; return old; end $$;
drop trigger if exists sekai_border_test_fail_delete on test.sekai_border_rankings;
create trigger sekai_border_test_fail_delete before delete on test.sekai_border_rankings for each row execute function test.sekai_border_test_fail_delete();
create or replace function test.sekai_border_test_finalize_failing(p_event_id int, p_finals jsonb) returns jsonb language plpgsql security definer set search_path = test as $$
begin perform set_config('test.fail_compaction', 'on', true); return test.sekai_border_finalize(p_event_id, p_finals); end $$;

-- catalog-level privilege report (spec S4): roles x privileges, policies, rls, function acl
create or replace function test.sekai_border_test_privileges() returns jsonb language sql security definer as $$
  select jsonb_build_object(
    'rls', (select jsonb_object_agg(relname, relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='test' and relname in ('sekai_border_events','sekai_border_rankings')),
    'policies', (select jsonb_agg(jsonb_build_object('t', tablename, 'cmd', cmd, 'roles', roles)) from pg_policies where schemaname='test' and tablename like 'sekai_border_%'),
    'privs', (select jsonb_agg(jsonb_build_object('role', r, 'rel', t, 'priv', p, 'has', has_table_privilege(r, 'test.'||t, p)))
              from (values ('anon'),('authenticated')) a(r), (values ('sekai_border_events'),('sekai_border_rankings'),('sekai_border_current_report'),('sekai_border_daily_report')) b(t), (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) c(p)),
    'fn', jsonb_build_object('anon', has_function_privilege('anon','test.sekai_border_finalize(integer,jsonb)','EXECUTE'), 'authenticated', has_function_privilege('authenticated','test.sekai_border_finalize(integer,jsonb)','EXECUTE'), 'service_role', has_function_privilege('service_role','test.sekai_border_finalize(integer,jsonb)','EXECUTE'),
                              'public_grantee', (select count(*) from aclexplode((select proacl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='test' and proname='sekai_border_finalize')) where grantee = 0)),
    'views', (select jsonb_object_agg(relname, coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker'),'off')) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='test' and relname in ('sekai_border_current_report','sekai_border_daily_report')),
    'helpers', (select jsonb_agg(jsonb_build_object('fn', p.proname, 'anon', has_function_privilege('anon', p.oid, 'EXECUTE'), 'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='test' and p.proname like 'sekai_border_test_%'),
    'schema_create', jsonb_build_object('anon', has_schema_privilege('anon','test','CREATE'), 'authenticated', has_schema_privilege('authenticated','test','CREATE')),
    'legacy', (select jsonb_agg(jsonb_build_object('role', r, 'obj', o, 'priv', p, 'has', case when o like '%\_seq' then has_sequence_privilege(r, 'test.'||o, p) else has_table_privilege(r, 'test.'||o, p) end))
               from (values ('anon'),('authenticated')) a(r), (values ('event_rankings','SELECT'),('event_rankings','INSERT'),('event_rankings_id_seq','USAGE'),('view_all_ranking_report','SELECT'),('view_day_ranking_report','SELECT')) b(o, p)),
    'internal_fn', jsonb_build_object('anon', has_function_privilege('anon','test.sekai_border_chapters_valid(jsonb)','EXECUTE'), 'authenticated', has_function_privilege('authenticated','test.sekai_border_chapters_valid(jsonb)','EXECUTE'))
  ) $$;
-- every test helper is service_role only (the test schema is exposed through PostgREST)
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'test' and p.proname like 'sekai_border_test_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop; end $$;

-- test-only: toggle the legacy freeze trigger (same CREATE TRIGGER statement as 0001d) so one test exercises it without blocking the others
create or replace function test.sekai_border_test_legacy_freeze(p_on boolean) returns void language plpgsql security definer set search_path = test as $$
begin
    execute 'drop trigger if exists sekai_border_legacy_freeze on test.event_rankings';
    if p_on then execute 'create trigger sekai_border_legacy_freeze before insert or update or delete or truncate on test.event_rankings for each statement execute function test.sekai_border_legacy_freeze()'; end if;
end $$;
revoke all on function test.sekai_border_test_legacy_freeze(boolean) from public, anon, authenticated;
grant execute on function test.sekai_border_test_legacy_freeze(boolean) to service_role;

-- ---- sub-project 2 (0002) helpers ----
-- fault injection: when test.fail_series is 'on', inserting into series raises (spec A6: finalize must roll back)
create or replace function test.sekai_border_test_fail_series() returns trigger language plpgsql as $$
begin if current_setting('test.fail_series', true) = 'on' then raise exception 'injected series failure'; end if; return new; end $$;
drop trigger if exists sekai_border_test_fail_series on test.sekai_border_series;
create trigger sekai_border_test_fail_series before insert on test.sekai_border_series for each row execute function test.sekai_border_test_fail_series();
create or replace function test.sekai_border_test_finalize_failing_series(p_event_id int, p_finals jsonb) returns jsonb language plpgsql security definer set search_path = test as $$
begin perform set_config('test.fail_series', 'on', true); return test.sekai_border_finalize(p_event_id, p_finals); end $$;
-- finalize_core is not executable by service_role; tests reach the purge-enabled path through this helper
create or replace function test.sekai_border_test_finalize_core(p_event_id int, p_finals jsonb, p_purge_max_chapter int) returns jsonb language sql security definer set search_path = test as $$ select test.sekai_border_finalize_core(p_event_id, p_finals, p_purge_max_chapter) $$;
-- expose the SQL series recomputation to the A5 equivalence test
create or replace function test.sekai_border_test_series_rows(p_event_id int, p_chapter int) returns jsonb language plpgsql security definer set search_path = test as $$
declare w record; begin select * into w from test.sekai_border_window(p_event_id, p_chapter);
  return coalesce((select jsonb_agg(jsonb_build_object('rank', rank, 'start_at', start_at, 'scores', to_jsonb(scores)) order by rank) from test.sekai_border_series_rows(p_event_id, p_chapter, w.w_start, w.w_end)), '[]'::jsonb); end $$;
-- hold a lock of the given kind on forecasts for p_seconds inside one PostgREST transaction (spec A14 lock matrix)
create or replace function test.sekai_border_test_hold_lock(p_mode text, p_seconds numeric) returns void language plpgsql security definer set search_path = test as $$
begin
    if p_mode = 'row_exclusive' then update test.sekai_border_forecasts set computed_at = computed_at where false; insert into test.sekai_border_forecasts select * from test.sekai_border_forecasts where false;
    elsif p_mode = 'share' then lock table test.sekai_border_forecasts in share mode;
    elsif p_mode = 'access_exclusive' then lock table test.sekai_border_forecasts in access exclusive mode;
    elsif p_mode = 'access_share' then perform count(*) from test.sekai_border_forecasts;
    else raise exception 'unknown mode %', p_mode; end if;
    perform pg_sleep(p_seconds);
end $$;
-- privilege report for the three new tables and the two RPCs (spec A7)
create or replace function test.sekai_border_test_privileges2() returns jsonb language sql security definer as $$
  select jsonb_build_object(
    'rls', (select jsonb_object_agg(relname, relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='test' and relname in ('sekai_border_series','sekai_border_model','sekai_border_forecasts')),
    'privs', (select jsonb_agg(jsonb_build_object('role', r, 'rel', t, 'priv', p, 'has', has_table_privilege(r, 'test.'||t, p)))
              from (values ('anon'),('authenticated')) a(r), (values ('sekai_border_series'),('sekai_border_model'),('sekai_border_forecasts')) b(t), (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) c(p)),
    'fn', (select jsonb_object_agg(f, jsonb_build_object('anon', has_function_privilege('anon', 'test.'||f, 'EXECUTE'), 'authenticated', has_function_privilege('authenticated', 'test.'||f, 'EXECUTE'), 'service_role', has_function_privilege('service_role', 'test.'||f, 'EXECUTE')))
           from unnest(array['sekai_border_put_forecasts(integer, timestamptz, jsonb)', 'sekai_border_put_series(integer, jsonb)', 'sekai_border_finalize_core(integer, jsonb, integer)', 'sekai_border_purge_dup(integer[], integer, integer)', 'sekai_border_series_verify(integer, integer)']) f
           where to_regprocedure('test.'||f) is not null)
  ) $$;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'test' and p.proname like 'sekai_border_test_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop; end $$;
