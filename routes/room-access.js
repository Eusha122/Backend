import express from 'express';
import { logAccess } from '../lib/access-logger.js';
import { supabase } from '../lib/supabase.js';
import {
    ACTIVE_WINDOW_SECONDS,
    countActiveGuests,
    isAuthorForRoom,
    upsertGuestPresence
} from '../lib/presence.js';
import { isAuthorToken } from '../lib/room-auth.js';

const router = express.Router();

const getRoom = async (roomId) => {
    const { data, error } = await supabase
        .from('rooms')
        .select('id, max_concurrent_users')
        .eq('id', roomId)
        .single();

    if (error || !data) return null;

    // Secrets are isolated in room_secrets (service-role backend only).
    const { data: secret } = await supabase
        .from('room_secrets')
        .select('author_token')
        .eq('room_id', roomId)
        .maybeSingle();

    return {
        ...data,
        author_token: secret?.author_token || null
    };
};

const enforceCapacityAndUpsertGuest = async (roomId, deviceId, maxUsers) => {
    // Guests-ever semantics: a guest slot is consumed on first join and never freed until room deletion.
    // We intentionally do not call the join_guest_presence RPC here because it enforces "active window"
    // semantics, which would allow slots to free up after a guest leaves.
    const guestsExcludingSelf = await countActiveGuests(roomId, deviceId);
    if (maxUsers < 999 && guestsExcludingSelf >= maxUsers) {
        return { allowed: false };
    }

    await upsertGuestPresence(roomId, deviceId);
    return { allowed: true };
};

// POST /api/room-access - Join/access event (guest only)
router.post('/', async (req, res) => {
    try {
        const { roomId, sessionId, deviceId, authorToken } = req.body;

        if (!roomId || !deviceId) {
            return res.status(400).json({ error: 'Missing roomId or deviceId' });
        }

        const room = await getRoom(roomId);
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }

        // Author is never inserted into presence and never counted.
        if (isAuthorForRoom(room.author_token, authorToken)) {
            return res.json({ success: true, skipped: 'author' });
        }

        const maxUsers = room.max_concurrent_users || 999;
        const joinResult = await enforceCapacityAndUpsertGuest(roomId, deviceId, maxUsers);
        if (!joinResult.allowed) {
            return res.status(403).json({ error: 'Room is full', isFull: true });
        }

        let guestNumber = null;
        try {
            const { data } = await supabase.rpc('assign_user_number', {
                p_room_id: roomId,
                p_device_id: deviceId
            });
            guestNumber = data;
        } catch (err) {
            console.error('[Room Access] Failed to assign user number:', err);
        }

        // Log join only once per room/device lifecycle.
        const { data: existingLog } = await supabase
            .from('access_logs')
            .select('id')
            .eq('room_id', roomId)
            .eq('device_id', deviceId)
            .eq('event_type', 'room_access')
            .limit(1)
            .maybeSingle();

        if (!existingLog) {
            await logAccess(roomId, 'room_access', req, sessionId, deviceId, guestNumber);
        }

        return res.json({ success: true, guestNumber });
    } catch (error) {
        console.error('[Room Access] Error:', error);
        return res.status(500).json({ error: 'Failed to log access' });
    }
});

// POST /api/room-access/presence - Heartbeat (guest only)
router.post('/presence', async (req, res) => {
    try {
        const { roomId, deviceId, authorToken } = req.body;
        if (!roomId || !deviceId) {
            return res.status(400).json({ error: 'Missing roomId or deviceId' });
        }

        const room = await getRoom(roomId);
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }

        // Author heartbeat is ignored automatically.
        if (isAuthorForRoom(room.author_token, authorToken)) {
            return res.json({ success: true, skipped: 'author' });
        }

        const maxUsers = room.max_concurrent_users || 999;
        const heartbeatResult = await enforceCapacityAndUpsertGuest(roomId, deviceId, maxUsers);
        if (!heartbeatResult.allowed) {
            return res.status(403).json({ error: 'Room is full', isFull: true });
        }

        return res.json({ success: true });
    } catch (error) {
        console.error('[Presence] Error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/room-access/leave - Leave event (log only, no presence mutation)
router.post('/leave', express.urlencoded({ extended: false }), async (req, res) => {
    try {
        const { roomId, deviceId } = req.body;

        if (roomId && deviceId) {
            await logAccess(roomId, 'leave', req, null, deviceId);
        }

        return res.sendStatus(204);
    } catch (error) {
        console.error('[Leave] Error:', error);
        return res.sendStatus(204);
    }
});

// GET /api/room-access/activity/:roomId - Guest activity feed
router.get('/activity/:roomId', async (req, res) => {
    try {
        const { roomId } = req.params;
        const authorToken = req.headers['x-author-token'];

        const isAuthor = await isAuthorToken(roomId, authorToken);
        if (!isAuthor) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const { data: logs, error: logsError } = await supabase
            .from('access_logs')
            .select('event_type, device_id, created_at, browser, os, city, country')
            .eq('room_id', roomId)
            .neq('event_type', 'leave')
            .order('created_at', { ascending: false })
            .limit(50);

        if (logsError) {
            return res.status(500).json({ error: 'Failed to fetch activity' });
        }

        const { data: userMap } = await supabase
            .from('room_user_index')
            .select('device_id, user_number')
            .eq('room_id', roomId);

        const deviceToNumber = Object.fromEntries(
            userMap?.map((u) => [u.device_id, u.user_number]) || []
        );

        const activities = (logs || []).map((log) => {
            const guestNumber = deviceToNumber[log.device_id];
            const label = guestNumber ? `Guest ${guestNumber}` : 'Guest';

            let action = log.event_type;
            if (log.event_type === 'room_access') action = 'joined the room';
            if (log.event_type === 'file_download') action = 'downloaded a file';
            if (log.event_type === 'file_upload') action = 'uploaded a file';
            if (log.event_type === 'bulk_download') action = 'downloaded all files';

            return {
                label: `${label} ${action}`,
                location: [log.city, log.country].filter(Boolean).join(', ') || 'Unknown',
                device: [log.os, log.browser].filter(Boolean).join(' - ') || 'Unknown',
                time: log.created_at
            };
        });

        return res.json({ activities });
    } catch (error) {
        console.error('[Activity] Error:', error);
        return res.status(500).json({ error: 'Failed to fetch activity' });
    }
});

export default router;
