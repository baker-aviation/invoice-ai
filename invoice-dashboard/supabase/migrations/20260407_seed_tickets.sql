-- Seed the 8 tickets from the crew swap video review (2026-04-06)
insert into admin_tickets (title, body, priority, status, claude_prompt, github_issue, labels) values
(
  'Optimizer doesn''t flag crew departing too early',
  'The optimizer assigned Justin West a departure flight that leaves before the required buffer time after landing (landed 1930, assigned flight too early). Should flag commercial flights departing less than ~90 min after last leg lands.',
  5, 'open',
  'Fix the crew swap optimizer to flag commercial flights that depart less than 90 minutes after the last leg lands. The relevant logic is in the optimizer that assigns commercial flights to crew. When a crew member''s last leg lands at time T, no commercial flight departing before T + 90min should be assigned. Add a validation check that surfaces this as a warning/error. See GitHub issue #199.',
  199, '{bug,crew-swap}'
),
(
  'Lock toggle not fully preventing changes',
  'The lock feature on crew assignments only protects against the optimizer overwriting, but locked rows could still be interacted with in the UI. Lock should fully disable all edit controls.',
  20, 'open',
  'Fix the crew lock feature so that when a crew assignment is locked: (1) the optimizer skips it entirely, (2) the UI visually disables all edit controls for that row, (3) no manual changes are possible without first unlocking. See GitHub issue #200.',
  200, '{bug,crew-swap}'
),
(
  'Airport swap doesn''t sync all related fields',
  'When changing the swap airport (e.g. OPF → BZN), the related crew commercial flights and other fields don''t automatically re-sync. User has to manually go through each one.',
  20, 'open',
  'Fix the airport swap feature so that changing the swap airport automatically: (1) clears stale commercial flight assignments for that swap point, (2) re-fetches available flights to/from the new airport, (3) updates crew day calculations. See GitHub issue #201.',
  201, '{bug,crew-swap}'
),
(
  'Assigned crew stuck on tails after re-optimization',
  'Once a crew member gets assigned to a tail, they stay assigned even when re-optimizing. Oncoming crew should be able to move between tails unless explicitly locked.',
  20, 'open',
  'Fix the optimizer so that unless a crew member is explicitly locked to a tail, the optimizer is free to reassign oncoming crew across tails to find the best overall solution. Currently once names are assigned, they "stick" even on re-optimization. See GitHub issue #202.',
  202, '{bug,crew-swap}'
),
(
  'Day-specific crew swap options (Tue/Wed)',
  'Add ability to generate separate swap plans per day — e.g. a Tuesday swap plan vs. a Wednesday swap plan — so ops can compare and pick the best one.',
  50, 'open',
  'Add a day selector to the crew swap optimizer that lets users generate separate optimization plans for different days (e.g., Tuesday vs Wednesday). The UI should allow comparing plans side-by-side. Some swaps are better done one day vs another. See GitHub issue #203.',
  203, '{enhancement,crew-swap}'
),
(
  'Paired crew scheduling support',
  'Support paired crew scheduling — e.g. have Hussey go on early Tuesday to fly with one person, then on Wednesday fly with a different partner.',
  50, 'open',
  'Add paired crew scheduling to the optimizer. Users should be able to define crew pairs per day (e.g., "Person A with Person B on Tuesday, Person A with Person C on Wednesday"). The optimizer should respect these pair constraints when assigning swaps. See GitHub issue #204.',
  204, '{enhancement,crew-swap}'
),
(
  'Use master weekly crew sheet as single source of truth',
  'Stop pulling from multiple Google Sheet sources. Use only the master weekly crew schedule sheet to avoid formatting inconsistencies.',
  50, 'open',
  'Refactor the crew data ingestion to use only the master weekly crew schedule Google Sheet as the single input source. Remove or deprecate the multi-sheet approach. The master sheet is maintained by ops and edited by crew schedulers. See GitHub issue #205.',
  205, '{enhancement,crew-swap}'
),
(
  'Sheet data validation before optimization',
  'Add validation step before optimizer runs to catch formatting issues, missing data, and inconsistencies in the Google Sheet input.',
  50, 'open',
  'Add a validation step that runs before the crew swap optimizer. It should: (1) validate all required fields are present and correctly formatted, (2) check for consistent time formats, airport codes, crew names, (3) surface clear error messages (e.g., "Row 12: missing departure time"), (4) block optimization if critical errors found. See GitHub issue #206.',
  206, '{enhancement,crew-swap}'
);
