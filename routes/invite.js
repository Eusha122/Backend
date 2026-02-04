import express from 'express';
import { Resend } from 'resend';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

// Initialize Resend client
const resend = new Resend(process.env.RESEND_API_KEY);

// ============================================================
// Rate Limiting Storage (in-memory for simplicity)
// In production, consider using Redis for distributed systems
// ============================================================

// Track emails per IP: Map<ip, { count: number, resetTime: number }>
const ipRateLimit = new Map();

// Track invites per room: Map<roomId, number>
const roomInviteCount = new Map();

// Rate limit constants
const IP_LIMIT = 3;              // Max 3 emails per IP
const IP_WINDOW_MS = 10 * 60 * 1000;  // 10 minutes
const ROOM_LIMIT = 5;            // Max 5 invites per room

// Cleanup old entries every 15 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of ipRateLimit.entries()) {
        if (now > data.resetTime) {
            ipRateLimit.delete(ip);
        }
    }
}, 15 * 60 * 1000);

// ============================================================
// Email validation helper
// ============================================================
const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

// ============================================================
// HTML Email Template
// ============================================================
const generateEmailHTML = (roomName, roomUrl, authorName) => {
    return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>SafeShare Invitation</title>
</head>

<body style="margin:0;padding:0;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif">

<table width="100%" cellpadding="0" cellspacing="0">
<tr>
<td align="center" style="padding:40px 16px">

<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,0.05)">

<!-- Header -->
<tr>
<td style="padding:24px 32px;border-bottom:1px solid #eeeeee">
<h2 style="margin:0;color:#22c55e;font-weight:700">SafeShare</h2>
</td>
</tr>

<!-- Content -->
<tr>
<td style="padding:32px">

<h1 style="margin-top:0;font-size:22px;color:#111">
You've been invited to a secure room
</h1>

<p style="color:#444;font-size:15px;line-height:1.6">
<strong>${authorName || "Someone"}</strong> shared a room with you:
</p>

<div style="background:#f3f4f6;padding:14px 18px;border-radius:8px;margin:16px 0;font-weight:600;color:#111">
${roomName}
</div>

<a href="${roomUrl}"
style="
display:inline-block;
margin-top:20px;
padding:14px 24px;
background:#22c55e;
color:white;
text-decoration:none;
border-radius:8px;
font-weight:600;
font-size:15px;
">
Open Room
</a>

<p style="margin-top:24px;font-size:13px;color:#666">
If the button doesn’t work, copy this link:
<br>
<a href="${roomUrl}" style="color:#22c55e">${roomUrl}</a>
</p>

</td>
</tr>

<!-- Footer -->
<tr>
<td style="padding:20px 32px;border-top:1px solid #eeeeee;font-size:12px;color:#888">

<p style="margin:0">
⚠ Do not share this link publicly. Only send it to people you trust.
</p>

<p style="margin-top:10px">
SafeShare — Secure file sharing platform
</p>

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
        const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
            req.socket?.remoteAddress ||
            'unknown';

        // ========== Input Validation ==========
        if (!email || !roomId) {
            return res.status(400).json({
                error: 'Missing required fields'
            });
        }

        if (!isValidEmail(email)) {
            return res.status(400).json({
                error: 'Invalid email format'
            });
        }

        // Sanitize email (basic XSS prevention)
        const sanitizedEmail = email.trim().toLowerCase();

        // ========== Rate Limiting: IP Check ==========
        const now = Date.now();
        const ipData = ipRateLimit.get(clientIP);

        if (ipData) {
            if (now < ipData.resetTime) {
                if (ipData.count >= IP_LIMIT) {
                    return res.status(429).json({
                        error: 'Too many requests',
                        details: 'Please wait before sending more invites',
                        retryAfter: Math.ceil((ipData.resetTime - now) / 1000)
                    });
                }
            } else {
                // Window expired, reset
                ipRateLimit.set(clientIP, { count: 0, resetTime: now + IP_WINDOW_MS });
            }
        } else {
            ipRateLimit.set(clientIP, { count: 0, resetTime: now + IP_WINDOW_MS });
        }

        // ========== Rate Limiting: Room Check ==========
        const roomCount = roomInviteCount.get(roomId) || 0;
        if (roomCount >= ROOM_LIMIT) {
            return res.status(429).json({
                error: 'Room invite limit reached',
                details: `Maximum ${ROOM_LIMIT} invites allowed per room`
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
        const baseUrl = process.env.FRONTEND_URL || 'https://safeshare.co';
        let roomUrl = `${baseUrl}/room/${roomId}`;

        if (shareLink && shareLink.includes(roomId) && shareLink.startsWith('http')) {
            // Basic validation to ensure the link belongs to this room
            roomUrl = shareLink;
        }

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

        // ========== Update Rate Limits on Success ==========
        const currentIPData = ipRateLimit.get(clientIP);
        if (currentIPData) {
            currentIPData.count += 1;
        }
        roomInviteCount.set(roomId, roomCount + 1);

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
