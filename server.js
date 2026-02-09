import { config } from './lib/config.js';

import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import os from 'os';
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
import analyticsAdminRoute from './routes/analytics-admin.js';
import inviteRoute from './routes/invite.js';
import verifyAuthorRoute from './routes/verify-author.js';
import roomsRoute from './routes/rooms.js';
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

// Overload protection:
// During traffic spikes, shed non-critical heavy routes with 503 instead of
// letting the process run out of CPU/memory and crash.
const overloadGuardEnabled = process.env.OVERLOAD_GUARD_ENABLED !== 'false';
const overloadCheckIntervalMs = Number(process.env.OVERLOAD_CHECK_INTERVAL_MS || 3000);
const overloadMaxRssMb = Number(process.env.OVERLOAD_MAX_RSS_MB || 700);
const overloadMinFreeMemMb = Number(process.env.OVERLOAD_MIN_FREE_MEM_MB || 120);
const overloadMaxLoadPerCpu = Number(process.env.OVERLOAD_MAX_LOAD_PER_CPU || 1.4);
const overloadRetryAfterSeconds = Number(process.env.OVERLOAD_RETRY_AFTER_SECONDS || 15);
const overloadShedRoutes = (
    process.env.OVERLOAD_SHED_ROUTES ||
    '/api/upload,/api/presigned-upload,/api/multipart-upload,/api/invite,/api/analytics-admin,/api/rooms,/api/room-access/activity'
).split(',').map((value) => value.trim()).filter(Boolean);

let lastOverloadSampleAt = 0;
let lastOverloadSample = { overloaded: false, reasons: [] };
let lastOverloadLogAt = 0;

const sampleOverloadState = () => {
    const now = Date.now();
    if (now - lastOverloadSampleAt < overloadCheckIntervalMs) {
        return lastOverloadSample;
    }

    const rssMb = process.memoryUsage().rss / (1024 * 1024);
    const freeMemMb = os.freemem() / (1024 * 1024);
    const cpuCount = Math.max(1, os.cpus()?.length || 1);
    const loadPerCpu = os.loadavg()[0] / cpuCount;

    const reasons = [];
    if (rssMb >= overloadMaxRssMb) {
        reasons.push(`rss=${rssMb.toFixed(0)}MB`);
    }
    if (freeMemMb <= overloadMinFreeMemMb) {
        reasons.push(`free_mem=${freeMemMb.toFixed(0)}MB`);
    }
    if (loadPerCpu >= overloadMaxLoadPerCpu) {
        reasons.push(`load_per_cpu=${loadPerCpu.toFixed(2)}`);
    }

    lastOverloadSampleAt = now;
    lastOverloadSample = {
        overloaded: reasons.length > 0,
        reasons
    };
    return lastOverloadSample;
};

const shouldShedRoute = (path) => overloadShedRoutes.some((prefix) => path.startsWith(prefix));

if (overloadGuardEnabled) {
    app.use((req, res, next) => {
        if (!shouldShedRoute(req.path)) {
            return next();
        }

        const state = sampleOverloadState();
        if (!state.overloaded) {
            return next();
        }

        const now = Date.now();
        if (now - lastOverloadLogAt > 15000) {
            console.warn(`[OverloadGuard] Shedding ${req.path} (${state.reasons.join(', ')})`);
            lastOverloadLogAt = now;
        }

        res.setHeader('Retry-After', String(overloadRetryAfterSeconds));
        return res.status(503).json({
            error: 'Server is busy. Please retry shortly.'
        });
    });
}

// Body parser hardening:
// - Small default JSON limit for most routes
// - Larger JSON only for upload orchestration endpoints
const defaultJsonParser = express.json({ limit: '1mb' });
const uploadJsonParser = express.json({ limit: '10mb' });

app.use((req, res, next) => {
    if (req.path.startsWith('/api/presigned-upload') || req.path.startsWith('/api/multipart-upload')) {
        return uploadJsonParser(req, res, next);
    }
    return defaultJsonParser(req, res, next);
});
app.use(express.urlencoded({ limit: '100kb', extended: true }));

// Increase timeout for large uploads (30 minutes)
app.use((req, res, next) => {
    req.setTimeout(30 * 60 * 1000); // 30 minutes
    res.setTimeout(30 * 60 * 1000);
    next();
});

// Rate limiting
const limiter = rateLimit({
    windowMs: Number(process.env.GLOBAL_RATE_WINDOW_MS || (15 * 60 * 1000)),
    max: Number(process.env.GLOBAL_RATE_MAX || 300),
    message: { error: 'Too many requests from this IP, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const uploadWindowMs = Number(process.env.UPLOAD_RATE_WINDOW_MS || (15 * 60 * 1000));
const uploadMax = Number(process.env.UPLOAD_RATE_MAX || 30);
const uploadLimiter = rateLimit({
    windowMs: uploadWindowMs,
    max: uploadMax,
    message: { error: 'Too many uploads, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const downloadWindowMs = Number(process.env.DOWNLOAD_RATE_WINDOW_MS || (15 * 60 * 1000));
const downloadMax = Number(process.env.DOWNLOAD_RATE_MAX || 80);
const downloadLimiter = rateLimit({
    windowMs: downloadWindowMs,
    max: downloadMax,
    message: { error: 'Too many downloads, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// === SECURITY: Strict rate limits for abuse-prone routes ===
const roomAccessLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 4, // 4 requests per minute per IP
    message: { error: 'Too many access attempts, please wait.' },
});

// Separate limiter for presence heartbeats.
const presenceLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 12, // allows ~5s heartbeats with safety buffer
    message: { error: 'Too many presence updates, please wait.' },
});

const deleteLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 8, // 8 delete attempts per minute per IP
    message: { error: 'Too many delete attempts, please wait.' },
});

const presignedUploadLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 12, // 12 presigned URL requests per minute per IP
    message: { error: 'Too many upload requests, please wait.' },
});

const inviteLimiter = rateLimit({
    windowMs: Number(process.env.INVITE_EDGE_WINDOW_MS || (10 * 60 * 1000)),
    max: Number(process.env.INVITE_EDGE_MAX || 6),
    message: { error: 'Too many invite requests, please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const analyticsAdminLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Too many analytics requests, please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
});
// === END SECURITY ===

// Unauthenticated room endpoints (create + password verify)
const roomsLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 12,
    message: { error: 'Too many room requests, please wait.' },
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.use(limiter);

// API routes with rate limiting
app.use('/api/upload', uploadLimiter, uploadRoute);
app.use('/api/presigned-upload', presignedUploadLimiter, presignedUploadRoute); // Strict limit
app.use('/api/multipart-upload', uploadLimiter, multipartUploadRoute);
app.use('/api/download', downloadLimiter, downloadRoute);
app.use('/api/preview', downloadLimiter, previewRoutes);
app.use('/api/bulk-download', downloadLimiter, bulkDownloadRoute);

// Separate, more lenient limiter for activity feed (polled/refetched often)
const activityLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60, // 60 requests per minute (1 per second)
    message: { error: 'Too many activity refresh requests, please wait.' },
});

// Protected routes with strict rate limits
// Presence heartbeat + leave need higher limits (sent every 10s per client)
// Now using 30s heartbeat, so 20/min is plenty safe
app.use('/api/room-access', (req, res, next) => {
    if (req.path.startsWith('/presence') || req.path.startsWith('/leave')) {
        return presenceLimiter(req, res, next);
    }
    if (req.path.startsWith('/activity')) {
        return activityLimiter(req, res, next);
    }
    return roomAccessLimiter(req, res, next);
});
app.use('/api/room-access', roomAccessRoute);
app.use('/api/delete-file', deleteLimiter, deleteFileRoute); // Prevent abuse
app.use('/api/delete-room', deleteLimiter, deleteRoomRoute); // Prevent abuse

// Read-only routes
app.use('/api/access-logs', accessLogsRoute);
app.use('/api/room-capacity', roomCapacityRoute);
app.use('/api/analytics', analyticsRoute);
app.use('/api/analytics-admin', analyticsAdminLimiter, analyticsAdminRoute);
import updateFileRoute from './routes/update-file.js';
app.use('/api/update-file', updateFileRoute);
app.use('/api/rooms', roomsLimiter, roomsRoute);
app.use('/api/invite', inviteLimiter, inviteRoute);
app.use('/api/verify-author', verifyAuthorRoute);

// Schedule cleanup job (defaults to every hour)
const cleanupCron = process.env.CLEANUP_CRON || '0 * * * *';
cron.schedule(cleanupCron, () => {
    console.log('[Cron] Running scheduled cleanup job');
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
    console.log(`📅 Cleanup job scheduled (${cleanupCron})`);
    console.log(`🌍 Environment: ${config.nodeEnv}`);
});
