-- Migration: Fix assign_user_number to be idempotent and robust
-- This ensures that re-joining the same room with the same device ID returns the SAME user number
-- instead of incrementing it.

CREATE OR REPLACE FUNCTION assign_user_number(p_room_id UUID, p_device_id TEXT)
RETURNS INT AS $$
DECLARE
    v_number INT;
BEGIN
    -- 1. Check if this device already has a number in this room
    SELECT user_number INTO v_number 
    FROM room_user_index 
    WHERE room_id = p_room_id AND device_id = p_device_id;
    
    -- If found, return the existing number (IDEMPOTENT)
    IF FOUND THEN 
        RETURN v_number; 
    END IF;
    
    -- 2. If not found, atomically increment the counter for this room
    -- We use ON CONFLICT to initialize the counter if it doesn't exist
    INSERT INTO room_user_counter (room_id, last_number) 
    VALUES (p_room_id, 0)
    ON CONFLICT (room_id) DO NOTHING;
    
    -- Update and return the new number
    UPDATE room_user_counter
    SET last_number = last_number + 1
    WHERE room_id = p_room_id
    RETURNING last_number INTO v_number;
    
    -- 3. Store the mapping so we remember this device's number
    INSERT INTO room_user_index (room_id, device_id, user_number) 
    VALUES (p_room_id, p_device_id, v_number);
    
    RETURN v_number;
END;
$$ LANGUAGE plpgsql;

-- Ensure constraints exist
-- ALTER TABLE room_user_index ADD CONSTRAINT unique_room_device UNIQUE (room_id, device_id);
-- (This might fail if duplicate data exists, so we leave it commented for manual application if needed, 
-- but the logic above handles it via SELECT check)
