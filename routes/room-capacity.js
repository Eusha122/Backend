import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();

// Get current room capacity (unique active sessions in last 5 minutes)
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

        // Count unique IPs in access_logs from last 5 minutes
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

        const { data: recentLogs, error: logsError } = await supabase
            .from('access_logs')
            .select('ip_address')
            .eq('room_id', roomId)
            .gte('created_at', fiveMinutesAgo);

        if (logsError) {
            console.error('Error fetching access logs:', logsError);
            return res.status(500).json({ error: 'Failed to fetch capacity' });
        }

        // Count unique IPs (approximate active users)
        const uniqueIPs = new Set(recentLogs.map(log => log.ip_address));
        const currentUsers = uniqueIPs.size;

        const isFull = maxUsers < 999 && currentUsers >= maxUsers;
        const isNearFull = maxUsers < 999 && currentUsers >= maxUsers * 0.8;

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
