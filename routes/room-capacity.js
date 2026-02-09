import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { countActiveGuests } from '../lib/presence.js';

const router = Router();

// Get current room capacity (active guests only)
router.get('/:roomId', async (req, res) => {
    try {
        const { roomId } = req.params;

        const { data: room, error: roomError } = await supabase
            .from('rooms')
            .select('max_concurrent_users')
            .eq('id', roomId)
            .single();

        if (roomError || !room) {
            return res.status(404).json({ error: 'Room not found' });
        }

        const used = await countActiveGuests(roomId);
        const maxUsers = room.max_concurrent_users || 999;

        res.json({
            current: used,
            max: maxUsers,
            isFull: used >= maxUsers,
            isNearFull: used >= maxUsers * 0.8,
            isUnlimited: maxUsers >= 999
        });

    } catch (error) {
        console.error('[Room Capacity Error]', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
