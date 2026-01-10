-- Add preview_count column to files table
-- This tracks how many times a file has been previewed (viewed without downloading)

ALTER TABLE files 
ADD COLUMN IF NOT EXISTS preview_count INTEGER DEFAULT 0;

-- Update existing files to have preview_count = 0
UPDATE files 
SET preview_count = 0 
WHERE preview_count IS NULL;

-- Add comment for documentation
COMMENT ON COLUMN files.preview_count IS 'Number of times the file has been previewed (not downloaded)';
