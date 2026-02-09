import { supabase } from './supabase.js';

export const ACTIVE_WINDOW_MS = Number(process.env.PRESENCE_WINDOW_MS || 120000);
export const ACTIVE_WINDOW_SECONDS = Math.max(30, Math.floor(ACTIVE_WINDOW_MS / 1000));

export const isAuthorForRoom = (roomAuthorToken, providedToken) => {
    if (!roomAuthorToken || !providedToken) return false;
    return roomAuthorToken === providedToken;
};

export const activeSinceIso = () => new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString();

export const countActiveGuests = async (roomId, excludeDeviceId = null) => {
    let query = supabase
        .from('room_presence')
        .select('device_id', { count: 'exact', head: true })
        .eq('room_id', roomId)
        .not('device_id', 'like', 'author:%');

    if (excludeDeviceId) {
        query = query.neq('device_id', excludeDeviceId);
    }

    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
};

export const upsertGuestPresence = async (roomId, deviceId) => {
    const { error } = await supabase
        .from('room_presence')
        .upsert({
            room_id: roomId,
            device_id: deviceId,
            last_seen_at: new Date().toISOString()
        }, { onConflict: 'room_id,device_id' });

    if (error) throw error;
};
