import express from 'express';
import { logAccess } from '../lib/access-logger.js';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

// POST /api/room-access - Log when someone accesses a room (join event)
router.post('/', async (req, res) => {
    try {
        const { roomId, sessionId, deviceId, isAuthor } = req.body;

        if (!roomId) {
            return res.status(400).json({ error: 'Missing roomId' });
        }

        // 1. Authors are INVISIBLE in access logs and capacity
        // They do not consume a seat and are not tracked as guests.
        if (isAuthor) {
            return res.json({ success: true, skipped: 'author' });
        }

        if (!deviceId) {
            return res.status(400).json({ error: 'Missing deviceId' });
        }

        // 2. Assign Guest Number (Idempotent RPC)
        // This must happen BEFORE logging to ensure we have a stable guest number.
        // The RPC handles concurrency and ensures same device = same number.
        let guestNumber = null;
        try {
            const { data, error } = await supabase.rpc('assign_user_number', {
                p_room_id: roomId,
                p_device_id: deviceId
            });

            if (error) throw error;
            guestNumber = data;
        } catch (err) {
            console.error('[Room Access] Failed to assign user number:', err);
            // We continue even if assignment fails, but log error
        }

        // 3. Log Access Event (Deduplicated)
        // Check if this device has ANY access log for this room already
        // We only want to log "Guest X joined" ONCE per device per room lifetime
        const { data: existingLog } = await supabase
            .from('access_logs')
            .select('id')
            .eq('room_id', roomId)
            .eq('device_id', deviceId)
            .eq('event_type', 'room_access')
            .limit(1)
            .single();

        if (!existingLog) {
            // No previous log found -> Log the "Joined" event
            await logAccess(roomId, 'room_access', req, sessionId, deviceId, guestNumber);
        } else {
            // Already logged -> Skip duplicate log
        }

        // 4. Update Presence (Immediate Heartbeat)
        // We also treat this join request as an immediate heartbeat to mark them active
        await supabase
            .from('room_presence')
            .upsert({
                room_id: roomId,
                device_id: deviceId,
                last_seen: new Date().toISOString(),
                is_author: false
            }, { onConflict: 'room_id, device_id' });

        res.json({ success: true, guestNumber });
    } catch (error) {
        console.error('Error logging room access:', error);
        res.status(500).json({ error: 'Failed to log access' });
    }
});

// POST /api/room-access/presence - Heartbeat for presence tracking
router.post('/presence', async (req, res) => {
    try {
        const { roomId, deviceId, isAuthor } = req.body;

        if (!roomId || !deviceId) {
            return res.status(400).json({ error: 'Missing roomId or deviceId' });
        }

        // === SECURITY: Verify room exists before allowing presence update ===
        const { data: room, error: roomError } = await supabase
            .from('rooms')
            .select('id')
            .eq('id', roomId)
            .single();

        if (roomError || !room) {
            return res.status(404).json({ error: 'Room not found' });
        }
        // === END SECURITY ===

        // Atomic user number assignment (prevents race condition)
        // Authors do NOT get a user number - they don't consume capacity slots
        if (!isAuthor) {
            await supabase.rpc('assign_user_number', {
                p_room_id: roomId,
                p_device_id: deviceId
            });
        }

        // Upsert presence (update last_seen_at if exists)
        const { error } = await supabase.from('room_presence').upsert({
            room_id: roomId,
            device_id: deviceId,
            is_author: isAuthor || false,
            status: 'active',
            last_seen_at: new Date().toISOString()
        }, { onConflict: 'room_id,device_id' });

        if (error) {
            console.error('[Presence] Upsert error:', error);
            return res.status(500).json({ error: 'Internal server error' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('[Presence] Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/room-access/leave - Explicit leave (via sendBeacon)
router.post('/leave', express.urlencoded({ extended: false }), async (req, res) => {
    try {
        const { roomId, deviceId } = req.body;

        if (!roomId || !deviceId) {
            return res.sendStatus(204); // No content - beacon might send incomplete data
        }

        // Check if already left (prevents duplicate leave logs)
        const { data: presence } = await supabase
            .from('room_presence')
            .select('status')
            .eq('room_id', roomId)
            .eq('device_id', deviceId)
            .single();

        if (presence?.status === 'active') {
            // Mark as left
            await supabase
                .from('room_presence')
                .update({ status: 'left' })
                .eq('room_id', roomId)
                .eq('device_id', deviceId);

            // Log leave event
            await logAccess(roomId, 'leave', req, null, deviceId);

            console.log(`[Presence] Device ${deviceId.substring(0, 8)}... left room ${roomId.substring(0, 8)}...`);
        }

        res.sendStatus(204);
    } catch (error) {
        console.error('[Leave] Error:', error);
        res.sendStatus(204); // Always return 204 for beacon
    }
});

// GET /api/room-access/activity/:roomId - Activity feed with guest labels
router.get('/activity/:roomId', async (req, res) => {
    try {
        const { roomId } = req.params;

        // Get recent access logs (exclude 'leave' events as they create noise on page refresh)
        const { data: logs, error: logsError } = await supabase
            .from('access_logs')
            .select('event_type, device_id, created_at, browser, os, city, country')
            .eq('room_id', roomId)
            .neq('event_type', 'leave')
            .order('created_at', { ascending: false })
            .limit(50);

        if (logsError) {
            console.error('[Activity] Logs error:', logsError);
            return res.status(500).json({ error: 'Failed to fetch activity' });
        }

        // Get user number mappings for this room
        const { data: userMap } = await supabase
            .from('room_user_index')
            .select('device_id, user_number')
            .eq('room_id', roomId);

        // Get author device ID(s) from presence history (even if they left)
        const { data: authorPresence } = await supabase
            .from('room_presence')
            .select('device_id')
            .eq('room_id', roomId)
            .eq('is_author', true);

        const authorDeviceIds = new Set(authorPresence?.map(a => a.device_id) || []);

        // Create lookup map
        const deviceToNumber = Object.fromEntries(
            userMap?.map(u => [u.device_id, u.user_number]) || []
        );

        // Format activities with "Guest X" or "Author" labels
        const activities = logs?.map(log => {
            let label = 'Unknown';

            if (authorDeviceIds.has(log.device_id)) {
                label = 'Author';
            } else {
                const guestNumber = deviceToNumber[log.device_id];
                if (guestNumber) {
                    label = `Guest ${guestNumber}`;
                }
            }

            let action;
            switch (log.event_type) {
                case 'room_access':
                    action = 'joined the room';
                    break;
                case 'leave':
                    action = 'left the room';
                    break;
                case 'file_download':
                    action = 'downloaded a file';
                    break;
                case 'file_upload':
                    action = 'uploaded a file';
                    break;
                case 'bulk_download':
                    action = 'downloaded all files';
                    break;
                default:
                    action = log.event_type;
            }

            return {
                label: `${label} ${action}`,
                location: [log.city, log.country].filter(Boolean).join(', ') || 'Unknown',
                device: [log.os, log.browser].filter(Boolean).join(' - ') || 'Unknown',
                time: log.created_at
            };
        }) || [];

        res.json({ activities });
    } catch (error) {
        console.error('[Activity] Error:', error);
        res.status(500).json({ error: 'Failed to fetch activity' });
    }
});

export default router;
