-- 0140_ops_config_durations.sql — set the operator-chosen subscription lifecycle durations (Issue 2).
-- Trial 3 days · Past Due window 3 days · Grace Period 5 days. Ticket SLAs keep their defaults
-- (CRITICAL 1h / HIGH 4h / MEDIUM 24h / LOW 72h). Idempotent (sets explicit values on the singleton).
update public.ops_config
   set sub_trial_days = 3,
       sub_past_due_days = 3,
       sub_grace_days = 5,
       updated_at = now()
 where id;
