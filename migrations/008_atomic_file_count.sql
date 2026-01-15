-- Migration: Add atomic increment/decrement functions for remaining_files
-- These avoid race conditions when multiple files are uploaded/downloaded simultaneously

-- 1. Atomic increment function
CREATE OR REPLACE FUNCTION increment_remaining_files(room_id_input UUID)
RETURNS void AS $$
BEGIN
    UPDATE rooms 
    SET remaining_files = COALESCE(remaining_files, 0) + 1
    WHERE id = room_id_input;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Atomic decrement function  
CREATE OR REPLACE FUNCTION decrement_remaining_files(room_id_input UUID)
RETURNS integer AS $$
DECLARE
    new_count integer;
BEGIN
    UPDATE rooms 
    SET remaining_files = GREATEST(0, COALESCE(remaining_files, 0) - 1)
    WHERE id = room_id_input
    RETURNING remaining_files INTO new_count;
    
    RETURN new_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION increment_remaining_files(UUID) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION decrement_remaining_files(UUID) TO authenticated, anon, service_role;
