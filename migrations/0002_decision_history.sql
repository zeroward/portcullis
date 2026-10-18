ALTER TABLE decisions DROP CONSTRAINT decisions_request_id_actor_id_key;
ALTER TABLE decisions ADD CONSTRAINT decisions_actor_kind UNIQUE(request_id,actor_id,decision);
