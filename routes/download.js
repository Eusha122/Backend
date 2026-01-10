import express from 'express';
import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client, R2_BUCKET } from '../lib/r2-client.js';
import { supabase } from '../lib/supabase.js';
import { logAccess } from '../lib/access-logger.js';

const router = express.Router();

// GET /api/download?fileKey=<KEY> - Generate signed URL for file DOWNLOAD (tracks downloads, enforces one-time)
router.get('/', async (req, res) => {
    try {
        const { fileKey } = req.query;

        if (!fileKey) {
            return res.status(400).json({ error: 'Missing fileKey parameter' });
        }

        // Validate file exists and fetch room info including one_time_download
        const { data: file, error: fileError } = await supabase
            .from('files')
            .select('*, rooms!inner(id, expires_at, one_time_download)')
            .eq('file_key', fileKey)
            .single();

        if (fileError || !file) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Check if room is expired
        if (new Date(file.rooms.expires_at) < new Date()) {
            return res.status(410).json({ error: 'File expired' });
        }

        // ENFORCE room-level one-time download BEFORE generating signed URL
        if (file.rooms.one_time_download && file.download_count > 0) {
            return res.status(410).json({
                error: 'File already downloaded',
                message: 'This file was configured for one-time download only'
            });
        }

        // Log file download
        await logAccess(file.rooms.id, 'file_download', req);

        // Increment download count BEFORE generating signed URL
        const newDownloadCount = file.download_count + 1;
        const { error: updateError } = await supabase
            .from('files')
            .update({ download_count: newDownloadCount })
            .eq('id', file.id);

        if (updateError) {
            console.error('[Download] Failed to update download count:', updateError);
        }

        // Generate signed URL (5 minutes expiry)
        const command = new GetObjectCommand({
            Bucket: R2_BUCKET,
            Key: fileKey,
        });

        const signedUrl = await getSignedUrl(r2Client, command, {
            expiresIn: 300, // 5 minutes
        });

        // If one-time download, schedule deletion after download completes
        if (file.rooms.one_time_download) {
            console.log(`[One-Time Download] File ${file.filename} downloaded, scheduling deletion`);

            // Delete after 5 seconds to ensure download completes
            setTimeout(async () => {
                try {
                    // Delete from R2
                    await r2Client.send(new DeleteObjectCommand({
                        Bucket: R2_BUCKET,
                        Key: fileKey
                    }));
                    console.log(`[One-Time Download] ✓ Deleted from R2: ${fileKey}`);
                } catch (error) {
                    console.error(`[One-Time Download] ✗ Failed to delete from R2:`, error);
                }

                // Delete from database
                try {
                    const { error: deleteError } = await supabase
                        .from('files')
                        .delete()
                        .eq('id', file.id);

                    if (deleteError) {
                        console.error(`[One-Time Download] ✗ Failed to delete from database:`, deleteError);
                    } else {
                        console.log(`[One-Time Download] ✓ Deleted from database: ${file.filename}`);
                    }
                } catch (error) {
                    console.error(`[One-Time Download] ✗ Database deletion error:`, error);
                }
            }, 5000); // 5-second delay
        }

        res.json({
            signedUrl,
            filename: file.filename,
        });
    } catch (error) {
        console.error('[Download] Error:', error);
        res.status(500).json({ error: 'Failed to generate download URL' });
    }
});

export default router;
