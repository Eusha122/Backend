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
    // 🎨 DESIGN SYSTEM TOKENS
    // Primary Gradient: Linear gradient matching the website's primary theme
    // HSL(173, 58%, 39%) -> #2A9D8F
    // HSL(173, 65%, 50%) -> #2EC4B6
    const primaryGradient = 'linear-gradient(135deg, #2A9D8F, #2EC4B6)';
    const primaryColor = '#2A9D8F';
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
<td align="center" style="padding:40px 32px;background:${primaryGradient};background-image:${primaryGradient};">
    <table cellpadding="0" cellspacing="0" role="presentation">
        <tr>
            <td align="center">
                <img src="${logoUrl}" alt="SafeShare Logo" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15);">
                <h1 style="margin:16px 0 0 0;font-size:24px;color:#ffffff;font-weight:700;letter-spacing:-0.5px;">SafeShare</h1>
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

<p style="color:#4b5563;font-size:16px;line-height:1.6;text-align:center;margin-bottom:32px;">
    <strong>${authorName || "Someone"}</strong> has shared a secure room with you using SafeShare's end-to-end encrypted platform.
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
                background:${primaryColor}; /* Fallback */
                background-image:${primaryGradient};
                color:white;
                text-decoration:none;
                border-radius:12px;
                font-weight:600;
                font-size:16px;
                box-shadow:0 4px 12px rgba(42, 157, 143, 0.3);
                transition: transform 0.2s;
                text-align:center;
                mso-padding-alt:0;
                text-underline-color:#ffffff;
                ">
                <!--[if mso]><i style="letter-spacing: 32px;mso-font-width:-100%;mso-text-raise:30pt">&nbsp;</i><![endif]-->
                <span style="mso-text-raise:15pt;">Open Secure Room</span>
                <!--[if mso]><i style="letter-spacing: 32px;mso-font-width:-100%">&nbsp;</i><![endif]-->
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
<td style="padding:24px 32px;border-top:1px solid #f3f4f6;background-color:#f9fafb;">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
        <tr>
            <td align="center" style="font-size:12px;color:#9ca3af;line-height:1.5;">
                <p style="margin:0;margin-bottom:8px;">
                     🔒 Secured by End-to-End Encryption
                </p>
                <p style="margin:0;">
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
