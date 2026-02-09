import express from 'express';
import { Resend } from 'resend';
import { supabase } from '../lib/supabase.js';
import { config } from '../lib/config.js';

const router = express.Router();

// Initialize Resend client
const resend = new Resend(config.resendApiKey);

// ============================================================
// Rate Limiting Storage (in-memory for simplicity)
// In production, consider using Redis for distributed systems
// ============================================================

// Track emails per IP: Map<ip, { count: number, resetTime: number, lastAttempt: number }>
const ipRateLimit = new Map();

// Track invites per room: Map<roomId, { count: number, resetTime: number }>
const roomInviteCount = new Map();

// Track invites per recipient email: Map<email, { count: number, resetTime: number }>
const recipientRateLimit = new Map();

// Track invites per IP+room pair: Map<`${ip}:${roomId}`, { count: number, resetTime: number }>
const ipRoomRateLimit = new Map();

// Rate limit constants
const IP_LIMIT = Number(process.env.INVITE_IP_LIMIT || 3);
const IP_WINDOW_MS = Number(process.env.INVITE_IP_WINDOW_MS || (10 * 60 * 1000));
const ROOM_LIMIT = Number(process.env.INVITE_ROOM_LIMIT || 5);
const ROOM_WINDOW_MS = Number(process.env.INVITE_ROOM_WINDOW_MS || (60 * 60 * 1000));
const RECIPIENT_LIMIT = Number(process.env.INVITE_RECIPIENT_LIMIT || 3);
const RECIPIENT_WINDOW_MS = Number(process.env.INVITE_RECIPIENT_WINDOW_MS || (60 * 60 * 1000));
const IP_ROOM_LIMIT = Number(process.env.INVITE_IP_ROOM_LIMIT || 3);
const IP_ROOM_WINDOW_MS = Number(process.env.INVITE_IP_ROOM_WINDOW_MS || (30 * 60 * 1000));
const MIN_INTERVAL_MS = Number(process.env.INVITE_MIN_INTERVAL_MS || 8000);

const getWindowCounter = (map, key, windowMs, withLastAttempt = false) => {
    const now = Date.now();
    const existing = map.get(key);
    if (existing && now <= existing.resetTime) {
        return existing;
    }
    const replacement = withLastAttempt
        ? { count: 0, resetTime: now + windowMs, lastAttempt: 0 }
        : { count: 0, resetTime: now + windowMs };
    map.set(key, replacement);
    return replacement;
};

// Cleanup old entries every 15 minutes
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of ipRateLimit.entries()) {
        if (now > data.resetTime) ipRateLimit.delete(ip);
    }
    for (const [roomId, data] of roomInviteCount.entries()) {
        if (now > data.resetTime) roomInviteCount.delete(roomId);
    }
    for (const [email, data] of recipientRateLimit.entries()) {
        if (now > data.resetTime) recipientRateLimit.delete(email);
    }
    for (const [key, data] of ipRoomRateLimit.entries()) {
        if (now > data.resetTime) ipRoomRateLimit.delete(key);
    }
}, 15 * 60 * 1000);
cleanupTimer.unref?.();

// ============================================================
// Email validation helper
// ============================================================
const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHARE_LINK_MAX_LENGTH = 2048;
const KEY_FRAGMENT_REGEX = /^[A-Za-z0-9_-]{32,128}$/;

const getFrontendBaseUrl = () => {
    try {
        return new URL((config.frontendUrl || 'https://safeshare.co').replace(/\/$/, ''));
    } catch {
        return new URL('https://safeshare.co');
    }
};

const buildCanonicalRoomUrl = (origin, roomId, key = null) => {
    const safeOrigin = String(origin || '').replace(/\/$/, '');
    const basePath = `${safeOrigin}/room/${roomId}`;
    return key ? `${basePath}#key=${key}` : basePath;
};

const getAllowedInviteOrigins = () => {
    const origins = new Set();
    const frontendBaseUrl = getFrontendBaseUrl();
    origins.add(frontendBaseUrl.origin);

    if (config.nodeEnv !== 'production') {
        origins.add('http://localhost:8080');
        origins.add('http://localhost:8081');
        origins.add('http://localhost:8082');
        origins.add('http://127.0.0.1:8080');
        origins.add('http://127.0.0.1:8081');
        origins.add('http://127.0.0.1:8082');
    }

    return origins;
};

const sanitizeShareLink = (shareLink, roomId, allowedOrigins) => {
    if (typeof shareLink !== 'string') return null;
    const trimmed = shareLink.trim();
    if (!trimmed || trimmed.length > SHARE_LINK_MAX_LENGTH) return null;

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        return null;
    }

    if (!allowedOrigins.has(parsed.origin)) return null;
    if (parsed.pathname !== `/room/${roomId}`) return null;
    if (parsed.search) return null;

    if (!parsed.hash) {
        return buildCanonicalRoomUrl(parsed.origin, roomId);
    }

    const rawHash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
    const params = new URLSearchParams(rawHash);
    const key = params.get('key');

    // Enforce exactly one fragment param: key
    if (!key || params.size !== 1 || !KEY_FRAGMENT_REGEX.test(key)) {
        return null;
    }

    return buildCanonicalRoomUrl(parsed.origin, roomId, key);
};

// ============================================================
// HTML Email Template
// ============================================================
const generateEmailHTML = (roomName, roomUrl, authorName) => {
    // 🎨 DESIGN SYSTEM TOKENS
    // Primary Gradient: Linear gradient matching the website's primary theme
    // HSL(173, 58%, 39%) -> #2A9D8F
    // HSL(173, 65%, 50%) -> #2EC4B6
    const primaryGradient = 'linear-gradient(135deg, #041f2a, #053854)';
    const primaryColor = '#041f2a';
    const logoUrl = `${config.frontendUrl}/icon.png`;

    return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SafeShare Invitation</title>
</head>

<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" role="presentation">
<tr>
<td align="center" style="padding:40px 16px;">

<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,0.08);overflow:hidden;max-width:100%;">

<!-- Header with Gradient -->
<tr>
<td style="padding:40px 32px;background:${primaryGradient};background-image:${primaryGradient};">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
        <tr>
            <td align="left">
                <table cellpadding="0" cellspacing="0" role="presentation">
                    <tr>
                        <td>
                            <img src="${logoUrl}" alt="SafeShare Logo" width="32" height="32" style="display:block;width:32px;height:32px;">
                        </td>
                        <td style="padding-left:16px;">
                            <span style="font-size:24px;color:#ffffff;font-weight:700;letter-spacing:-0.5px;">
                                SafeShare
                            </span>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</td>
</tr>

<!-- Content -->
<tr>
<td style="padding:40px 32px;">

<h2 style="margin-top:0;margin-bottom:24px;font-size:20px;color:#111827;text-align:center;font-weight:600;">
    You've been invited to a secure room
</h2>

<p style="color:#111827;font-size:16px;line-height:1.6;text-align:center;margin-bottom:32px;">
    <strong>${authorName || "Someone"}</strong> shared a room with you.
</p>

<!-- Room Card -->
<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:24px;margin-bottom:32px;text-align:center;">
    <p style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;font-weight:600;margin-bottom:8px;">Room Name</p>
    <div style="font-size:18px;font-weight:600;color:#111827;">${roomName}</div>
</div>

<!-- CTA Button -->
<table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
        <td align="center">
            <a href="${roomUrl}"
                style="
                display:inline-block;
                padding:16px 32px;
                background:${primaryColor};
                color:white;
                text-decoration:none;
                border-radius:12px;
                font-weight:600;
                font-size:16px;
                box-shadow:0 4px 12px rgba(5, 56, 84, 0.3);
                transition: transform 0.2s;
                text-align:center;
                mso-padding-alt:0;
                text-underline-color:#ffffff;
                ">
                Open Room
            </a>
        </td>
    </tr>
</table>

<p style="margin-top:32px;font-size:13px;color:#6b7280;text-align:center;">
    If the button doesn't work, copy this link:
    <br>
    <a href="${roomUrl}" style="color:${primaryColor};word-break:break-all;">${roomUrl}</a>
</p>

</td>
</tr>

<!-- Footer -->
<tr>
<td style="padding:24px 32px;border-top:1px solid #e5e7eb;background-color:#f7f8fa;">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
        <tr>
            <td align="center" style="font-size:12px;color:#6c7280;line-height:1.5;">
                <p style="margin:0;margin-bottom:8px;color:#7b818f;">
                     🔒 Secured by End-to-End Encryption
                </p>
                <p style="margin:0;color:#7b818f;">
                    © ${new Date().getFullYear()} SafeShare — Secure file sharing platform
                </p>
            </td>
        </tr>
    </table>
</td>
</tr>

</table>

</td>
</tr>
</table>

</body>
</html>
    `;
};

// ============================================================
// POST /api/invite - Send room invitation email
// ============================================================
// ============================================================
// POST /api/invite - Send room invitation email
// ============================================================
router.post('/', async (req, res) => {
    try {
        // 🔒 SECURITY: Only accept email and roomId
        // URL is generated server-side to prevent phishing attacks
        // [UPDATE] Accepting shareLink from frontend to support URL fragments (encryption keys)
        const { email, roomId, shareLink } = req.body;
        const clientIP = (req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
            req.socket?.remoteAddress ||
            'unknown').slice(0, 128);

        // ========== Input Validation ==========
        if (!email || !roomId) {
            return res.status(400).json({
                error: 'Missing required fields'
            });
        }

        if (!UUID_REGEX.test(roomId)) {
            return res.status(400).json({
                error: 'Invalid roomId format'
            });
        }

        if (!isValidEmail(email)) {
            return res.status(400).json({
                error: 'Invalid email format'
            });
        }

        // Sanitize email (basic XSS prevention)
        const sanitizedEmail = email.trim().toLowerCase();
        if (sanitizedEmail.length > 254) {
            return res.status(400).json({
                error: 'Invalid email format'
            });
        }

        // ========== Rate Limiting: IP Check ==========
        const now = Date.now();
        const ipData = getWindowCounter(ipRateLimit, clientIP, IP_WINDOW_MS, true);
        if (ipData.lastAttempt && now - ipData.lastAttempt < MIN_INTERVAL_MS) {
            return res.status(429).json({
                error: 'Too many requests',
                details: 'Please wait before sending another invite',
                retryAfter: Math.ceil((MIN_INTERVAL_MS - (now - ipData.lastAttempt)) / 1000)
            });
        }
        if (ipData.count >= IP_LIMIT) {
            return res.status(429).json({
                error: 'Too many requests',
                details: 'Please wait before sending more invites',
                retryAfter: Math.ceil((ipData.resetTime - now) / 1000)
            });
        }

        // ========== Rate Limiting: Room Check ==========
        const roomData = getWindowCounter(roomInviteCount, roomId, ROOM_WINDOW_MS);
        if (roomData.count >= ROOM_LIMIT) {
            return res.status(429).json({
                error: 'Room invite limit reached',
                details: `Maximum ${ROOM_LIMIT} invites allowed per room in ${Math.round(ROOM_WINDOW_MS / 60000)} minutes`,
                retryAfter: Math.ceil((roomData.resetTime - now) / 1000)
            });
        }

        // ========== Rate Limiting: Recipient Check ==========
        const recipientData = getWindowCounter(recipientRateLimit, sanitizedEmail, RECIPIENT_WINDOW_MS);
        if (recipientData.count >= RECIPIENT_LIMIT) {
            return res.status(429).json({
                error: 'Recipient invite limit reached',
                details: 'This recipient has reached the invite limit. Please try later.',
                retryAfter: Math.ceil((recipientData.resetTime - now) / 1000)
            });
        }

        // ========== Rate Limiting: IP + Room Check ==========
        const ipRoomKey = `${clientIP}:${roomId}`;
        const ipRoomData = getWindowCounter(ipRoomRateLimit, ipRoomKey, IP_ROOM_WINDOW_MS);
        if (ipRoomData.count >= IP_ROOM_LIMIT) {
            return res.status(429).json({
                error: 'Too many room invite attempts',
                details: 'Too many invites from this network to this room.',
                retryAfter: Math.ceil((ipRoomData.resetTime - now) / 1000)
            });
        }

        // ========== Verify Room Exists ==========
        const { data: room, error: roomError } = await supabase
            .from('rooms')
            .select('id, name, author_name')
            .eq('id', roomId)
            .single();

        if (roomError || !room) {
            return res.status(404).json({
                error: 'Room not found'
            });
        }

        // ========== Generate Secure Room URL ==========
        // [UPDATE] Use the provided shareLink if valid to include the encryption key fragment
        // Fallback to server-generated URL if missing (though files won't work without key)
        const frontendBaseUrl = getFrontendBaseUrl();
        const allowedOrigins = getAllowedInviteOrigins();
        let roomUrl = buildCanonicalRoomUrl(frontendBaseUrl.origin, roomId);

        if (shareLink) {
            const validatedShareLink = sanitizeShareLink(shareLink, roomId, allowedOrigins);
            if (validatedShareLink) {
                roomUrl = validatedShareLink;
            } else {
                console.warn(`[Invite] Rejected invalid shareLink for room ${roomId} from IP ${clientIP}`);
                return res.status(400).json({
                    error: 'Invalid share link',
                    details: 'Please copy the room link again and retry.'
                });
            }
        }

        // ========== Consume rate-limit slots before external side effects ==========
        ipData.count += 1;
        ipData.lastAttempt = now;
        roomData.count += 1;
        recipientData.count += 1;
        ipRoomData.count += 1;

        // ========== Send Email via Resend ==========
        const mailFrom = process.env.MAIL_FROM || 'SafeShare <noreply@safeshare.co>';

        const { data: emailData, error: emailError } = await resend.emails.send({
            from: mailFrom,
            to: [sanitizedEmail],
            subject: 'Your SafeShare Room Link',
            html: generateEmailHTML(room.name, roomUrl, room.author_name),
        });

        if (emailError) {
            console.error('[Invite] Resend API error:', emailError);
            return res.status(500).json({
                error: 'Failed to send email',
                details: 'Please try again later'
            });
        }

        console.log(`[Invite] Email sent successfully to ${sanitizedEmail} for room ${roomId}`);

        res.json({
            success: true,
            message: 'Invitation sent successfully'
        });

    } catch (error) {
        console.error('[Invite] Server error:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: 'An unexpected error occurred'
        });
    }
});

export default router;
