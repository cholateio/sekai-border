-- scripts/capacity-forecast.sql  (spec A1; EVERY statement is its own MCP execute_sql call; VACUUM must be alone)
-- Prerequisites: test schema has 0002 applied and is empty; event 900 loaded with `node scripts/load-raw.js <182 backup> --as 900` (SUPABASE_SCHEMA=test).
-- (0) baseline after VACUUM FULL of the two tables while event 900 is NOT yet loaded (run before load-raw.js):
vacuum (full, analyze) test.sekai_border_rankings;
vacuum (full, analyze) test.sekai_border_series;
select 'baseline' as stage, pg_total_relation_size('test.sekai_border_rankings') as rankings, pg_total_relation_size('test.sekai_border_series') as series;
-- (1) after load-raw.js: live size (peak during the event; informational)
select 'live' as stage, pg_total_relation_size('test.sekai_border_rankings') as rankings, count(*) from test.sekai_border_rankings;
-- (2) phase-1 finalize (wrapper): series written, rank <= 1000 raw kept
select test.sekai_border_finalize(900, (select jsonb_agg(jsonb_build_object('chapter', 0, 'rank', r, 'score', 1000000)) from unnest(array[1,2,3,4,5,6,7,8,9,10,20,30,40,50,60,70,80,90,100,200,300,400,500,1000,1500,2000,2500,3000,5000,10000]) r));
vacuum (full, analyze) test.sekai_border_rankings;
vacuum (full, analyze) test.sekai_border_series;
select 'phase1' as stage, pg_total_relation_size('test.sekai_border_rankings') as rankings, pg_total_relation_size('test.sekai_border_series') as series, (select count(*) from test.sekai_border_rankings) as rows;
-- (3) phase-2 state: purge the rank <= 1000 raw rows (verify runs inside)
select test.sekai_border_purge_dup(array[900], 0, 0);
vacuum (full, analyze) test.sekai_border_rankings;
vacuum (full, analyze) test.sekai_border_series;
select 'phase2' as stage, pg_total_relation_size('test.sekai_border_rankings') as rankings, pg_total_relation_size('test.sekai_border_series') as series, (select count(*) from test.sekai_border_rankings) as rows;
-- B_main = (phase2.rankings + phase2.series) - (baseline.rankings + baseline.series)
-- (4) synthetic WL chapters: 901 = one 2-day chapter, 902 = one 3-day chapter; 28 ranks (no 1500/2500), 5-minute slots; phase-2 rule directly
insert into test.sekai_border_events (id, name, start_at, aggregate_at, ranking_announce_at, chapters) values
 (901, 'cap-wl-2d', '2026-01-01T12:00:00Z', '2026-01-03T11:59:59Z', '2026-01-03T12:09:59Z', '[{"chapter":1,"chapter_id":90101,"character_id":21,"start_at":"2026-01-01T12:00:00Z","aggregate_at":"2026-01-03T11:59:59Z","ranking_announce_at":"2026-01-03T12:09:59Z"}]'),
 (902, 'cap-wl-3d', '2026-02-01T12:00:00Z', '2026-02-04T11:59:59Z', '2026-02-04T12:09:59Z', '[{"chapter":1,"chapter_id":90201,"character_id":22,"start_at":"2026-02-01T12:00:00Z","aggregate_at":"2026-02-04T11:59:59Z","ranking_announce_at":"2026-02-04T12:09:59Z"}]');
insert into test.sekai_border_rankings (event_id, chapter, rank, score, taken_at, is_final)
select e.id, 1, r, 1000 + s, e.start_at + (s * interval '5 minutes'), false from test.sekai_border_events e, generate_series(0, 575) s, unnest(array[1,2,3,4,5,6,7,8,9,10,20,30,40,50,60,70,80,90,100,200,300,400,500,1000,2000,3000,5000,10000]) r where e.id = 901;
insert into test.sekai_border_rankings (event_id, chapter, rank, score, taken_at, is_final)
select e.id, 1, r, 1000 + s, e.start_at + (s * interval '5 minutes'), false from test.sekai_border_events e, generate_series(0, 863) s, unnest(array[1,2,3,4,5,6,7,8,9,10,20,30,40,50,60,70,80,90,100,200,300,400,500,1000,2000,3000,5000,10000]) r where e.id = 902;
-- main-board finals are required by finalize; give each a main final set too (no main snapshots, so no main series)
select test.sekai_border_finalize_core(901, (select jsonb_agg(jsonb_build_object('chapter', c, 'rank', r, 'score', 1000000)) from unnest(array[0,1]) c, unnest(array[1,2,3,4,5,6,7,8,9,10,20,30,40,50,60,70,80,90,100,200,300,400,500,1000,2000,3000,5000,10000]) r), 6);
select test.sekai_border_finalize_core(902, (select jsonb_agg(jsonb_build_object('chapter', c, 'rank', r, 'score', 1000000)) from unnest(array[0,1]) c, unnest(array[1,2,3,4,5,6,7,8,9,10,20,30,40,50,60,70,80,90,100,200,300,400,500,1000,2000,3000,5000,10000]) r), 6);
vacuum (full, analyze) test.sekai_border_rankings;
vacuum (full, analyze) test.sekai_border_series;
select 'wl' as stage, pg_total_relation_size('test.sekai_border_rankings') as rankings, pg_total_relation_size('test.sekai_border_series') as series, (select count(*) from test.sekai_border_rankings where event_id in (901, 902)) as rows;
-- b_ch (per chapter-hour) = ((wl.rankings + wl.series) - (phase2.rankings + phase2.series)) / (48 + 72); also record the two chapters separately by deleting 902 and re-measuring if linearity needs confirming
-- (5) forecasts full load: 60 lines x 505-point paths (synthetic); model row written by scripts/capacity-model.js (A15 full-size input)
select 'forecasts' as stage, pg_total_relation_size('test.sekai_border_forecasts') as forecasts, (select pg_column_size(params) from test.sekai_border_model where id = 1) as model_params;
-- (6) yearly growth inputs (PUBLIC, read-only): main periods started in the last 365 days, and chapter hours in the same window
select count(*) as main_periods from public.sekai_border_events where start_at >= now() - interval '365 days';
select coalesce(sum(extract(epoch from ((c->>'aggregate_at')::timestamptz - (c->>'start_at')::timestamptz)) / 3600), 0) as chapter_hours from public.sekai_border_events e, jsonb_array_elements(e.chapters) c where e.start_at >= now() - interval '365 days';
-- (7) cleanup
delete from test.sekai_border_forecasts where event_id in (900, 901, 902);
delete from test.sekai_border_series where event_id in (900, 901, 902);
delete from test.sekai_border_rankings where event_id in (900, 901, 902);
delete from test.sekai_border_events where id in (900, 901, 902);
