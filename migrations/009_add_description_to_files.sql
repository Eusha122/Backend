-- Migration: Add description field to files table for portfolio cards
ALTER TABLE files ADD COLUMN IF NOT EXISTS description TEXT;

-- Comment for reference
COMMENT ON COLUMN files.description IS 'Optional description for portfolio/exhibition cards';
