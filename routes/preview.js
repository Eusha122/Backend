import express from 'express';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client, R2_BUCKET } from '../lib/r2-client.js';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

// GET /api/preview?fileKey=<KEY> - Generate signed URL for file PREVIEW (read-only, no download tracking)
router.get('/', async (req, res) => {
    try {
        const { fileKey } = req.query;

        if (!fileKey) {
            return res.status(400).json({ error: 'Missing fileKey parameter' });
        }

        // Validate file exists
        const { data: file, error: fileError } = await supabase
            .from('files')
            .select('*, rooms!inner(id, expires_at)')
            .eq('file_key', fileKey)
            .single();

        if (fileError || !file) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Check if room is expired
        if (new Date(file.rooms.expires_at) < new Date()) {
            return res.status(410).json({ error: 'File expired' });
        }

        // Increment preview count (ONLY tracking, no restrictions)
        const { error: updateError } = await supabase
            .from('files')
            .update({ preview_count: (file.preview_count || 0) + 1 })
            .eq('id', file.id);

        if (updateError) {
            console.error('[Preview] Failed to update preview count:', updateError);
        }

        // Generate signed URL (5 minutes expiry)
        const command = new GetObjectCommand({
            Bucket: R2_BUCKET,
            Key: fileKey,
        });

        // PROXY MODE: Stream the file directly through the backend (bypasses CORS)
        if (req.query.proxy === 'true') {
            try {
                const s3Response = await r2Client.send(command);

                // Set appropriate headers
                res.setHeader('Content-Type', s3Response.ContentType || 'application/octet-stream');
                res.setHeader('Content-Length', s3Response.ContentLength);

                // Stream the body
                s3Response.Body.pipe(res);
                return;
            } catch (err) {
                console.error('[Preview Proxy] Error:', err);
                return res.status(500).json({ error: 'Failed to stream file' });
            }
        }

        // STANDARD MODE: Return signed URL
        const signedUrl = await getSignedUrl(r2Client, command, {
            expiresIn: 300, // 5 minutes
        });

        console.log(`[Preview] File previewed: ${file.filename}, preview_count: ${(file.preview_count || 0) + 1}`);

        res.json({
            signedUrl,
            filename: file.filename,
        });
    } catch (error) {
        console.error('[Preview] Error:', error);
        res.status(500).json({ error: 'Failed to generate preview URL' });
    }
});

export default router;
