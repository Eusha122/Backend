import express from 'express';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, R2_BUCKET } from '../lib/r2-client.js';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

// DELETE /api/delete-room/:roomId - Delete entire room and all files (author only)
router.delete('/:roomId', async (req, res) => {
    try {
        const { roomId } = req.params;
        const authorToken = req.headers['x-author-token'];

        // === SECURITY: Verify author token ===
        if (!authorToken) {
            return res.status(403).json({ error: 'Missing authorization token' });
        }

        // Get room and verify author token
        const { data: room, error: roomFetchError } = await supabase
            .from('rooms')
            .select('id, author_token')
            .eq('id', roomId)
            .single();

        if (roomFetchError || !room) {
            return res.status(404).json({ error: 'Room not found' });
        }

        if (room.author_token !== authorToken) {
            console.warn(`[Delete Room] Invalid token attempt for room ${roomId.substring(0, 8)}...`);
            return res.status(403).json({ error: 'Invalid authorization token' });
        }
        // === END SECURITY ===

        // Get all files in the room
        const { data: files, error: filesError } = await supabase
            .from('files')
            .select('file_key, filename')
            .eq('room_id', roomId);

        if (filesError) {
            console.error('[Delete Room] Error fetching files:', filesError);
        }

        // Delete all files from R2
        if (files && files.length > 0) {
            for (const file of files) {
                try {
                    await r2Client.send(new DeleteObjectCommand({
                        Bucket: R2_BUCKET,
                        Key: file.file_key
                    }));
                    console.log(`[Delete Room] Removed from R2: ${file.file_key}`);
                } catch (r2Error) {
                    console.error(`[Delete Room] R2 deletion failed for ${file.filename}:`, r2Error);
                }
            }
        }

        // Delete room (files will cascade delete due to foreign key)
        const { error: roomError } = await supabase
            .from('rooms')
            .delete()
            .eq('id', roomId);

        if (roomError) throw roomError;

        console.log(`[Delete Room] Room and ${files?.length || 0} files deleted`);

        res.json({
            success: true,
            message: 'Room deleted successfully',
            filesDeleted: files?.length || 0
        });
    } catch (error) {
        console.error('[Delete Room] Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;

