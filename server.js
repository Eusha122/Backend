import { config } from './lib/config.js';

import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import uploadRoute from './routes/upload.js';
import presignedUploadRoute from './routes/presigned-upload.js';
import multipartUploadRoute from './routes/multipart-upload.js';
import downloadRoute from './routes/download.js';
import previewRoutes from './routes/preview.js';
import bulkDownloadRoute from './routes/bulk-download.js';
import accessLogsRoute from './routes/access-logs.js';
import roomAccessRoute from './routes/room-access.js';
import deleteFileRoute from './routes/delete-file.js';
import deleteRoomRoute from './routes/delete-room.js';
import roomCapacityRoute from './routes/room-capacity.js';
import analyticsRoute from './routes/analytics.js';
import inviteRoute from './routes/invite.js';
import { cleanupExpiredRooms } from './scripts/cleanup.js';

const app = express();
const PORT = config.port;

// Trust proxy for correct IP detection behind Vercel/Nginx
// Important: This should be set BEFORE initializing rate limiters
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// Middleware
// Middleware
const getAllowedOrigins = () => {
    // Always allow the specific Vercel frontend in production as a fallback
    const allowed = [
        'https://frontend-gamma-eight-86.vercel.app',
        'https://sharesafe.vercel.app',
        'https://safeshare.co',
        'https://www.safeshare.co'
    ];

    if (config.nodeEnv === 'production' && config.frontendUrl) {
        // Also allow the configured FRONTEND_URL (stripped of trailing slash)
        allowed.push(config.frontendUrl.replace(/\/$/, ''));
    }

    // Add local dev environments
    allowed.push('http://localhost:8080');
    allowed.push('http://localhost:8081');
    allowed.push('http://localhost:8082');
    allowed.push('http://192.168.0.106:8080'); // Mobile testing
    allowed.push('http://192.168.0.106:8081');
    allowed.push('http://192.168.0.106:8082');

    return allowed;
};

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        const allowedOrigins = getAllowedOrigins();

        // Check if origin is explicitly allowed
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        // Check if origin is a Vercel preview deployment (any subdomain)
        // Regex matches https://<anything>.vercel.app
        const vercelPattern = /^https:\/\/.*\.vercel\.app$/;
        if (vercelPattern.test(origin)) {
            return callback(null, true);
        }

        const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
        return callback(new Error(msg), false);
    },
    credentials: true,
    exposedHeaders: ['ETag'], // Required for multipart uploads to read ETags
}));

// Increase body size limit for large file uploads (5GB)
app.use(express.json({ limit: '5gb' }));
app.use(express.urlencoded({ limit: '5gb', extended: true }));

// Increase timeout for large uploads (30 minutes)
app.use((req, res, next) => {
    req.setTimeout(30 * 60 * 1000); // 30 minutes
    res.setTimeout(30 * 60 * 1000);
    next();
});

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 500, // Limit each IP to 500 requests per windowMs (increased for room capacity polling)
    message: { error: 'Too many requests from this IP, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50, // 50 uploads per 15 minutes
    message: { error: 'Too many uploads, please try again later.' },
});

const downloadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100, // 100 downloads per 15 minutes
    message: { error: 'Too many downloads, please try again later.' },
});

// === SECURITY: Strict rate limits for abuse-prone routes ===
const roomAccessLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5, // 5 requests per minute per IP
    message: { error: 'Too many access attempts, please wait.' },
});

// Separate, more lenient limiter for presence heartbeats (sent every 10s)
const presenceLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 20, // 20 requests per minute per IP (allows 10s heartbeats)
    message: { error: 'Too many presence updates, please wait.' },
});

const deleteLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 delete attempts per minute per IP
    message: { error: 'Too many delete attempts, please wait.' },
});

const presignedUploadLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 20, // 20 presigned URL requests per minute per IP
    message: { error: 'Too many upload requests, please wait.' },
});
// === END SECURITY ===

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes with rate limiting
app.use('/api/upload', uploadLimiter, uploadRoute);
app.use('/api/presigned-upload', presignedUploadLimiter, presignedUploadRoute); // Strict limit
app.use('/api/multipart-upload', uploadLimiter, multipartUploadRoute);
app.use('/api/download', downloadLimiter, downloadRoute);
app.use('/api/preview', downloadLimiter, previewRoutes);
app.use('/api/bulk-download', downloadLimiter, bulkDownloadRoute);

// Protected routes with strict rate limits
// Presence heartbeat + leave need higher limits (sent every 10s per client)
app.use('/api/room-access/presence', presenceLimiter, roomAccessRoute);
app.use('/api/room-access/leave', presenceLimiter, roomAccessRoute);
// Other room-access endpoints use strict limiter
app.use('/api/room-access', roomAccessLimiter, roomAccessRoute);
app.use('/api/delete-file', deleteLimiter, deleteFileRoute); // Prevent abuse
app.use('/api/delete-room', deleteLimiter, deleteRoomRoute); // Prevent abuse

// Read-only routes
app.use('/api/access-logs', accessLogsRoute);
app.use('/api/room-capacity', roomCapacityRoute);
app.use('/api/analytics', analyticsRoute);
import updateFileRoute from './routes/update-file.js';
app.use('/api/update-file', updateFileRoute);
app.use('/api/invite', inviteRoute);

// Schedule cleanup job (every hour)
cron.schedule('0 * * * *', () => {
    console.log('[Cron] Running hourly cleanup job');
    cleanupExpiredRooms().catch((error) => {
        console.error('[Cron] Cleanup job failed:', error);
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 ShareSafe Backend running on port ${PORT}`);
    console.log(`📅 Cleanup job scheduled (runs every hour)`);
    console.log(`🌍 Environment: ${config.nodeEnv}`);
});
