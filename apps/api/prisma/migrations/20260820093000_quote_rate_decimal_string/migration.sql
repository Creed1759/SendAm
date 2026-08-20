-- Store exchange rates as decimal strings so quotes do not reintroduce
-- binary floating-point artifacts after exact money calculations.
ALTER TABLE "Quote" ALTER COLUMN "rate" TYPE TEXT USING "rate"::TEXT;
