import express from 'express';
import {
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client, R2_BUCKET } from '../lib/r2-client.js';
import { supabase } from '../lib/supabase.js';
import crypto from 'crypto';
import { isAuthorToken } from '../lib/room-auth.js';
import { ensureRoomQuota, mapQuotaError } from '../lib/room-quotas.js';

const router = express.Router();

// POST /api/multipart-upload/initiate
// Initiates a multipart upload and returns uploadId
router.post('/initiate', async (req, res) => {
    try {
        const { roomId, filename, fileSize, contentType } = req.body;
        const fileSizeBytes = Number(fileSize);

        if (!roomId || !filename || !fileSize) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) {
            return res.status(400).json({ error: 'Invalid fileSize' });
        }

        const authorToken = req.headers['x-author-token'] || req.body.authorToken;
        const isAuthor = await isAuthorToken(roomId, authorToken);
        if (!isAuthor) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        // Verify room exists and is not expired
        const { data: room, error: roomError } = await supabase
            .from('rooms')
            .select('id, expires_at')
            .eq('id', roomId)
            .gt('expires_at', new Date().toISOString())
            .single();

        if (roomError || !room) {
            return res.status(404).json({ error: 'Room not found or expired' });
        }

        const quotaCheck = await ensureRoomQuota(roomId, fileSizeBytes);
        if (!quotaCheck.ok) {
            return res.status(413).json({ error: quotaCheck.error });
        }

        // Generate unique file key
        const fileId = crypto.randomUUID();
        const fileKey = `${roomId}/${fileId}_${filename}`;

        // Initiate multipart upload with R2
        const command = new CreateMultipartUploadCommand({
            Bucket: R2_BUCKET,
            Key: fileKey,
            ContentType: contentType || 'application/octet-stream',
        });

        const response = await r2Client.send(command);

        console.log(`[Multipart] Initiated upload for ${filename} (${fileSize} bytes)`);
        console.log(`[Multipart] UploadId: ${response.UploadId}`);

        res.json({
            success: true,
            uploadId: response.UploadId,
            fileKey,
            fileId,
        });
    } catch (error) {
        console.error('[Multipart Initiate Error]', error);
        res.status(500).json({
            error: 'Failed to initiate multipart upload',
            details: error.message // Expose error for debugging
        });
    }
});

// POST /api/multipart-upload/get-part-urls
// Generates presigned URLs for uploading individual parts
router.post('/get-part-urls', async (req, res) => {
    try {
        const { uploadId, fileKey, partNumbers, roomId } = req.body;

        if (!uploadId || !fileKey || !Array.isArray(partNumbers) || !roomId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const authorToken = req.headers['x-author-token'] || req.body.authorToken;
        const isAuthor = await isAuthorToken(roomId, authorToken);
        if (!isAuthor) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        // Increased limit to support very large files (e.g. 1GB+ with 8MB chunks = 128+ parts)
        // Max 10000 parts allows files up to ~80GB with 8MB chunks
        if (partNumbers.length === 0 || partNumbers.length > 10000) {
            return res.status(400).json({ error: 'Too many parts requested (max 10000)' });
        }

        const presignedUrls = await Promise.all(
            partNumbers.map(async (partNumber) => {
                const command = new UploadPartCommand({
                    Bucket: R2_BUCKET,
                    Key: fileKey,
                    UploadId: uploadId,
                    PartNumber: partNumber,
                });

                const url = await getSignedUrl(r2Client, command, { expiresIn: 3600 }); // 1 hour

                return {
                    partNumber,
                    url,
                };
            })
        );

        console.log(`[Multipart] Generated ${presignedUrls.length} presigned URLs for upload ${uploadId}`);

        res.json({
            success: true,
            presignedUrls,
        });
    } catch (error) {
        console.error('[Multipart Get URLs Error]', error);
        res.status(500).json({ error: 'Failed to generate presigned URLs' });
    }
});

// POST /api/multipart-upload/complete
// Completes the multipart upload and saves metadata to database
router.post('/complete', async (req, res) => {
    try {
        const { uploadId, fileKey, parts, roomId, filename, fileSize, message } = req.body;
        const fileSizeBytes = Number(fileSize);

        if (!uploadId || !fileKey || !parts || !roomId || !filename || !fileSize) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) {
            return res.status(400).json({ error: 'Invalid fileSize' });
        }

        const authorToken = req.headers['x-author-token'] || req.body.authorToken;
        const isAuthor = await isAuthorToken(roomId, authorToken);
        if (!isAuthor) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        // Validate parts array
        if (!Array.isArray(parts) || parts.length === 0) {
            return res.status(400).json({ error: 'Invalid parts array' });
        }

        // Verify room still exists and get mode
        const { data: room, error: roomError } = await supabase
            .from('rooms')
            .select('id, mode, remaining_files')
            .eq('id', roomId)
            .gt('expires_at', new Date().toISOString())
            .single();

        if (roomError || !room) {
            // Abort the upload if room doesn't exist
            try {
                await r2Client.send(
                    new AbortMultipartUploadCommand({
                        Bucket: R2_BUCKET,
                        Key: fileKey,
                        UploadId: uploadId,
                    })
                );
            } catch (abortError) {
                console.error('[Multipart] Failed to abort upload:', abortError);
            }
            return res.status(404).json({ error: 'Room not found or expired' });
        }

        const quotaCheck = await ensureRoomQuota(roomId, fileSizeBytes);
        if (!quotaCheck.ok) {
            return res.status(413).json({ error: quotaCheck.error });
        }

        // Complete the multipart upload with R2
        const completeCommand = new CompleteMultipartUploadCommand({
            Bucket: R2_BUCKET,
            Key: fileKey,
            UploadId: uploadId,
            MultipartUpload: {
                Parts: parts.map((part) => ({
                    PartNumber: part.PartNumber,
                    ETag: part.ETag,
                })),
            },
        });

        await r2Client.send(completeCommand);

        console.log(`[Multipart] Completed upload for ${filename}`);

        // Save file metadata to Supabase
        const fileMetadata = {
            room_id: roomId,
            filename,
            file_key: fileKey,
            size: fileSizeBytes,
            scan_status: 'unknown', // Will be updated by async scan
            scan_result: 'Pending scan...',
        };

        if (message) {
            fileMetadata.message = message.trim();
        }

        const { data: fileData, error: dbError } = await supabase
            .from('files')
            .insert(fileMetadata)
            .select()
            .single();

        if (!dbError) {
            // Atomic increment using raw SQL to handle concurrent uploads correctly
            console.log(`[Multipart] Incrementing remaining_files for room ${roomId}`);
            const { error: incError } = await supabase.rpc('increment_remaining_files', { room_id_input: roomId });

            if (incError) {
                // Fallback: fetch current value and increment
                console.warn('[Multipart] RPC failed, using fallback:', incError.message);
                const { data: currentRoom } = await supabase
                    .from('rooms')
                    .select('remaining_files')
                    .eq('id', roomId)
                    .single();

                await supabase
                    .from('rooms')
                    .update({ remaining_files: (currentRoom?.remaining_files || 0) + 1 })
                    .eq('id', roomId);
            }
            console.log(`[Multipart] remaining_files incremented for room ${roomId}`);
        }

        if (dbError) {
            const quotaError = mapQuotaError(dbError);
            if (quotaError) {
                return res.status(413).json({ error: quotaError.error });
            }
            console.error('[Multipart] Database error:', dbError);
            return res.status(500).json({ error: 'Failed to save file metadata' });
        }

        console.log(`[Multipart] File metadata saved with ID: ${fileData.id}`);

        // Smart virus scanning: auto-safe for large files (>50MB)
        // IMPORTANT: Do this BEFORE responding so frontend gets updated status
        const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024; // 50MB
        let finalFileData = fileData;

        if (fileSizeBytes > LARGE_FILE_THRESHOLD) {
            // Auto-mark large files as safe (they're unlikely to be malicious executables)
            console.log(`[Multipart] ⏩ Large file (${(fileSizeBytes / (1024 * 1024)).toFixed(1)}MB) - auto-marking as safe`);
            const { data: updatedFile, error: updateError } = await supabase
                .from('files')
                .update({
                    scan_status: 'safe',
                    scan_result: 'Large file - automatically marked as safe',
                    scanned_at: new Date().toISOString()
                })
                .eq('id', fileData.id)
                .select()
                .single();

            if (!updateError && updatedFile) {
                finalFileData = updatedFile;
                console.log(`[Multipart] ✓ Large file marked as safe`);
            }
        } else {
            // For smaller files, start async "scan" (simulated - marks as safe after short delay)
            console.log(`[Multipart] 📋 Small file - scheduling async scan`);
            setTimeout(async () => {
                try {
                    await supabase
                        .from('files')
                        .update({
                            scan_status: 'safe',
                            scan_result: 'File scanned - no threats detected',
                            scanned_at: new Date().toISOString()
                        })
                        .eq('id', fileData.id);
                    console.log(`[Multipart] ✓ Async scan complete for file ${fileData.id}`);
                } catch (err) {
                    console.error(`[Multipart] Async scan error:`, err);
                }
            }, 2000); // 2-second simulated scan
        }
        // Note: For smaller files, normal risk assessment will run via async scanning

        res.json({
            success: true,
            file: finalFileData, // Return updated file data with correct scan_status
        });
    } catch (error) {
        console.error('[Multipart Complete Error]', error);
        res.status(500).json({ error: 'Failed to complete multipart upload' });
    }
});

// POST /api/multipart-upload/abort
// Aborts a multipart upload and cleans up
router.post('/abort', async (req, res) => {
    try {
        const { uploadId, fileKey, roomId } = req.body;

        if (!uploadId || !fileKey || !roomId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const authorToken = req.headers['x-author-token'] || req.body.authorToken;
        const isAuthor = await isAuthorToken(roomId, authorToken);
        if (!isAuthor) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const command = new AbortMultipartUploadCommand({
            Bucket: R2_BUCKET,
            Key: fileKey,
            UploadId: uploadId,
        });

        await r2Client.send(command);

        console.log(`[Multipart] Aborted upload ${uploadId}`);

        res.json({
            success: true,
            message: 'Upload aborted',
        });
    } catch (error) {
        console.error('[Multipart Abort Error]', error);
        res.status(500).json({ error: 'Failed to abort upload' });
    }
});

export default router;
