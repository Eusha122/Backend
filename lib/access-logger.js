import { supabase } from './supabase.js';
import { getGeolocation } from './geolocation.js';
import { parseUserAgent } from './user-agent-parser.js';

export async function logAccess(roomId, eventType, req, sessionId = null, deviceId = null) {
    try {
        // Get IP address (handle proxies)
        const ip = req.headers['x-forwarded-for']?.split(',')[0] ||
            req.headers['x-real-ip'] ||
            req.connection.remoteAddress ||
            req.socket.remoteAddress;

        const userAgent = req.headers['user-agent'];

        // Get geolocation with enhanced data
        const { country, city, region, postal, timezone } = await getGeolocation(ip);

        // Parse device information
        const { browser, os, device } = parseUserAgent(userAgent);

        // Log to database
        await supabase.from('access_logs').insert({
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

        console.log(`[Access Log] ${eventType} - Room: ${roomId.substring(0, 8)}..., IP: ${ip}, Session: ${sessionId ? sessionId.substring(0, 8) : 'N/A'}`);
    } catch (error) {
        console.error('Failed to log access:', error);
        // Don't throw - logging failure shouldn't break the main flow
    }
}
