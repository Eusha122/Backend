import express from 'express';
import crypto from 'crypto';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/i;
const MAX_ROOM_NAME_LENGTH = 120;
const MAX_AUTHOR_NAME_LENGTH = 80;
const MAX_EXPIRY_HOURS = 24 * 30; // 30 days

function timingSafeEqualString(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const aBuf = Buffer.from(a, 'utf8');
    const bBuf = Buffer.from(b, 'utf8');
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
}

// POST /api/rooms - Create a room (returns author_token only to creator)
// Expects: { name, passwordHash, authorName, expiresAt, customExpiryHours, burnMode, maxUsers, isPermanent? }
router.post('/', async (req, res) => {
    try {
        const {
            name,
            passwordHash,
            authorName,
            expiresAt,
            customExpiryHours,
            burnMode,
            maxUsers,
            isPermanent
        } = req.body || {};

        if (!name || !passwordHash || !authorName || !expiresAt) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const roomName = String(name).trim().slice(0, MAX_ROOM_NAME_LENGTH);
        const author = String(authorName).trim().slice(0, MAX_AUTHOR_NAME_LENGTH);
        const pwHash = String(passwordHash).trim();
        const expiryDate = new Date(expiresAt);
        const maxUsersNum = Number(maxUsers ?? 5);
        const customExpiryNum = Number(customExpiryHours ?? 24);
        const permanent = Boolean(isPermanent);
        const burnEnabled = Boolean(burnMode);

        if (!roomName || !author) {
            return res.status(400).json({ error: 'Invalid input' });
        }
        if (!SHA256_HEX_REGEX.test(pwHash)) {
            return res.status(400).json({ error: 'Invalid password hash format' });
        }
        if (!Number.isFinite(expiryDate.getTime())) {
            return res.status(400).json({ error: 'Invalid expiresAt value' });
        }
        if (!permanent && expiryDate.getTime() <= Date.now()) {
            return res.status(400).json({ error: 'Expiration must be in the future' });
        }
        if (!Number.isInteger(maxUsersNum) || maxUsersNum < 1 || maxUsersNum > 999) {
            return res.status(400).json({ error: 'Invalid maxUsers value' });
        }
        if (!Number.isInteger(customExpiryNum) || customExpiryNum < 1 || customExpiryNum > MAX_EXPIRY_HOURS) {
            return res.status(400).json({ error: 'Invalid customExpiryHours value' });
        }

        const expIso = expiryDate.toISOString();
        const mode = burnEnabled ? 'burn' : 'normal';

        const authorToken = crypto.randomUUID();

        const { data: room, error: roomError } = await supabase
            .from('rooms')
            .insert({
                name: roomName,
                author_name: author,
                one_time_download: burnEnabled, // legacy compatibility
                mode,
                status: 'active',
                remaining_files: 0,
                expires_at: expIso,
                custom_expiry_hours: customExpiryNum,
                max_concurrent_users: maxUsersNum,
                is_permanent: permanent
            })
            .select('id')
            .single();

        if (roomError || !room) {
            console.error('[Rooms] Failed to create room:', roomError);
            return res.status(500).json({ error: 'Failed to create room' });
        }

        const { error: secretError } = await supabase
            .from('room_secrets')
            .insert({
                room_id: room.id,
                password_hash: pwHash,
                author_token: authorToken
            });

        if (secretError) {
            console.error('[Rooms] Failed to create room secret:', secretError);
            await supabase.from('rooms').delete().eq('id', room.id);
            return res.status(500).json({ error: 'Failed to create room' });
        }

        return res.json({
            id: room.id,
            author_token: authorToken
        });
    } catch (error) {
        console.error('[Rooms] Error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/rooms/verify-password - Verify room password hash (no secrets returned)
// Expects: { roomId, passwordHash }
router.post('/verify-password', async (req, res) => {
    try {
        const { roomId, passwordHash } = req.body || {};
        if (!roomId || !passwordHash) {
            return res.status(400).json({ valid: false, error: 'Missing roomId or passwordHash' });
        }
        if (!UUID_REGEX.test(String(roomId))) {
            return res.status(400).json({ valid: false, error: 'Invalid roomId' });
        }
        if (!SHA256_HEX_REGEX.test(String(passwordHash).trim())) {
            return res.status(400).json({ valid: false, error: 'Invalid passwordHash format' });
        }

        const { data: secret, error } = await supabase
            .from('room_secrets')
            .select('password_hash')
            .eq('room_id', roomId)
            .single();

        if (error || !secret) {
            return res.json({ valid: false, error: 'Room not found' });
        }

        const isValid = timingSafeEqualString(String(passwordHash), String(secret.password_hash));
        return res.json({ valid: isValid });
    } catch (error) {
        console.error('[Rooms] verify-password error:', error);
        return res.status(500).json({ valid: false, error: 'Internal server error' });
    }
});

export default router;
