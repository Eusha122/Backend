import { supabase } from './supabase.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidRoomId(roomId) {
    return UUID_REGEX.test(String(roomId || ''));
}

export async function isAuthorToken(roomId, authorToken) {
    if (!roomId || !authorToken) return false;
    if (!isValidRoomId(roomId)) return false;
    const { data: secret, error } = await supabase
        .from('room_secrets')
        .select('author_token')
        .eq('room_id', roomId)
        .maybeSingle();
    if (error || !secret) return false;
    return secret.author_token === authorToken;
}

export async function hasGuestPresence(roomId, deviceId) {
    if (!roomId || !deviceId) return false;
    if (!isValidRoomId(roomId)) return false;
    const { data, error } = await supabase
        .from('room_presence')
        .select('device_id')
        .eq('room_id', roomId)
        .eq('device_id', deviceId)
        .limit(1)
        .maybeSingle();
    if (error) return false;
    return !!data;
}

export async function authorizeRoomAccess(roomId, authorToken, deviceId) {
    if (await isAuthorToken(roomId, authorToken)) {
        return { authorized: true, isAuthor: true };
    }
    if (await hasGuestPresence(roomId, deviceId)) {
        return { authorized: true, isAuthor: false };
    }
    return { authorized: false, isAuthor: false };
}

