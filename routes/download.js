import express from 'express';
import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client, R2_BUCKET } from '../lib/r2-client.js';
import { supabase } from '../lib/supabase.js';
import { logAccess } from '../lib/access-logger.js';
import { authorizeRoomAccess } from '../lib/room-auth.js';

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
            .select('*, rooms!inner(id, expires_at, one_time_download, mode, status, remaining_files, download_in_progress)')
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

        // Authorization: author token OR device presence
        const authorToken = req.headers['x-author-token'];
        const deviceId = req.headers['x-device-id'] || null;
        const auth = await authorizeRoomAccess(file.rooms.id, authorToken, deviceId);
        if (!auth.authorized) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        // ENFORCE one-time download OR burn mode already downloaded
        if ((file.rooms.one_time_download || file.burn_after_download) && file.download_count > 0) {
            return res.status(410).json({
                error: 'File already downloaded',
                message: 'This file was configured for one-time download only'
            });
        }

        if ((file.rooms.one_time_download || file.burn_after_download) && file.rooms.download_in_progress) {
            return res.status(409).json({
                error: 'Download already in progress',
                message: 'This file is currently being downloaded'
            });
        }

        // Resolve guest number if deviceId is present
        let guestNumber = null;
        if (deviceId) {
            try {
                // We use the idempotent assign_user_number to get/ensure the number exists
                const { data } = await supabase.rpc('assign_user_number', {
                    p_room_id: file.rooms.id,
                    p_device_id: deviceId
                });
                guestNumber = data;
            } catch (err) {
                console.error('[Download] Failed to resolve guest number:', err);
                // Non-fatal, will log as Unknown or just device_id
            }
        }

        // NOTE: Download count + logging happens in POST /api/download/end after completion.

        // Generate signed URL (5 minutes expiry)
        const command = new GetObjectCommand({
            Bucket: R2_BUCKET,
            Key: fileKey,
        });

        const signedUrl = await getSignedUrl(r2Client, command, {
            expiresIn: 300, // 5 minutes
        });

        const isBurnMode = file.burn_after_download || file.rooms.mode === 'burn';

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
        const { roomId, fileId, deviceId } = req.body;
        const authorToken = req.headers['x-author-token'];

        if (!roomId) {
            return res.status(400).json({ error: 'Missing roomId' });
        }

        const auth = await authorizeRoomAccess(roomId, authorToken, deviceId);
        if (!auth.authorized) {
            return res.status(403).json({ error: 'Forbidden' });
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
        const { roomId, fileId, success, deviceId } = req.body;
        const authorToken = req.headers['x-author-token'];

        if (!roomId) {
            return res.status(400).json({ error: 'Missing roomId' });
        }

        const auth = await authorizeRoomAccess(roomId, authorToken, deviceId);
        if (!auth.authorized) {
            return res.status(403).json({ error: 'Forbidden' });
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

        // Log + increment ONLY on successful completion (file reached user's device)
        if (success && deviceId && fileId) {
            const { data: file, error: fileError } = await supabase
                .from('files')
                .select('*, rooms!inner(id, mode, one_time_download, remaining_files, status, download_in_progress)')
                .eq('id', fileId)
                .single();

            if (fileError || !file) {
                return res.status(404).json({ error: 'File not found' });
            }

            // Increment download count on completion
            const newDownloadCount = (file.download_count || 0) + 1;
            await supabase
                .from('files')
                .update({ download_count: newDownloadCount })
                .eq('id', file.id);

            // Deduplicate: Check if this specific file download was already logged
            const { data: existingLog } = await supabase
                .from('access_logs')
                .select('id')
                .eq('room_id', roomId)
                .eq('device_id', deviceId)
                .eq('event_type', 'file_download')
                .limit(1)
                .maybeSingle();

            if (!existingLog) {
                // Resolve guest number
                let guestNumber = null;
                try {
                    const { data } = await supabase.rpc('assign_user_number', {
                        p_room_id: roomId,
                        p_device_id: deviceId
                    });
                    guestNumber = data;
                } catch (err) {
                    console.error('[Download] Failed to resolve guest number:', err);
                }

                await logAccess(roomId, 'file_download', req, null, deviceId, guestNumber);
                console.log(`[Download] ✓ Logged download for device ${deviceId.substring(0, 8)}...`);
            } else {
                console.log(`[Download] Skipped duplicate log for device ${deviceId.substring(0, 8)}...`);
            }

            // 🔥 Burn/one-time download destruction happens AFTER completion
            const isBurnMode = file.burn_after_download || file.rooms.mode === 'burn';
            if (isBurnMode || file.rooms.one_time_download) {
                setTimeout(async () => {
                    try {
                        await r2Client.send(new DeleteObjectCommand({
                            Bucket: R2_BUCKET,
                            Key: file.file_key
                        }));

                        await supabase
                            .from('files')
                            .update({ file_status: 'destroyed' })
                            .eq('id', file.id);

                        await supabase
                            .from('files')
                            .delete()
                            .eq('id', file.id);

                        if (file.rooms.mode === 'burn') {
                            const { data: updatedRoom } = await supabase
                                .from('rooms')
                                .select('remaining_files')
                                .eq('id', file.rooms.id)
                                .single();

                            if (updatedRoom) {
                                const newRemainingFiles = Math.max(0, (updatedRoom.remaining_files || 1) - 1);
                                const { data: updateResult } = await supabase
                                    .from('rooms')
                                    .update({ remaining_files: newRemainingFiles })
                                    .eq('id', file.rooms.id)
                                    .select('remaining_files')
                                    .single();

                                if (updateResult && updateResult.remaining_files === 0) {
                                    await supabase
                                        .from('rooms')
                                        .update({
                                            status: 'terminating',
                                            termination_started_at: new Date().toISOString()
                                        })
                                        .eq('id', file.rooms.id);

                                    setTimeout(async () => {
                                        const { data: roomCheck } = await supabase
                                            .from('rooms')
                                            .select('status, download_in_progress')
                                            .eq('id', file.rooms.id)
                                            .single();

                                        if (roomCheck && roomCheck.status === 'terminating') {
                                            if (roomCheck.download_in_progress) {
                                                setTimeout(arguments.callee, 30000);
                                                return;
                                            }

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

                                            await supabase
                                                .from('rooms')
                                                .update({ status: 'destroyed' })
                                                .eq('id', file.rooms.id);

                                            await supabase
                                                .from('rooms')
                                                .delete()
                                                .eq('id', file.rooms.id);
                                        }
                                    }, 30000);
                                }
                            }
                        }
                    } catch (error) {
                        console.error('[Burn Mode] Destruction error:', error);
                    }
                }, 3000);
            }
        }

        res.json({ success: true, locked: false });
    } catch (error) {
        console.error('[Download Lock] Error:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

// POST /api/download/bulk-mark - Mark multiple files as downloaded (for ZIP bulk download)
router.post('/bulk-mark', async (req, res) => {
    try {
        const { roomId, fileIds, deviceId } = req.body;
        const authorToken = req.headers['x-author-token'];

        if (!roomId || !fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
            return res.status(400).json({ error: 'Missing roomId or fileIds' });
        }

        const auth = await authorizeRoomAccess(roomId, authorToken, deviceId || req.headers['x-device-id']);
        if (!auth.authorized) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        console.log(`[Bulk Mark] Marking ${fileIds.length} files as downloaded in room ${roomId}`);

        // Get room info
        const { data: room, error: roomError } = await supabase
            .from('rooms')
            .select('mode, status, remaining_files')
            .eq('id', roomId)
            .single();

        if (roomError || !room) {
            return res.status(404).json({ error: 'Room not found' });
        }

        const isBurnMode = room.mode === 'burn';
        let filesMarked = 0;

        // Process each file
        for (const fileId of fileIds) {
            try {
                // Increment download_count for each file
                await supabase
                    .from('files')
                    .update({ download_count: supabase.rpc ? 1 : 1 }) // Simple increment
                    .eq('id', fileId);

                // Decrement remaining_files for burn mode
                if (isBurnMode) {
                    const { error: decError } = await supabase.rpc('decrement_remaining_files', { room_id_input: roomId });

                    if (decError) {
                        // Fallback
                        const { data: currentRoom } = await supabase
                            .from('rooms')
                            .select('remaining_files')
                            .eq('id', roomId)
                            .single();

                        await supabase
                            .from('rooms')
                            .update({ remaining_files: Math.max(0, (currentRoom?.remaining_files || 0) - 1) })
                            .eq('id', roomId);
                    }
                }

                filesMarked++;
            } catch (fileError) {
                console.error(`[Bulk Mark] Failed to mark file ${fileId}:`, fileError);
            }
        }

        // Check if all files consumed -> trigger burn mode
        if (isBurnMode) {
            const { data: updatedRoom } = await supabase
                .from('rooms')
                .select('remaining_files')
                .eq('id', roomId)
                .single();

            if (updatedRoom && updatedRoom.remaining_files === 0) {
                console.log(`[Bulk Mark] 🔥 All files consumed! Starting room termination...`);

                await supabase
                    .from('rooms')
                    .update({
                        status: 'terminating',
                        termination_started_at: new Date().toISOString()
                    })
                    .eq('id', roomId);
            }
        }

        // NOTE: bulk_download is logged in bulk-download.js when actual download occurs
        // No need to log here (this is just marking files)

        res.json({
            success: true,
            filesMarked,
            message: `Marked ${filesMarked} files as downloaded`
        });

    } catch (error) {
        console.error('[Bulk Mark] Error:', error);
        res.status(500).json({ error: 'Failed to mark files' });
    }
});

export default router;

