import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import rateLimit from 'express-rate-limit';
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
import analyticsRoute from './routes/analytics.js'; // [NEW]
import { cleanupExpiredRooms } from './scripts/cleanup.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
// Middleware
const getAllowedOrigins = () => {
    // Always allow the specific Vercel frontend in production as a fallback
    const allowed = [
        'https://frontend-gamma-eight-86.vercel.app',
        'https://sharesafe.vercel.app'
    ];

    if (process.env.NODE_ENV === 'production' && process.env.FRONTEND_URL) {
        // Also allow the configured FRONTEND_URL (stripped of trailing slash)
        allowed.push(process.env.FRONTEND_URL.replace(/\/$/, ''));
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
    origin: getAllowedOrigins(),
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
    max: 1000, // Temporarily increased for testing (was 20)
    message: { error: 'Too many uploads, please try again later.' },
});

const downloadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100, // 100 downloads per 15 minutes
    message: { error: 'Too many downloads, please try again later.' },
});

// REMOVED: Global rate limiter was blocking all routes including read-only ones
// app.use('/api/', limiter); // <-- This was causing BUG 1

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes - ONLY apply rate limiting to upload/download routes
app.use('/api/upload', uploadLimiter, uploadRoute);
app.use('/api/presigned-upload', uploadLimiter, presignedUploadRoute); // Direct-to-R2 uploads
app.use('/api/multipart-upload', uploadLimiter, multipartUploadRoute); // Multipart uploads for large files
app.use('/api/download', downloadLimiter, downloadRoute);
app.use('/api/preview', downloadLimiter, previewRoutes);
app.use('/api/bulk-download', downloadLimiter, bulkDownloadRoute);

// Read-only routes - NO rate limiting (these were being blocked by global limiter)
app.use('/api/access-logs', accessLogsRoute);
app.use('/api/room-access', roomAccessRoute);
app.use('/api/room-capacity', roomCapacityRoute);
app.use('/api/delete-file', deleteFileRoute);
app.use('/api/delete-room', deleteRoomRoute);
app.use('/api/analytics', analyticsRoute); // [NEW] Analytics Route

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
    console.log(`🚀 ShareSafe Backend running on http://localhost:${PORT}`);
    console.log(`📅 Cleanup job scheduled (runs every hour)`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
