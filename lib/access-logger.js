import { supabase } from './supabase.js';
import { getGeolocation } from './geolocation.js';

export async function logAccess(roomId, eventType, req) {
    try {
        // Get IP address (handle proxies)
        const ip = req.headers['x-forwarded-for']?.split(',')[0] ||
            req.headers['x-real-ip'] ||
            req.connection.remoteAddress ||
            req.socket.remoteAddress;

        const userAgent = req.headers['user-agent'];

        // Get geolocation with enhanced data
        const { country, city, region, postal, timezone } = await getGeolocation(ip);

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
            timezone
        });

        console.log(`[Access Log] ${eventType} - Room: ${roomId.substring(0, 8)}..., IP: ${ip}, Location: ${city}, ${country}`);
    } catch (error) {
        console.error('Failed to log access:', error);
        // Don't throw - logging failure shouldn't break the main flow
    }
}
