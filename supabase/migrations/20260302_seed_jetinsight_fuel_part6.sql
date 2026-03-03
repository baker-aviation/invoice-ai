-- JetInsight fuel seed — Part 6 of 6
-- Rows 2001 to 2011

INSERT INTO fuel_prices (
  document_id, airport_code, vendor_name,
  base_price_per_gallon, effective_price_per_gallon, gallons, fuel_total,
  invoice_date, data_source
)
VALUES
  ('jetinsight-PBI-2026-02-28-ea9c3d01', 'PBI', 'Jet Aviation', 4.68688, 4.68688, 901.0, 4222.88, '2026-02-28', 'jetinsight'),
  ('jetinsight-IAD-2026-02-28-f25b0173', 'IAD', 'Atlantic Aviation', 6.23811, 6.23811, 1035.0, 6456.44, '2026-02-28', 'jetinsight'),
  ('jetinsight-MCC-2026-02-28-ce9e9266', 'MCC', 'Mcclellan Jet Services', 6.31366, 6.31366, 1250.0, 7892.08, '2026-02-28', 'jetinsight'),
  ('jetinsight-TEB-2026-02-28-51203210', 'TEB', 'Jet Aviation', 5.14455, 5.14455, 750.0, 3858.41, '2026-02-28', 'jetinsight'),
  ('jetinsight-BCT-2026-02-28-42d12f0f', 'BCT', 'Atlantic Aviation', 10.84471, 10.84471, 722.0, 7829.88, '2026-02-28', 'jetinsight'),
  ('jetinsight-AUS-2026-02-28-58d1794d', 'AUS', 'Atlantic Aviation', 4.75, 4.75, 539.0, 2560.25, '2026-02-28', 'jetinsight'),
  ('jetinsight-BZN-2026-02-28-bbf14782', 'BZN', 'Jet Aviation', 4.57, 4.57, 652.0, 2979.64, '2026-02-28', 'jetinsight'),
  ('jetinsight-BCT-2026-02-28-7ec25896', 'BCT', 'Atlantic Aviation', 4.38, 4.38, 650.0, 2847.0, '2026-02-28', 'jetinsight'),
  ('jetinsight-SFO-2026-02-28-02ce812a', 'SFO', 'Signature Aviation', 8.53643, 8.53643, 456.0, 3892.61, '2026-02-28', 'jetinsight'),
  ('jetinsight-BOI-2026-02-28-4cd0b619', 'BOI', 'Jackson Jet Center', 6.99, 6.99, 376.0, 2628.24, '2026-02-28', 'jetinsight'),
  ('jetinsight-BED-2026-02-28-8f74db16', 'BED', 'Jet Aviation', 5.02, 5.02, 890.0, 4467.8, '2026-02-28', 'jetinsight')
ON CONFLICT (document_id) DO NOTHING;
