-- Migration: Auto-increment/decrement remaining_files count in rooms
-- This ensures Burn Mode (One-Time Download) correctly tracks how many files are left.

-- 1. Function to increment count on file upload
CREATE OR REPLACE FUNCTION increment_room_file_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE rooms
  SET remaining_files = COALESCE(remaining_files, 0) + 1
  WHERE id = NEW.room_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Function to decrement count on file deletion
CREATE OR REPLACE FUNCTION decrement_room_file_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE rooms
  SET remaining_files = GREATEST(0, COALESCE(remaining_files, 0) - 1)
  WHERE id = OLD.room_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- 3. Triggers
DROP TRIGGER IF EXISTS after_file_insert ON files;
CREATE TRIGGER after_file_insert
AFTER INSERT ON files
FOR EACH ROW
EXECUTE FUNCTION increment_room_file_count();

DROP TRIGGER IF EXISTS after_file_delete ON files;
CREATE TRIGGER after_file_delete
AFTER DELETE ON files
FOR EACH ROW
EXECUTE FUNCTION decrement_room_file_count();
