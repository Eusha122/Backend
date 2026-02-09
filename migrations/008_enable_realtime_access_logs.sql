-- Enable Realtime for access_logs table
-- This is required for the frontend to receive INSERT events
BEGIN;
  -- Check if table exists first (it should)
  -- Add table to the default supabase_realtime publication
  ALTER PUBLICATION supabase_realtime ADD TABLE access_logs;
COMMIT;
