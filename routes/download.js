import express from 'express';
import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client, R2_BUCKET } from '../lib/r2-client.js';
import { supabase } from '../lib/supabase.js';
import { logAccess } from '../lib/access-logger.js';

const router = express.Router();

// GET /api/download?fileKey=<KEY> - Generate signed URL for file DOWNLOAD (tracks downloads, handles burn mode)
router.get('/', async (req, res) => {
    try {
        const { fileKey } = req.query;

        if (!fileKey) {
            return res.status(400).json({ error: 'Missing fileKey parameter' });
        }

        // Validate file exists and fetch room info including mode and status
        const { data: file, error: fileError } = await supabase
            .from('files')
            .select('*, rooms!inner(id, expires_at, one_time_download, mode, status, remaining_files)')
            .eq('file_key', fileKey)
            .single();

        if (fileError || !file) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Check if room is destroyed
        if (file.rooms.status === 'destroyed') {
            return res.status(410).json({
                error: 'Room destroyed',
                message: 'This room has been permanently destroyed.'
            });
        }

        // Check if file is already destroyed (burn mode)
        if (file.file_status === 'destroyed') {
            return res.status(410).json({
                error: 'File destroyed',
                message: 'This file has been permanently destroyed after download.'
            });
        }

        // Check if room is expired
        if (new Date(file.rooms.expires_at) < new Date()) {
            return res.status(410).json({ error: 'File expired' });
        }

        // ENFORCE one-time download OR burn mode already downloaded
        if ((file.rooms.one_time_download || file.burn_after_download) && file.download_count > 0) {
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

        // 🔥 BURN MODE: Handle file destruction after download
        const isBurnMode = file.burn_after_download || file.rooms.mode === 'burn';

        if (isBurnMode || file.rooms.one_time_download) {
            console.log(`[🔥 Burn Mode] File ${file.filename} downloaded, scheduling destruction...`);

            // Delete after 5 seconds to ensure download completes
            setTimeout(async () => {
                try {
                    // 1. Delete from R2 storage
                    await r2Client.send(new DeleteObjectCommand({
                        Bucket: R2_BUCKET,
                        Key: fileKey
                    }));
                    console.log(`[🔥 Burn Mode] ✓ Deleted from R2: ${fileKey}`);

                    // 2. Update file status to destroyed (for real-time notification)
                    await supabase
                        .from('files')
                        .update({ file_status: 'destroyed' })
                        .eq('id', file.id);

                    // 3. Delete file record from database
                    const { error: deleteError } = await supabase
                        .from('files')
                        .delete()
                        .eq('id', file.id);

                    if (deleteError) {
                        console.error(`[🔥 Burn Mode] ✗ Failed to delete from database:`, deleteError);
                    } else {
                        console.log(`[🔥 Burn Mode] ✓ Deleted from database: ${file.filename}`);
                    }

                    // 4. 🔥 BURN MODE: Decrement remaining_files and check for room termination
                    if (file.rooms.mode === 'burn') {
                        const { data: updatedRoom, error: roomUpdateError } = await supabase
                            .from('rooms')
                            .select('remaining_files')
                            .eq('id', file.rooms.id)
                            .single();

                        if (!roomUpdateError && updatedRoom) {
                            const newRemainingFiles = Math.max(0, (updatedRoom.remaining_files || 1) - 1);

                            // Update remaining_files count
                            const { data: updateResult, error: updateCountError } = await supabase
                                .from('rooms')
                                .update({ remaining_files: newRemainingFiles })
                                .eq('id', file.rooms.id)
                                .select('remaining_files')
                                .single();

                            if (updateCountError) {
                                console.error(`[🔥 Burn Mode] Failed to update remaining files:`, updateCountError);
                            } else {
                                console.log(`[🔥 Burn Mode] Room ${file.rooms.id} remaining files updated to: ${updateResult.remaining_files} (calculated: ${newRemainingFiles})`);

                                // 5. If no files remaining, start room termination countdown
                                if (updateResult.remaining_files === 0) {
                                    console.log(`[🔥 Burn Mode] 🚨 All files consumed! Starting room termination...`);

                                    // Set room status to 'terminating' with timestamp
                                    const { error: termError } = await supabase
                                        .from('rooms')
                                        .update({
                                            status: 'terminating',
                                            termination_started_at: new Date().toISOString()
                                        })
                                        .eq('id', file.rooms.id);

                                    if (termError) {
                                        console.error(`[🔥 Burn Mode] Failed to set terminating status:`, termError);
                                    } else {
                                        console.log(`[🔥 Burn Mode] Room status set to 'terminating'`);
                                    }

                                    // 6. After 15 seconds (5s download buffer + 10s countdown), destroy room
                                    setTimeout(async () => {
                                        try {
                                            // Final check - room should still be terminating
                                            const { data: roomCheck } = await supabase
                                                .from('rooms')
                                                .select('status, download_in_progress')
                                                .eq('id', file.rooms.id)
                                                .single();


                                            if (roomCheck && roomCheck.status === 'terminating') {
                                                // 🔥 CHECK DOWNLOAD LOCK: Don't destroy if download in progress
                                                if (roomCheck.download_in_progress) {
                                                    console.log(`[🔥 Burn Mode] ⏳ Download in progress, delaying destruction...`);
                                                    // Re-schedule check in 30 seconds
                                                    setTimeout(arguments.callee, 30000);
                                                    return;
                                                }

                                                // Delete any remaining files from R2 (shouldn't be any, but safety)
                                                const { data: remainingFiles } = await supabase
                                                    .from('files')
                                                    .select('file_key')
                                                    .eq('room_id', file.rooms.id);

                                                if (remainingFiles && remainingFiles.length > 0) {
                                                    for (const f of remainingFiles) {
                                                        try {
                                                            await r2Client.send(new DeleteObjectCommand({
                                                                Bucket: R2_BUCKET,
                                                                Key: f.file_key
                                                            }));
                                                        } catch (e) {
                                                            console.error(`[🔥 Burn Mode] Failed to delete orphan file:`, e);
                                                        }
                                                    }
                                                }

                                                // Set room to destroyed (will trigger real-time event)
                                                await supabase
                                                    .from('rooms')
                                                    .update({ status: 'destroyed' })
                                                    .eq('id', file.rooms.id);

                                                // Delete room from database
                                                await supabase
                                                    .from('rooms')
                                                    .delete()
                                                    .eq('id', file.rooms.id);

                                                console.log(`[🔥 Burn Mode] 💀 Room ${file.rooms.id} has been permanently destroyed`);
                                            }
                                        } catch (error) {
                                            console.error(`[🔥 Burn Mode] Room destruction error:`, error);
                                        }
                                    }, 30000); // 30-second countdown after terminating status
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.error(`[🔥 Burn Mode] ✗ File destruction error:`, error);
                }
            }, 120000); // 120-second delay for large file download + decryption
        }

        res.json({
            signedUrl,
            filename: file.filename,
            burnMode: isBurnMode,
            roomStatus: file.rooms.status,
        });
    } catch (error) {
        console.error('[Download] Error:', error);
        res.status(500).json({ error: 'Failed to generate download URL' });
    }
});

// POST /api/download/start - Mark download as started (lock room destruction)
router.post('/start', async (req, res) => {
    try {
        const { roomId, fileId } = req.body;

        if (!roomId) {
            return res.status(400).json({ error: 'Missing roomId' });
        }

        console.log(`[Download Lock] 🔒 Download started for room ${roomId}, file ${fileId || 'unknown'}`);

        const { error } = await supabase
            .from('rooms')
            .update({
                download_in_progress: true,
                last_download_activity: new Date().toISOString()
            })
            .eq('id', roomId);

        if (error) {
            console.error('[Download Lock] Failed to set lock:', error);
            return res.status(500).json({ error: 'Failed to set download lock' });
        }

        res.json({ success: true, locked: true });
    } catch (error) {
        console.error('[Download Lock] Error:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// POST /api/download/end - Mark download as finished (unlock room destruction)
router.post('/end', async (req, res) => {
    try {
        const { roomId, fileId, success } = req.body;

        if (!roomId) {
            return res.status(400).json({ error: 'Missing roomId' });
        }

        console.log(`[Download Lock] 🔓 Download ended for room ${roomId}, file ${fileId || 'unknown'}, success: ${success}`);

        const { error } = await supabase
            .from('rooms')
            .update({
                download_in_progress: false,
                last_download_activity: new Date().toISOString()
            })
            .eq('id', roomId);

        if (error) {
            console.error('[Download Lock] Failed to clear lock:', error);
            return res.status(500).json({ error: 'Failed to clear download lock' });
        }

        res.json({ success: true, locked: false });
    } catch (error) {
        console.error('[Download Lock] Error:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

export default router;
