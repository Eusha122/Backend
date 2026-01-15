-- Migration: Presence and Activity System
-- Creates tables for device-based presence tracking and stable guest numbering

-- 1. Room Presence (Current state - who is active NOW)
CREATE TABLE IF NOT EXISTS public.room_presence (
    room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    is_author BOOLEAN DEFAULT false,
    status TEXT DEFAULT 'active',  -- 'active' or 'left' (prevents duplicate leave logs)
    last_seen_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (room_id, device_id)
);

-- 2. User Counter (Atomic numbering - prevents race conditions)
CREATE TABLE IF NOT EXISTS public.room_user_counter (
    room_id UUID PRIMARY KEY REFERENCES public.rooms(id) ON DELETE CASCADE,
    last_number INT DEFAULT 0
);

-- 3. User Index (Stable "Guest 1/2/3" mapping)
CREATE TABLE IF NOT EXISTS public.room_user_index (
    room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    user_number INT NOT NULL,
    PRIMARY KEY (room_id, device_id)
);

-- 4. Add device_id to existing access_logs for activity resolution
ALTER TABLE public.access_logs ADD COLUMN IF NOT EXISTS device_id TEXT;

-- 5. Atomic user assignment function (prevents race condition on concurrent joins)
CREATE OR REPLACE FUNCTION assign_user_number(p_room_id UUID, p_device_id TEXT)
RETURNS INT AS $$
DECLARE
    v_number INT;
BEGIN
    -- Check if already assigned
    SELECT user_number INTO v_number FROM room_user_index 
    WHERE room_id = p_room_id AND device_id = p_device_id;
    IF FOUND THEN RETURN v_number; END IF;
    
    -- Atomically increment counter (INSERT or UPDATE)
    INSERT INTO room_user_counter (room_id, last_number) VALUES (p_room_id, 1)
    ON CONFLICT (room_id) DO UPDATE SET last_number = room_user_counter.last_number + 1
    RETURNING last_number INTO v_number;
    
    -- Insert mapping
    INSERT INTO room_user_index (room_id, device_id, user_number) VALUES (p_room_id, p_device_id, v_number);
    RETURN v_number;
END;
$$ LANGUAGE plpgsql;

-- RLS Policies
ALTER TABLE public.room_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_user_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_user_counter ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all_room_presence" ON public.room_presence FOR ALL USING (true);
CREATE POLICY "allow_all_room_user_index" ON public.room_user_index FOR ALL USING (true);
CREATE POLICY "allow_all_room_user_counter" ON public.room_user_counter FOR ALL USING (true);

-- Comments
COMMENT ON TABLE public.room_presence IS 'Tracks active device presence in rooms with heartbeat';
COMMENT ON TABLE public.room_user_counter IS 'Atomic counter for guest numbering per room';
COMMENT ON TABLE public.room_user_index IS 'Stable Guest 1/2/3 mapping per device per room';
COMMENT ON FUNCTION assign_user_number IS 'Atomically assigns a unique guest number to a device in a room';
