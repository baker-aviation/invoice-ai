-- Add segments_summary to flightaware_tracks for precomputed altitude segment analysis
alter table flightaware_tracks add column if not exists segments_summary jsonb;
