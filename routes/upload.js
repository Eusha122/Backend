import express from 'express';
import multer from 'multer';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, R2_BUCKET } from '../lib/r2-client.js';
import { supabase } from '../lib/supabase.js';
import crypto from 'crypto';
import { logAccess } from '../lib/access-logger.js';

const router = express.Router();

// ============================================
// Risk Assessment (Informational Only - NO BLOCKING)
// ============================================

const HIGH_RISK_EXTENSIONS = [
    '.exe', '.bat', '.cmd', '.com', '.pif', '.scr', '.vbs', '.js', '.jar',
    '.msi', '.app', '.deb', '.rpm', '.sh', '.run'
];

function assessFileRisk(filename, mimetype) {
    const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));

    // Check for high-risk extensions (but DON'T block)
    if (HIGH_RISK_EXTENSIONS.includes(ext)) {
        return {
            status: 'risky',
            reason: `Executable file (${ext}) - proceed with caution`,
            extension: ext
        };
    }

    // Check for double extensions (e.g., .pdf.exe)
    const parts = filename.toLowerCase().split('.');
    if (parts.length > 2) {
        const secondToLast = '.' + parts[parts.length - 2];
        if (HIGH_RISK_EXTENSIONS.includes(secondToLast)) {
            return {
                status: 'risky',
                reason: 'Double extension detected - potential masquerading',
                extension: secondToLast
            };
        }
    }

    return { status: 'safe', reason: 'Standard file type' };
}

// ============================================
// Async Risk Scanner (Heuristic Checks)
// ============================================

async function scanFileAsync(fileId, filename, buffer) {
    // Runs AFTER upload - updates risk assessment
    setTimeout(async () => {
        try {
            console.log(`[Risk Scan] Analyzing file: ${filename}`);

            // ============================================
            // OPTIMIZATION: Auto-safe for large files (>50MB)
            // Large files are unlikely to be executable malware and scanning
            // them is resource-intensive, so skip scanning for files > 50MB
            // ============================================
            const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024; // 50MB

            if (buffer.length > LARGE_FILE_THRESHOLD) {
                console.log(`[Risk Scan] ⏩ Large file (${(buffer.length / (1024 * 1024)).toFixed(1)}MB) - auto-marked as safe`);
                await supabase
                    .from('files')
                    .update({
                        scan_status: 'safe',
                        scan_result: 'Large file - automatically marked as safe',
                        scanned_at: new Date().toISOString()
                    })
                    .eq('id', fileId);
                return;
            }

            // Start with file type assessment (for files < 50MB)
            const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
            const fileTypeRisk = assessFileRisk(filename, '');

            // Additional heuristic checks for text-based files
            const suspiciousPatterns = [
                { pattern: /eval\(/gi, risk: 'Contains eval() - potentially dangerous code' },
                { pattern: /exec\(/gi, risk: 'Contains exec() - potentially dangerous' },
                { pattern: /<script/gi, risk: 'Contains script tags - possible XSS' },
                { pattern: /powershell/gi, risk: 'References PowerShell - could be malicious' }
            ];

            let scanStatus = fileTypeRisk.status;
            let scanResult = fileTypeRisk.reason;

            // Only scan text content for smaller files
            if (buffer.length < 1024 * 1024) { // 1MB limit for content scan
                const fileContent = buffer.toString('utf-8', 0, Math.min(buffer.length, 10000));

                for (const { pattern, risk } of suspiciousPatterns) {
                    if (pattern.test(fileContent)) {
                        scanStatus = 'risky';
                        scanResult = risk;
                        break;
                    }
                }
            }

            // Update scan status in database (INFORMATIONAL ONLY)
            await supabase
                .from('files')
                .update({
                    scan_status: scanStatus,
                    scan_result: scanResult,
                    scanned_at: new Date().toISOString()
                })
                .eq('id', fileId);

            if (scanStatus === 'risky') {
                console.warn(`[Risk Scan] ⚠️ RISKY FILE: ${scanResult}`);
            } else {
                console.log(`[Risk Scan] ✓ Standard file: ${filename}`);
            }

        } catch (error) {
            console.error('[Risk Scan] Error during scan:', error);
            await supabase
                .from('files')
                .update({
                    scan_status: 'unknown',
                    scan_result: 'Scan failed: ' + error.message,
                    scanned_at: new Date().toISOString()
                })
                .eq('id', fileId);
        }
    }, 1000);
}

// Configure multer for file uploads (memory storage)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 4 * 1024 * 1024 * 1024, // 4GB limit
    },
});

// POST /api/upload - Upload file to R2
router.post('/', upload.single('file'), async (req, res) => {
    try {
        const { roomId } = req.body;
        const file = req.file;

        // Validate input
        if (!roomId || !file) {
            return res.status(400).json({ error: 'Missing roomId or file' });
        }

        // ============================================
        // Initial Risk Assessment (NO BLOCKING - informational only)
        // ============================================
        const riskAssessment = assessFileRisk(file.originalname, file.mimetype);
        const initialScanStatus = riskAssessment.status;

        if (initialScanStatus === 'risky') {
            console.warn(`[Upload] ⚠️ Risky file uploaded: ${file.originalname} (${riskAssessment.reason})`);
        } else {
            console.log(`[Upload] Standard file upload: ${file.originalname}`);
        }

        // Check if room exists and is not expired
        const { data: room, error: roomError } = await supabase
            .from('rooms')
            .select('id, expires_at')
            .eq('id', roomId)
            .gt('expires_at', new Date().toISOString())
            .single();

        if (roomError || !room) {
            return res.status(404).json({ error: 'Room not found or expired' });
        }

        // Generate unique file key
        const fileId = crypto.randomUUID();
        const fileKey = `${roomId}/${fileId}_${file.originalname}`;

        // Upload to R2 (ALL FILES ALLOWED)
        await r2Client.send(
            new PutObjectCommand({
                Bucket: R2_BUCKET,
                Key: fileKey,
                Body: file.buffer,
                ContentType: file.mimetype,
                ContentLength: file.size,
            })
        );

        // Save metadata to Supabase with initial risk assessment
        const { message } = req.body;
        const fileMetadata = {
            room_id: roomId,
            filename: file.originalname,
            file_key: fileKey,
            size: file.size,
            scan_status: initialScanStatus, // 'safe', 'risky', or 'unknown'
            scan_result: riskAssessment.reason,
        };

        // Add message if provided
        if (message) {
            fileMetadata.message = message.trim();
        }

        console.log('[Upload] Inserting file metadata:', fileMetadata);
        const { data: fileData, error: dbError } = await supabase
            .from('files')
            .insert(fileMetadata)
            .select()
            .single();

        if (dbError) {
            console.error('Database error:', dbError);
            return res.status(500).json({ error: 'Failed to save file metadata' });
        }

        // Trigger async risk analysis (non-blocking)
        scanFileAsync(fileData.id, file.originalname, file.buffer);

        // Log file upload
        await logAccess(roomId, 'file_upload', req);

        res.json({
            success: true,
            fileKey,
            file: fileData,
            riskLevel: initialScanStatus, // Inform user of risk level
        });
    } catch (error) {
        console.error('[Upload Error] Full error details:', error);
        console.error('[Upload Error] Stack trace:', error.stack);
        console.error('[Upload Error] File info:', {
            filename: req.file?.originalname,
            size: req.file?.size,
            mimetype: req.file?.mimetype
        });

        if (error.message?.includes('File too large')) {
            return res.status(413).json({ error: 'File too large. Maximum size is 4GB.' });
        }

        if (error.message?.includes('LIMIT_FILE_SIZE')) {
            return res.status(413).json({ error: 'File exceeds maximum size limit' });
        }

        res.status(500).json({ error: 'Upload failed: ' + error.message });
    }
});

export default router;
