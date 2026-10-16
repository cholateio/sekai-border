set search_path = test;
create or replace view test.view_all_ranking_report as  WITH ranking_calculations AS (
         SELECT event_rankings.event_id,
            event_rankings.rank,
            event_rankings.created_at,
            event_rankings.score,
            first_value(event_rankings.created_at) OVER (PARTITION BY event_rankings.event_id ORDER BY event_rankings.created_at) AS start_time,
            lag(event_rankings.score, 12) OVER (PARTITION BY event_rankings.event_id, event_rankings.rank ORDER BY event_rankings.created_at) AS score_1h_ago,
            lag(event_rankings.score, 36) OVER (PARTITION BY event_rankings.event_id, event_rankings.rank ORDER BY event_rankings.created_at) AS score_3h_ago,
            lag(event_rankings.score, 288) OVER (PARTITION BY event_rankings.event_id, event_rankings.rank ORDER BY event_rankings.created_at) AS score_24h_ago,
            lag(event_rankings.created_at, 12) OVER (PARTITION BY event_rankings.event_id, event_rankings.rank ORDER BY event_rankings.created_at) AS time_1h_ago,
            lag(event_rankings.created_at, 36) OVER (PARTITION BY event_rankings.event_id, event_rankings.rank ORDER BY event_rankings.created_at) AS time_3h_ago,
            lag(event_rankings.created_at, 288) OVER (PARTITION BY event_rankings.event_id, event_rankings.rank ORDER BY event_rankings.created_at) AS time_24h_ago
           FROM event_rankings
        ), validated_speeds AS (
         SELECT ranking_calculations.event_id,
            ranking_calculations.rank,
            ranking_calculations.created_at,
            ranking_calculations.score,
            ranking_calculations.start_time,
            ranking_calculations.score_1h_ago,
            ranking_calculations.score_3h_ago,
            ranking_calculations.score_24h_ago,
            ranking_calculations.time_1h_ago,
            ranking_calculations.time_3h_ago,
            ranking_calculations.time_24h_ago,
                CASE
                    WHEN EXTRACT(epoch FROM ranking_calculations.created_at - ranking_calculations.time_1h_ago) >= 3000::numeric AND EXTRACT(epoch FROM ranking_calculations.created_at - ranking_calculations.time_1h_ago) <= 4200::numeric THEN ranking_calculations.score - ranking_calculations.score_1h_ago
                    ELSE NULL::bigint
                END AS speed_1h,
                CASE
                    WHEN EXTRACT(epoch FROM ranking_calculations.created_at - ranking_calculations.time_3h_ago) >= 9600::numeric AND EXTRACT(epoch FROM ranking_calculations.created_at - ranking_calculations.time_3h_ago) <= 12000::numeric THEN ranking_calculations.score - ranking_calculations.score_3h_ago
                    ELSE NULL::bigint
                END AS speed_3h,
                CASE
                    WHEN EXTRACT(epoch FROM ranking_calculations.created_at - ranking_calculations.time_24h_ago) >= 84600::numeric AND EXTRACT(epoch FROM ranking_calculations.created_at - ranking_calculations.time_24h_ago) <= 88200::numeric THEN ranking_calculations.score - ranking_calculations.score_24h_ago
                    ELSE NULL::bigint
                END AS speed_24h
           FROM ranking_calculations
        ), latest_stats AS (
         SELECT validated_speeds.event_id,
            validated_speeds.rank,
            (array_agg(validated_speeds.score ORDER BY validated_speeds.created_at DESC))[1] AS current_score,
            (array_agg(validated_speeds.created_at ORDER BY validated_speeds.created_at DESC))[1] AS last_captured_at,
            (array_agg(validated_speeds.start_time ORDER BY validated_speeds.created_at DESC))[1] AS event_start_time,
            (array_agg(validated_speeds.speed_1h ORDER BY validated_speeds.created_at DESC))[1] AS last_1h_speed,
            (array_agg(validated_speeds.speed_3h ORDER BY validated_speeds.created_at DESC))[1] AS last_3h_speed,
            (array_agg(validated_speeds.speed_24h ORDER BY validated_speeds.created_at DESC))[1] AS last_24h_speed,
            max(validated_speeds.speed_1h) FILTER (WHERE validated_speeds.created_at > (validated_speeds.start_time + '01:00:00'::interval)) AS max_speed_historical
           FROM validated_speeds
          GROUP BY validated_speeds.event_id, validated_speeds.rank
        )
 SELECT rank,
    current_score,
    COALESCE(last_1h_speed, 0::bigint) AS last_1h_speed,
    COALESCE(last_3h_speed, 0::bigint) AS last_3h_speed,
    COALESCE(last_24h_speed, 0::bigint) AS last_24h_speed,
    COALESCE(max_speed_historical, 0::bigint) AS max_speed,
        CASE
            WHEN EXTRACT(epoch FROM last_captured_at - event_start_time) < 3600::numeric THEN 0::numeric
            ELSE round(current_score::numeric / (EXTRACT(epoch FROM last_captured_at - event_start_time) / 3600::numeric))
        END AS overall_speed
   FROM latest_stats
  ORDER BY rank;
create or replace view test.view_day_ranking_report as  SELECT event_id,
    rank,
    array_agg(score ORDER BY created_at) AS scores
   FROM ( SELECT DISTINCT ON (event_rankings.event_id, event_rankings.rank, (date((event_rankings.created_at AT TIME ZONE 'Asia/Taipei'::text)))) event_rankings.event_id,
            event_rankings.rank,
            event_rankings.score,
            event_rankings.created_at
           FROM event_rankings
          WHERE EXTRACT(hour FROM (event_rankings.created_at AT TIME ZONE 'Asia/Taipei'::text)) = 0::numeric AND EXTRACT(minute FROM (event_rankings.created_at AT TIME ZONE 'Asia/Taipei'::text)) <= 2::numeric
          ORDER BY event_rankings.event_id, event_rankings.rank, (date((event_rankings.created_at AT TIME ZONE 'Asia/Taipei'::text))), event_rankings.created_at) sub
  GROUP BY event_id, rank;
-- test-only install: the legacy views exist here only for the row-by-row comparison in sekai_border_test_view_diff()
revoke all on test.view_all_ranking_report, test.view_day_ranking_report from public, anon, authenticated;
grant select on test.view_all_ranking_report, test.view_day_ranking_report to service_role;
