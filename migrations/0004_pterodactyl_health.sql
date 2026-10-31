ALTER TABLE health_checks DROP CONSTRAINT IF EXISTS health_checks_kind_check;
ALTER TABLE health_checks ADD CONSTRAINT health_checks_kind_check CHECK (kind IN ('http', 'tcp', 'manual', 'kuma', 'waygate', 'incoming', 'pterodactyl'));
