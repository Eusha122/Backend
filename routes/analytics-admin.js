import express from 'express';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

const DEFAULT_DAYS = 7;
const MAX_DAYS = 365;
const MAX_ROWS = 20000;
const PAGE_SIZE = 1000;

const parseDays = (value, fallback = DEFAULT_DAYS) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(MAX_DAYS, Math.floor(parsed));
};

const getStartDateIso = (days) => {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    return start.toISOString();
};

const toDayKey = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);

const buildDailySeries = (rows, days, timestampKey = 'created_at') => {
    const counts = new Map();
    for (let offset = days - 1; offset >= 0; offset -= 1) {
        const date = new Date();
        date.setUTCHours(0, 0, 0, 0);
        date.setUTCDate(date.getUTCDate() - offset);
        counts.set(date.toISOString().slice(0, 10), 0);
    }

    for (const row of rows) {
        const ts = row?.[timestampKey];
        if (!ts) continue;
        const key = toDayKey(ts);
        if (!counts.has(key)) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
    }

    return Array.from(counts.entries()).map(([date, value]) => ({ date, value }));
};

const fetchPaged = async (buildQuery) => {
    const rows = [];
    let start = 0;

    while (rows.length < MAX_ROWS) {
        const end = start + PAGE_SIZE - 1;
        const { data, error } = await buildQuery().range(start, end);
        if (error) throw error;
        if (!data || data.length === 0) break;

        rows.push(...data);
        if (data.length < PAGE_SIZE) break;
        start += PAGE_SIZE;
    }

    return rows;
};

const requireAdminToken = (req, res, next) => {
    const expectedToken = process.env.ANALYTICS_ADMIN_TOKEN;
    if (!expectedToken) {
        return res.status(404).json({ error: 'Not found' });
    }

    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
        return res.status(404).json({ error: 'Not found' });
    }

    const providedToken = authHeader.slice(7).trim();
    if (!providedToken || providedToken !== expectedToken) {
        return res.status(404).json({ error: 'Not found' });
    }

    return next();
};

router.use(requireAdminToken);

router.get('/realtime', async (req, res) => {
    try {
        const activeWindowMs = Number(process.env.PRESENCE_WINDOW_MS || 120000);
        const activeSince = new Date(Date.now() - activeWindowMs).toISOString();
        const minuteAgo = new Date(Date.now() - 60 * 1000).toISOString();

        const [presenceRows, eventsCountResult] = await Promise.all([
            fetchPaged(() =>
                supabase
                    .from('room_presence')
                    .select('room_id,device_id,last_seen_at')
                    .gte('last_seen_at', activeSince)
                    .order('last_seen_at', { ascending: false })
            ),
            supabase
                .from('access_logs')
                .select('id', { count: 'exact', head: true })
                .gte('created_at', minuteAgo),
        ]);

        if (eventsCountResult.error) throw eventsCountResult.error;

        const uniqueDevices = new Set();
        const roomCounts = new Map();

        for (const row of presenceRows) {
            uniqueDevices.add(row.device_id);
            roomCounts.set(row.room_id, (roomCounts.get(row.room_id) || 0) + 1);
        }

        const sortedRooms = Array.from(roomCounts.entries())
            .map(([roomId, activeUsers]) => ({ roomId, activeUsers }))
            .sort((a, b) => b.activeUsers - a.activeUsers)
            .slice(0, 10);

        let roomNames = new Map();
        if (sortedRooms.length > 0) {
            const roomIds = sortedRooms.map((item) => item.roomId);
            const { data, error } = await supabase
                .from('rooms')
                .select('id,name')
                .in('id', roomIds);
            if (error) throw error;
            roomNames = new Map((data || []).map((room) => [room.id, room.name]));
        }

        const topRooms = sortedRooms.map((item) => ({
            roomId: item.roomId,
            roomName: roomNames.get(item.roomId) || null,
            activeUsers: item.activeUsers,
        }));

        return res.json({
            asOf: new Date().toISOString(),
            windowSeconds: Math.max(1, Math.floor(activeWindowMs / 1000)),
            activeUsersNow: uniqueDevices.size,
            activeRoomsNow: roomCounts.size,
            eventsLastMinute: eventsCountResult.count || 0,
            topRooms,
        });
    } catch (error) {
        console.error('[Analytics Admin] realtime failed:', error);
        return res.status(500).json({ error: 'Failed to fetch realtime analytics' });
    }
});

router.get('/summary', async (req, res) => {
    try {
        const days = parseDays(req.query.days, DEFAULT_DAYS);
        const startIso = getStartDateIso(days);

        const [
            roomRows,
            fileRows,
            chatRows,
            downloadRows,
            inviteRows,
            visitRows,
            allTimeRooms,
            allTimeFiles,
            allTimeChats,
        ] = await Promise.all([
            fetchPaged(() =>
                supabase
                    .from('rooms')
                    .select('id,created_at')
                    .gte('created_at', startIso)
                    .order('created_at', { ascending: false })
            ),
            fetchPaged(() =>
                supabase
                    .from('files')
                    .select('id,uploaded_at,size')
                    .gte('uploaded_at', startIso)
                    .order('uploaded_at', { ascending: false })
            ),
            fetchPaged(() =>
                supabase
                    .from('room_chat_messages')
                    .select('id,created_at')
                    .gte('created_at', startIso)
                    .order('created_at', { ascending: false })
            ),
            fetchPaged(() =>
                supabase
                    .from('access_logs')
                    .select('id,created_at')
                    .eq('event_type', 'file_download')
                    .gte('created_at', startIso)
                    .order('created_at', { ascending: false })
            ),
            fetchPaged(() =>
                supabase
                    .from('access_logs')
                    .select('id,created_at')
                    .eq('event_type', 'invite_sent')
                    .gte('created_at', startIso)
                    .order('created_at', { ascending: false })
            ),
            fetchPaged(() =>
                supabase
                    .from('access_logs')
                    .select('id,created_at')
                    .eq('event_type', 'room_access')
                    .gte('created_at', startIso)
                    .order('created_at', { ascending: false })
            ),
            supabase.from('rooms').select('id', { count: 'exact', head: true }),
            supabase.from('files').select('id', { count: 'exact', head: true }),
            supabase.from('room_chat_messages').select('id', { count: 'exact', head: true }),
        ]);

        if (allTimeRooms.error) throw allTimeRooms.error;
        if (allTimeFiles.error) throw allTimeFiles.error;
        if (allTimeChats.error) throw allTimeChats.error;

        const bytesUploaded = fileRows.reduce((sum, row) => sum + Number(row.size || 0), 0);

        return res.json({
            periodDays: days,
            startDate: startIso,
            totals: {
                roomsCreated: roomRows.length,
                filesUploaded: fileRows.length,
                bytesUploaded,
                downloads: downloadRows.length,
                invitesSent: inviteRows.length,
                chatMessages: chatRows.length,
                roomVisits: visitRows.length,
            },
            allTime: {
                rooms: allTimeRooms.count || 0,
                files: allTimeFiles.count || 0,
                chatMessages: allTimeChats.count || 0,
            },
            series: {
                roomsCreated: buildDailySeries(roomRows, days),
                filesUploaded: buildDailySeries(fileRows, days, 'uploaded_at'),
                downloads: buildDailySeries(downloadRows, days),
                invitesSent: buildDailySeries(inviteRows, days),
                chatMessages: buildDailySeries(chatRows, days),
                roomVisits: buildDailySeries(visitRows, days),
            },
        });
    } catch (error) {
        console.error('[Analytics Admin] summary failed:', error);
        return res.status(500).json({ error: 'Failed to fetch summary analytics' });
    }
});

router.get('/geo', async (req, res) => {
    try {
        const days = parseDays(req.query.days, 30);
        const startIso = getStartDateIso(days);
        const regionNames = Intl.DisplayNames ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;

        const rows = await fetchPaged(() =>
            supabase
                .from('access_logs')
                .select('country,created_at')
                .gte('created_at', startIso)
                .not('country', 'is', null)
                .order('created_at', { ascending: false })
        );

        const countryCounts = new Map();

        for (const row of rows) {
            const raw = String(row.country || '').trim();
            if (!raw) continue;

            let countryCode = null;
            let countryName = raw;

            if (/^[a-z]{2}$/i.test(raw)) {
                countryCode = raw.toUpperCase();
                countryName = regionNames?.of(countryCode) || countryCode;
            }

            const key = countryName.toLowerCase();
            const current = countryCounts.get(key) || { country: countryName, countryCode, count: 0 };
            current.count += 1;
            countryCounts.set(key, current);
        }

        const countries = Array.from(countryCounts.values()).sort((a, b) => b.count - a.count);

        return res.json({
            periodDays: days,
            startDate: startIso,
            totalEvents: countries.reduce((sum, item) => sum + item.count, 0),
            countries,
        });
    } catch (error) {
        console.error('[Analytics Admin] geo failed:', error);
        return res.status(500).json({ error: 'Failed to fetch geo analytics' });
    }
});

router.get('/tech', async (req, res) => {
    try {
        const days = parseDays(req.query.days, 30);
        const startIso = getStartDateIso(days);

        const rows = await fetchPaged(() =>
            supabase
                .from('access_logs')
                .select('browser,os,device_type,created_at')
                .gte('created_at', startIso)
                .order('created_at', { ascending: false })
        );

        const bucketCount = (key) => {
            const map = new Map();
            for (const row of rows) {
                const value = String(row[key] || 'Unknown').trim() || 'Unknown';
                map.set(value, (map.get(value) || 0) + 1);
            }
            return Array.from(map.entries())
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count);
        };

        return res.json({
            periodDays: days,
            startDate: startIso,
            totalEvents: rows.length,
            browser: bucketCount('browser'),
            os: bucketCount('os'),
            deviceType: bucketCount('device_type'),
        });
    } catch (error) {
        console.error('[Analytics Admin] tech failed:', error);
        return res.status(500).json({ error: 'Failed to fetch tech analytics' });
    }
});

router.get('/returning', async (req, res) => {
    try {
        const days = parseDays(req.query.days, 30);
        const startIso = getStartDateIso(days);

        const rows = await fetchPaged(() =>
            supabase
                .from('access_logs')
                .select('device_id,created_at')
                .gte('created_at', startIso)
                .not('device_id', 'is', null)
                .order('created_at', { ascending: false })
        );

        const deviceDays = new Map();
        const dailyDevices = new Map();

        for (const row of rows) {
            const deviceId = String(row.device_id || '').trim();
            if (!deviceId) continue;
            const day = toDayKey(row.created_at);

            if (!deviceDays.has(deviceId)) deviceDays.set(deviceId, new Set());
            deviceDays.get(deviceId).add(day);

            if (!dailyDevices.has(day)) dailyDevices.set(day, new Set());
            dailyDevices.get(day).add(deviceId);
        }

        const totalUsers = deviceDays.size;
        const returningUsers = Array.from(deviceDays.values()).filter((set) => set.size > 1).length;
        const newUsers = Math.max(0, totalUsers - returningUsers);

        const allDays = [];
        for (let offset = days - 1; offset >= 0; offset -= 1) {
            const date = new Date();
            date.setUTCHours(0, 0, 0, 0);
            date.setUTCDate(date.getUTCDate() - offset);
            allDays.push(date.toISOString().slice(0, 10));
        }

        const seenBefore = new Set();
        const daily = allDays.map((day) => {
            const daySet = dailyDevices.get(day) || new Set();
            let returning = 0;
            for (const deviceId of daySet) {
                if (seenBefore.has(deviceId)) returning += 1;
            }
            for (const deviceId of daySet) {
                seenBefore.add(deviceId);
            }
            return {
                date: day,
                activeUsers: daySet.size,
                returningUsers: returning,
                newUsers: Math.max(0, daySet.size - returning),
            };
        });

        return res.json({
            periodDays: days,
            startDate: startIso,
            totals: {
                totalUsers,
                returningUsers,
                newUsers,
                returningRate: totalUsers > 0 ? Number((returningUsers / totalUsers).toFixed(4)) : 0,
            },
            daily,
        });
    } catch (error) {
        console.error('[Analytics Admin] returning failed:', error);
        return res.status(500).json({ error: 'Failed to fetch returning analytics' });
    }
});

export default router;
