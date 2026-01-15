import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();

// Get current room capacity (active devices in room_presence, excluding authors)
router.get('/:roomId', async (req, res) => {
    try {
        const { roomId } = req.params;

        // Get room details with max_concurrent_users
        const { data: room, error: roomError } = await supabase
            .from('rooms')
            .select('max_concurrent_users, name')
            .eq('id', roomId)
            .single();

        if (roomError || !room) {
            return res.status(404).json({ error: 'Room not found' });
        }

        const maxUsers = room.max_concurrent_users || 999; // Default to unlimited

        // Count active devices (NOT authors) seen in last 30 seconds
        const THIRTY_SECONDS_AGO = new Date(Date.now() - 30 * 1000).toISOString();

        const { count, error: countError } = await supabase
            .from('room_presence')
            .select('*', { count: 'exact', head: true })
            .eq('room_id', roomId)
            .eq('is_author', false)
            .eq('status', 'active')
            .gte('last_seen_at', THIRTY_SECONDS_AGO);

        if (countError) {
            console.error('Error counting presence:', countError);
            return res.status(500).json({ error: 'Failed to fetch capacity' });
        }

        const currentUsers = count || 0;

        // Block if adding ONE MORE user would exceed limit
        const isFull = maxUsers < 999 && currentUsers >= maxUsers;
        const isNearFull = maxUsers < 999 && currentUsers >= maxUsers * 0.8;

        console.log(`[Capacity] Room: ${roomId.substring(0, 8)}..., Current: ${currentUsers}, Max: ${maxUsers}, Full: ${isFull}`);

        res.json({
            current: currentUsers,
            max: maxUsers,
            isFull,
            isNearFull,
            isUnlimited: maxUsers >= 999
        });

    } catch (error) {
        console.error('[Room Capacity Error]', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
