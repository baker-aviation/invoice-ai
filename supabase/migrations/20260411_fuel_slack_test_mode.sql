-- Fuel Slack test-mode toggle: when 'true', all fuel-related Slack messages
-- are redirected to #fuel-planning regardless of the intended per-tail channel.
INSERT INTO app_settings (key, value)
VALUES ('fuel_slack_test_mode', 'true')
ON CONFLICT (key) DO NOTHING;
