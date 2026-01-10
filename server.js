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
import { cleanupExpiredRooms } from './scripts/cleanup.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? process.env.FRONTEND_URL
        : ['http://localhost:8080', 'http://localhost:8081', 'http://192.168.0.106:8080', 'http://192.168.0.106:8081'],
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
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20, // Limit uploads to 20 per 15 minutes
    message: 'Too many uploads, please try again later.',
});

const downloadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50, // Limit downloads to 50 per 15 minutes
    message: 'Too many downloads, please try again later.',
});

app.use('/api/', limiter);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/upload', uploadLimiter, uploadRoute);
app.use('/api/presigned-upload', presignedUploadRoute); // Direct-to-R2 uploads
app.use('/api/multipart-upload', uploadLimiter, multipartUploadRoute); // Multipart uploads for large files
app.use('/api/download', downloadLimiter, downloadRoute);
app.use('/api/preview', downloadLimiter, previewRoutes);
app.use('/api/bulk-download', downloadLimiter, bulkDownloadRoute);
app.use('/api/access-logs', accessLogsRoute);
app.use('/api/room-access', roomAccessRoute);
app.use('/api/delete-file', deleteFileRoute);
app.use('/api/delete-room', deleteRoomRoute);

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
