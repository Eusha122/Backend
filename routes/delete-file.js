import express from 'express';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, R2_BUCKET } from '../lib/r2-client.js';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

// DELETE /api/delete-file/:fileId - Delete a file (author only)
router.delete('/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;

        // Get file info
        const { data: file, error: fileError } = await supabase
            .from('files')
            .select('*, rooms!inner(id)')
            .eq('id', fileId)
            .single();

        if (fileError || !file) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Delete from R2
        try {
            await r2Client.send(new DeleteObjectCommand({
                Bucket: R2_BUCKET,
                Key: file.file_key
            }));
            console.log(`[Delete] Removed from R2: ${file.file_key}`);
        } catch (r2Error) {
            console.error('[Delete] R2 deletion failed:', r2Error);
            // Continue even if R2 deletion fails
        }

        // Delete from database
        const { error: dbError } = await supabase
            .from('files')
            .delete()
            .eq('id', fileId);

        if (dbError) throw dbError;

        console.log(`[Delete] File deleted: ${file.filename}`);
        // Note: remaining_files is auto-decremented by DB trigger 'after_file_delete'

        res.json({ success: true, message: 'File deleted successfully' });
    } catch (error) {
        console.error('Error deleting file:', error);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

export default router;
