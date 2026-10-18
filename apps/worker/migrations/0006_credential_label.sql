-- Passkey management (T8.7): an optional name the person gives each passkey ("Work laptop").
ALTER TABLE credentials ADD COLUMN label TEXT;
