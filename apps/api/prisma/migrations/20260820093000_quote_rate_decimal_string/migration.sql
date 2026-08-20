-- Store exchange rates as decimal strings so quote arithmetic and API responses
-- never depend on database or JavaScript floating-point serialization.
ALTER TABLE "Quote" ALTER COLUMN "rate" TYPE TEXT USING "rate"::TEXT;
