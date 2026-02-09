import { supabase } from './supabase.js';
import { getGeolocation } from './geolocation.js';
import { parseUserAgent } from './user-agent-parser.js';
import { getClientIP } from './ip-utils.js';

// ============================================
// IDEMPOTENCY GUARD - Prevents duplicate logs
// ============================================
// In-memory cache for recent log entries (TTL: 3 seconds)
const recentLogs = new Map();
const DEDUP_WINDOW_MS = 3000; // 3-second deduplication window

// Cleanup old logs every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of recentLogs.entries()) {
        if (now - timestamp > 3000) { // 3 seconds window
            recentLogs.delete(key);
        }
    }
}, 300000);

/**
 * Generate idempotency key from log parameters
 * Format: roomId:eventType:deviceId
 */
function getIdempotencyKey(roomId, eventType, deviceId) {
    return `${roomId}:${eventType}:${deviceId || 'unknown'}`;
}

/**
 * Check if this log was recently recorded (within dedup window)
 * Returns true if duplicate, false if new
 */
function isDuplicate(key) {
    const lastLogged = recentLogs.get(key);
    if (lastLogged && Date.now() - lastLogged < DEDUP_WINDOW_MS) {
        return true;
    }
    recentLogs.set(key, Date.now());
    return false;
}

export async function logAccess(roomId, eventType, req, sessionId = null, deviceId = null, guestNumber = null) {
    try {
        console.log(`[AccessLogger] logAccess called: ${eventType} for room ${roomId?.substring(0, 8)}...`);

        // IDEMPOTENCY CHECK - Skip if duplicate within 2 seconds
        const idempotencyKey = getIdempotencyKey(roomId, eventType, deviceId);
        if (isDuplicate(idempotencyKey)) {
            console.log(`[AccessLogger] SKIPPED duplicate: ${eventType} for device ${deviceId?.substring(0, 8) || 'unknown'} (Key: ${idempotencyKey})`);
            return;
        }

        // Get real client IP (handles reverse proxy correctly)
        const ip = getClientIP(req);

        // Temporary debug logging - remove after verification
        console.log('[IP DEBUG]', {
            forwarded: req.headers['x-forwarded-for'],
            real: req.headers['x-real-ip'],
            expressIP: req.ip,
            socket: req.socket?.remoteAddress,
            chosen: ip
        });

        const userAgent = req.headers['user-agent'];

        // Get geolocation with enhanced data
        const { country, city, region, postal, timezone } = await getGeolocation(ip);

        // Parse device information
        const { browser, os, device } = parseUserAgent(userAgent);

        // Log to database
        const { error: insertError } = await supabase.from('access_logs').insert({
            room_id: roomId,
            event_type: eventType,
            ip_address: ip,
            user_agent: userAgent,
            country,
            city,
            region,
            postal,
            timezone,
            browser,
            os,
            device_type: device,
            session_id: sessionId,
            device_id: deviceId // Track device for activity feed
        });

        if (insertError) {
            console.error('[AccessLogger] INSERT FAILED:', insertError);
            return; // Don't log success if insert failed
        }

        console.log(`[Access Log] ${eventType} - Room: ${roomId.substring(0, 8)}..., IP: ${ip}, Device: ${deviceId?.substring(0, 8) || 'N/A'}`);
    } catch (error) {
        console.error('Failed to log access:', error);
        // Don't throw - logging failure shouldn't break the main flow
    }
}

