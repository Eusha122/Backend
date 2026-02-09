-- Add guest_slots_used column to rooms table
ALTER TABLE rooms ADD COLUMN guest_slots_used integer DEFAULT 0;
