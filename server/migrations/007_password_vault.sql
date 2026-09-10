-- Recoverable password storage for the owner console.
--
-- This exists because the operator explicitly requires "Kennwort anzeigen" in
-- the superadmin area. It does NOT replace the Argon2id hash: authentication
-- still verifies against password_hash and nothing else, so login security is
-- unchanged. What is added is a second, separately encrypted copy of the
-- plaintext, openable only with PASSWORD_VAULT_KEY and only by a role holding
-- users.password_reveal.
--
-- The consequence is deliberate and must not be forgotten: anyone who obtains
-- both the database and the key obtains every stored password.

ALTER TABLE users ADD COLUMN password_vault {{TEXT}};
ALTER TABLE users ADD COLUMN password_vault_at {{TS}};
ALTER TABLE users ADD COLUMN password_vault_key_id {{TEXT}};
