import express from 'express';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

// Helper to get start dates
const getStartDate = (period) => {
    const now = new Date();
    if (period === 'hour') now.setHours(now.getHours() - 1);
    if (period === 'day') now.setHours(0, 0, 0, 0);
    if (period === 'week') now.setDate(now.getDate() - 7);
    return now.toISOString();
};

// GET /api/analytics/live - Live dashboard stats
router.get('/live', async (req, res) => {
    try {
        // 1. Active Users (IPs seen in last 5 minutes)
        const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { data: activeData, error: activeError } = await supabase
            .from('access_logs')
            .select('ip_address', { count: 'exact', head: true })
            .gt('created_at', fiveMinsAgo);

        // 2. Visitor Counts (Visitors = distinct sessions, simplified as rows for now)
        // Last Hour
        const { count: hourCount } = await supabase
            .from('access_logs')
            .select('id', { count: 'exact', head: true })
            .gt('created_at', getStartDate('hour'));

        // Today
        const { count: dayCount } = await supabase
            .from('access_logs')
            .select('id', { count: 'exact', head: true })
            .gt('created_at', getStartDate('day'));

        // Last 7 Days
        const { count: weekCount } = await supabase
            .from('access_logs')
            .select('id', { count: 'exact', head: true })
            .gt('created_at', getStartDate('week'));

        // Lifetime
        const { count: lifetimeCount } = await supabase
            .from('access_logs')
            .select('id', { count: 'exact', head: true });

        // 3. Active Rooms (Rooms created and not expired)
        const now = new Date().toISOString();
        const { count: activeRoomsCount } = await supabase
            .from('rooms')
            .select('id', { count: 'exact', head: true })
            .gt('expires_at', now);
            
        // 4. Total Files
        const { count: filesCount } = await supabase
            .from('files')
            .select('id', { count: 'exact', head: true });
        
        // 5. Active Rooms List (Top 5 most active)
        // This is complex to query efficiently in one go, we'll fetch recent logs and group
        // For now, let's just return the active rooms count and list 5 active rooms
        const { data: recentRooms } = await supabase
             .from('rooms')
             .select('id, name, created_at, expires_at, author_name')
             .gt('expires_at', now)
             .order('created_at', { ascending: false })
             .limit(5);

        // 6. Map Data (Recent locations - last 100 visits)
        const { data: locationData } = await supabase
            .from('access_logs')
            .select('country, city, ip_address, created_at')
            .limit(100)
            .order('created_at', { ascending: false });

        res.json({
            visitors: {
                active: activeData?.length || 0, // Approximate active users
                hour: hourCount || 0,
                today: dayCount || 0,
                week: weekCount || 0,
                lifetime: lifetimeCount || 0
            },
            rooms: {
                active: activeRoomsCount || 0,
                list: recentRooms || []
            },
            files: {
                total: filesCount || 0
            },
            locations: locationData || []
        });

    } catch (error) {
        console.error('Analytics Error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

export default router;
