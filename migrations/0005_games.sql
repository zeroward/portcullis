CREATE TABLE games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  presentation jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE services ADD COLUMN game_id uuid REFERENCES games(id);
CREATE INDEX services_game ON services(game_id);
CREATE TABLE game_favorites (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  game_id uuid REFERENCES games(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,game_id)
);
INSERT INTO games(id,presentation)
SELECT id, jsonb_build_object('name',name,'summary',summary,'description',coalesce(metadata->>'description',''),'cover',coalesce(metadata->>'cover',''),'source',metadata->'source')
FROM services WHERE metadata->>'type'='game';
UPDATE services SET game_id=id WHERE metadata->>'type'='game';
INSERT INTO game_favorites SELECT f.user_id,s.game_id FROM favorites f JOIN services s ON s.id=f.service_id WHERE s.game_id IS NOT NULL;
CREATE TABLE game_imports (
  service_id uuid PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  instance text NOT NULL,
  identifier text NOT NULL,
  allocation_id integer,
  snapshot jsonb NOT NULL DEFAULT '{}',
  connection_override jsonb,
  state text NOT NULL DEFAULT 'current',
  synced_at timestamptz,
  UNIQUE(instance,identifier)
);
CREATE TABLE game_submissions (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id),
  result jsonb NOT NULL
);
-- Older API clients can still create game servers without orphaning them.
CREATE FUNCTION ensure_service_game() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.game_id IS NOT NULL AND NEW.metadata->>'type' IS DISTINCT FROM 'game' THEN
    RAISE EXCEPTION 'game_server_type_required' USING ERRCODE='23514';
  END IF;
  IF NEW.metadata->>'type'='game' AND NEW.game_id IS NULL THEN
    INSERT INTO games(presentation) VALUES (jsonb_build_object('name',NEW.name,'summary',NEW.summary,'description',coalesce(NEW.metadata->>'description',''),'cover',coalesce(NEW.metadata->>'cover',''))) RETURNING id INTO NEW.game_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_game BEFORE INSERT OR UPDATE ON services FOR EACH ROW EXECUTE FUNCTION ensure_service_game();
