import express from 'express';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client, R2_BUCKET } from '../lib/r2-client.js';
import { supabase } from '../lib/supabase.js';
import crypto from 'crypto';

const router = express.Router();

// High-risk file extensions (for risk assessment)
const HIGH_RISK_EXTENSIONS = [
    '.exe', '.bat', '.cmd', '.com', '.pif', '.scr', '.vbs', '.js', '.jar',
    '.msi', '.app', '.deb', '.rpm', '.sh', '.run'
];

function assessFileRisk(filename, mimetype) {
    const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));

    if (HIGH_RISK_EXTENSIONS.includes(ext)) {
        return {
            status: 'risky',
            reason: `Executable file (${ext}) - proceed with caution`,
            extension: ext
        };
    }

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

// NEW: Generate presigned URL for direct upload
router.post('/presigned-upload', async (req, res) => {
    try {
        const { roomId, filename, fileSize, contentType } = req.body;

        if (!roomId || !filename || !fileSize) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Validate room exists
        const { data: room, error: roomError } = await supabase
            .from('rooms')
            .select('id, expires_at')
            .eq('id', roomId)
            .single();

        if (roomError || !room) {
            return res.status(404).json({ error: 'Room not found' });
        }

        // Check if room is expired
        if (new Date(room.expires_at) < new Date()) {
            return res.status(410).json({ error: 'Room expired' });
        }

        // Generate unique file key
        const fileKey = `${roomId}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${filename}`;

        // Risk assessment
        const riskAssessment = assessFileRisk(filename, contentType);

        // Create file record in database
        console.log('[Presigned] Creating file record:', {
            room_id: roomId,
            filename: filename,
            file_key: fileKey,
            size: parseInt(fileSize),
            scan_status: riskAssessment.status,
            scan_result: riskAssessment.reason
        });

        const { data: fileRecord, error: dbError } = await supabase
            .from('files')
            .insert({
                room_id: roomId,
                filename: filename,
                file_key: fileKey,
                size: parseInt(fileSize),
                scan_status: riskAssessment.status,
                scan_result: riskAssessment.reason,
                scanned_at: new Date().toISOString()
            })
            .select()
            .single();

        if (dbError) {
            console.error('Database error:', dbError);
            return res.status(500).json({ error: 'Failed to create file record' });
        }

        // Generate presigned URL for upload (valid for 1 hour)
        const command = new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: fileKey,
            ContentType: contentType,
            ContentLength: parseInt(fileSize)
        });

        const presignedUrl = await getSignedUrl(r2Client, command, { expiresIn: 3600 });

        console.log(`[Presigned Upload] Generated URL for: ${filename} (${fileSize} bytes)`);

        res.json({
            uploadUrl: presignedUrl,
            fileId: fileRecord.id,
            fileKey: fileKey
        });

    } catch (error) {
        console.error('Error generating presigned URL:', error);
        res.status(500).json({ error: 'Failed to generate upload URL' });
    }
});

// Confirm upload completion
router.post('/confirm-upload', async (req, res) => {
    try {
        const { fileId } = req.body;

        if (!fileId) {
            return res.status(400).json({ error: 'Missing fileId' });
        }

        // Just verify the file exists - no need to update status
        const { data: file, error } = await supabase
            .from('files')
            .select('id')
            .eq('id', fileId)
            .single();

        if (error || !file) {
            console.error('Error confirming upload:', error);
            return res.status(500).json({ error: 'Failed to confirm upload' });
        }

        console.log(`[Upload Confirmed] File ID: ${fileId}`);
        res.json({ success: true });

    } catch (error) {
        console.error('Error confirming upload:', error);
        res.status(500).json({ error: 'Failed to confirm upload' });
    }
});

export default router;
