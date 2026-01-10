import express from 'express';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

// GET /api/access-logs/:roomId - Get access logs for a room
router.get('/:roomId', async (req, res) => {
    try {
        const { roomId } = req.params;

        // Fetch access logs for this room
        const { data: logs, error } = await supabase
            .from('access_logs')
            .select('*')
            .eq('room_id', roomId)
            .order('created_at', { ascending: false })
            .limit(50); // Last 50 events

        if (error) throw error;

        res.json({ logs: logs || [] });
    } catch (error) {
        console.error('Error fetching access logs:', error);
        res.status(500).json({ error: 'Failed to fetch access logs' });
    }
});

export default router;
