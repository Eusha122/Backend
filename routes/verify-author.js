import express from 'express';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

// POST /api/verify-author - Verify if the provided author token is valid for a room
router.post('/', async (req, res) => {
    try {
        const { roomId, authorToken } = req.body;

        if (!roomId || !authorToken) {
            return res.status(400).json({ valid: false, error: 'Missing roomId or authorToken' });
        }

        // Query the database to verify the token
        const { data: room, error } = await supabase
            .from('rooms')
            .select('author_token')
            .eq('id', roomId)
            .single();

        if (error || !room) {
            return res.json({ valid: false, error: 'Room not found' });
        }

        // Compare tokens securely
        const isValid = room.author_token === authorToken;

        if (!isValid) {
            console.warn(`[Verify Author] Invalid token attempt for room ${roomId.substring(0, 8)}...`);
        }

        res.json({ valid: isValid });
    } catch (error) {
        console.error('[Verify Author] Error:', error);
        res.status(500).json({ valid: false, error: 'Internal server error' });
    }
});

export default router;
