-- 0075_min_house_edge_floor.sql — config-change guard: a real-money brand must always keep an edge.
--
-- Root-cause follow-up (docs/26 §5): operators thrashed `site_game_config` (~221 versions) including
-- near-zero / zero house edges (RTP -> 100%+), i.e. configs where the house never profits. The
-- existing `site_cfg_feasible` CHECK enforced mathematical feasibility but allowed house_edge = 0.
-- This adds a MINIMUM HOUSE EDGE floor of 0.02 (RTP <= 98%) to the same CHECK, so no economy edit —
-- via any RPC / admin / platform path — can set a non-profitable book. Enforced at write time.
--
-- Safe: the lowest live edge is invest254 @ 0.05, so every existing row already satisfies the floor
-- (the constraint validates on ADD). Additive to the guard set; recreates the constraint verbatim
-- plus the floor. Idempotent (drop-if-exists then add).

alter table public.site_game_config drop constraint if exists site_cfg_feasible;

alter table public.site_game_config add constraint site_cfg_feasible check (
  house_edge >= 0.02                              -- NEW: minimum house edge (RTP <= 98%)
  and house_edge < 1
  and max_multiplier > 1
  and target_win_rate > 0
  and target_win_rate <= 1
  and volatility > 0
  and drift_bias >= -1 and drift_bias <= 1
  and tick_rate_ms >= 50 and tick_rate_ms <= 60000
  and default_duration_s >= 1 and default_duration_s <= 3600
  and ((1 - house_edge) / target_win_rate) > 1                 -- winners must profit (feasible)
  and ((1 - house_edge) / target_win_rate) <= max_multiplier   -- mean win multiplier within cap
);
