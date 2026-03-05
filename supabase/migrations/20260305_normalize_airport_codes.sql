-- Normalize ICAO K-prefix airport codes to FAA 3-letter codes (KBOS → BOS)
-- Applies to parsed_invoices and fuel_prices tables.

UPDATE parsed_invoices
SET airport_code = SUBSTRING(airport_code FROM 2)
WHERE airport_code ~ '^K[A-Z]{3}$';

UPDATE fuel_prices
SET airport_code = SUBSTRING(airport_code FROM 2)
WHERE airport_code ~ '^K[A-Z]{3}$';
