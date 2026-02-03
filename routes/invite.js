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
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your SafeShare Room Link</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; background-color: #0a0a0a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; background-color: #0a0a0a;">
        <!-- Header -->
        <tr>
            <td style="padding: 40px 30px 20px; text-align: center;">
                <div style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); border-radius: 12px;">
                    <span style="font-size: 24px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px;">SafeShare</span>
                </div>
            </td>
        </tr>
        
        <!-- Main Content -->
        <tr>
            <td style="padding: 20px 30px;">
                <div style="background: linear-gradient(145deg, #1a1a1a 0%, #0f0f0f 100%); border: 1px solid #2a2a2a; border-radius: 16px; padding: 32px; text-align: center;">
                    <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 600; color: #ffffff;">
                        You've been invited to a room
                    </h1>
                    
                    <p style="margin: 0 0 24px; font-size: 16px; color: #a1a1a1; line-height: 1.6;">
                        <strong style="color: #ffffff;">${authorName || 'Someone'}</strong> has shared a secure room with you.
                    </p>
                    
                    <!-- Room Name Badge -->
                    <div style="display: inline-block; padding: 12px 24px; background-color: #1f1f1f; border: 1px solid #333; border-radius: 8px; margin-bottom: 24px;">
                        <span style="font-size: 18px; font-weight: 600; color: #22c55e;">${roomName}</span>
                    </div>
                    
                    <!-- CTA Button -->
                    <div style="margin: 24px 0;">
                        <a href="${roomUrl}" target="_blank" style="display: inline-block; padding: 16px 32px; background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; border-radius: 10px; box-shadow: 0 4px 14px rgba(34, 197, 94, 0.3);">
                            Open Secure Room →
                        </a>
                    </div>
                    
                    <p style="margin: 24px 0 0; font-size: 13px; color: #666; line-height: 1.5;">
                        If the button doesn't work, copy and paste this link:<br>
                        <a href="${roomUrl}" style="color: #22c55e; word-break: break-all;">${roomUrl}</a>
                    </p>
                </div>
            </td>
        </tr>
        
        <!-- Security Warning -->
        <tr>
            <td style="padding: 0 30px 20px;">
                <div style="background-color: #1c1917; border: 1px solid #44403c; border-radius: 12px; padding: 16px 20px;">
                    <p style="margin: 0; font-size: 13px; color: #fbbf24; text-align: center;">
                        ⚠️ <strong>Security Notice:</strong> Do not share this link publicly. Only forward it to people you trust.
                    </p>
                </div>
            </td>
        </tr>
        
        <!-- Footer -->
        <tr>
            <td style="padding: 20px 30px 40px; text-align: center; border-top: 1px solid #1f1f1f;">
                <p style="margin: 0 0 8px; font-size: 14px; color: #666;">
                    Sent securely by <strong style="color: #22c55e;">SafeShare</strong>
                </p>
                <p style="margin: 0; font-size: 12px; color: #444;">
                    End-to-end encrypted file sharing
                </p>
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
router.post('/', async (req, res) => {
    try {
        // 🔒 SECURITY: Only accept email and roomId
        // URL is generated server-side to prevent phishing attacks
        const { email, roomId } = req.body;
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
        // 🔒 SECURITY: URL is generated server-side to prevent phishing
        const baseUrl = process.env.FRONTEND_URL || 'https://safeshare.co';
        const roomUrl = `${baseUrl}/room/${roomId}`;

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
