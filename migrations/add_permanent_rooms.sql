-- Migration: Add support for Permanent Rooms and Portfolio Links

-- 1. Add is_permanent column to rooms table
ALTER TABLE rooms 
ADD COLUMN is_permanent BOOLEAN DEFAULT FALSE;

-- 2. Add target_url column to files table
ALTER TABLE files
ADD COLUMN target_url TEXT;

-- 3. Comment explaining the changes
COMMENT ON COLUMN rooms.is_permanent IS 'If true, this room is exempt from hourly cleanup/deletion';
COMMENT ON COLUMN files.target_url IS 'Optional URL for Portfolio Mode. If set, file acts as a link card.';

-- 4. Create the Master Portfolio Room (You can run this multiple times safely)
-- Replace 'YOUR_PASSWORD_HASH_HERE' with a real hash if you want to set it manually, 
-- or just use the app to create a room and then update it using the ID.
-- Ideally, create a room in the App first, then run:
-- UPDATE rooms SET is_permanent = TRUE WHERE id = 'YOUR_ROOM_ID';
