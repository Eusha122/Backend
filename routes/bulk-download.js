import express from 'express';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, R2_BUCKET } from '../lib/r2-client.js';
import { supabase } from '../lib/supabase.js';
import archiver from 'archiver';
import { logAccess } from '../lib/access-logger.js';

const router = express.Router();

// GET /api/bulk-download?roomId=xxx - Download all files as ZIP
router.get('/', async (req, res) => {
    try {
        const { roomId } = req.query;

        if (!roomId) {
            return res.status(400).json({ error: 'Missing roomId' });
        }

        // Fetch all files in the room
        const { data: files, error: filesError } = await supabase
            .from('files')
            .select('*')
            .eq('room_id', roomId);

        if (filesError || !files || files.length === 0) {
            return res.status(404).json({ error: 'No files found' });
        }

        // Get room name for ZIP filename
        const { data: room } = await supabase
            .from('rooms')
            .select('name')
            .eq('id', roomId)
            .single();

        const zipFilename = room ? `${room.name.replace(/[^a-z0-9]/gi, '_')}.zip` : 'files.zip';

        // Set headers for ZIP download
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

        // Create ZIP archive
        const archive = archiver('zip', {
            zlib: { level: 6 } // Compression level (0-9)
        });

        // Handle errors
        archive.on('error', (err) => {
            console.error('Archive error:', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to create archive' });
            }
        });

        // Pipe archive to response
        archive.pipe(res);

        // Add each file to the archive
        for (const file of files) {
            try {
                // Get file from R2
                const command = new GetObjectCommand({
                    Bucket: R2_BUCKET,
                    Key: file.file_key,
                });

                const r2Response = await r2Client.send(command);

                // Add file to ZIP with original filename
                archive.append(r2Response.Body, { name: file.filename });
            } catch (error) {
                console.error(`Failed to add file ${file.filename} to archive:`, error);
                // Continue with other files even if one fails
            }
        }

        // Log bulk download access
        await logAccess(roomId, 'bulk_download', req);

        // Finalize the archive
        await archive.finalize();

    } catch (error) {
        console.error('Bulk download error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to download files' });
        }
    }
});

export default router;
