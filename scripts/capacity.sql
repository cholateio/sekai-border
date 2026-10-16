-- scripts/capacity.sql  (EVERY statement below is its own MCP execute_sql call; (3b) VACUUM must be alone)
-- (1a) the event row
insert into test.sekai_border_events (id, name, start_at, aggregate_at, ranking_announce_at) values (900, 'capacity', '2026-01-01T00:00:00Z', '2026-01-10T00:00:00Z', '2026-01-10T00:10:00Z');
-- (1b) one event's worth of 5-minute snapshots: 9 days x 288 slots x 30 ranks = 77,760 rows
insert into test.sekai_border_rankings (event_id, chapter, rank, score, taken_at, is_final)
select 900, 0, r, 1000000 + s, '2026-01-01T00:00:00Z'::timestamptz + (s * interval '5 minutes'), false
from generate_series(0, 2591) s, unnest(array[1,2,3,4,5,6,7,8,9,10,20,30,40,50,60,70,80,90,100,200,300,400,500,1000,1500,2000,2500,3000,5000,10000]) r;
-- (2) measure live
select 'live' as stage, pg_size_pretty(pg_total_relation_size('test.sekai_border_rankings')) as total, pg_size_pretty(pg_relation_size('test.sekai_border_rankings')) as heap, pg_size_pretty(pg_indexes_size('test.sekai_border_rankings')) as idx, count(*) from test.sekai_border_rankings;
-- (3a) finalize (compacts to hourly)
select test.sekai_border_finalize(900, (select jsonb_agg(jsonb_build_object('chapter',0,'rank',r,'score',1)) from unnest(array[1,2,3,4,5,6,7,8,9,10,20,30,40,50,60,70,80,90,100,200,300,400,500,1000,1500,2000,2500,3000,5000,10000]) r));
-- (3b) its own call:
vacuum (full, analyze) test.sekai_border_rankings;
-- (4) measure compacted
select 'compacted' as stage, pg_size_pretty(pg_total_relation_size('test.sekai_border_rankings')) as total, pg_size_pretty(pg_relation_size('test.sekai_border_rankings')) as heap, pg_size_pretty(pg_indexes_size('test.sekai_border_rankings')) as idx, count(*) from test.sekai_border_rankings;
-- (5)
delete from test.sekai_border_rankings where event_id = 900;
-- (6)
delete from test.sekai_border_events where id = 900;
