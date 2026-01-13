import { DeleteObjectCommand, ListMultipartUploadsCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { r2Client, R2_BUCKET } from '../lib/r2-client.js';
import { supabase } from '../lib/supabase.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Abort stale multipart uploads that were never completed or canceled correctly.
 * These "ongoing" uploads consume space but aren't visible as files.
 */
async function cleanupIncompleteUploads() {
    console.log('[Cleanup] Checking for incomplete multipart uploads...');

    try {
        const listCommand = new ListMultipartUploadsCommand({
            Bucket: R2_BUCKET,
        });

        const { Uploads } = await r2Client.send(listCommand);

        if (!Uploads || Uploads.length === 0) {
            console.log('[Cleanup] No incomplete multipart uploads found.');
            return;
        }

        console.log(`[Cleanup] Found ${Uploads.length} ongoing multipart upload(s).`);

        const now = new Date();
        const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

        for (const upload of Uploads) {
            const uploadAge = now.getTime() - new Date(upload.Initiated).getTime();

            // Only abort if it's older than our threshold (to avoid killing active uploads)
            if (uploadAge > STALE_THRESHOLD_MS) {
                console.log(`[Cleanup] Aborting stale upload: ${upload.Key} (ID: ${upload.UploadId})`);

                try {
                    await r2Client.send(new AbortMultipartUploadCommand({
                        Bucket: R2_BUCKET,
                        Key: upload.Key,
                        UploadId: upload.UploadId,
                    }));
                    console.log(`[Cleanup] ✓ Aborted: ${upload.Key}`);
                } catch (err) {
                    console.error(`[Cleanup] ✗ Failed to abort ${upload.Key}:`, err.message);
                }
            } else {
                console.log(`[Cleanup] Skipping active upload: ${upload.Key} (Age: ${Math.round(uploadAge / 3600000)}h)`);
            }
        }
    } catch (error) {
        console.error('[Cleanup] Error checking multipart uploads:', error);
    }
}

/**
 * Cleanup expired rooms and their files
 * Run this script via cron job every hour
 */
async function cleanupExpiredRooms() {
    console.log('[Cleanup] Starting cleanup job at', new Date().toISOString());

    try {
        // First, clean up incomplete uploads (ghost files)
        await cleanupIncompleteUploads();

        // Find all expired rooms
        const { data: expiredRooms, error: roomsError } = await supabase
            .from('rooms')
            .select('id, name')
            .lt('expires_at', new Date().toISOString())
            .eq('is_permanent', false); // 🛡️ EXEMPT PERMANENT ROOMS

        if (roomsError) {
            console.error('[Cleanup] Error fetching expired rooms:', roomsError);
            return;
        }

        if (!expiredRooms || expiredRooms.length === 0) {
            console.log('[Cleanup] No expired rooms found');
            return;
        }

        console.log(`[Cleanup] Found ${expiredRooms.length} expired room(s)`);

        for (const room of expiredRooms) {
            console.log(`[Cleanup] Processing room: ${room.id} (${room.name})`);

            // Get all files for this room
            const { data: files, error: filesError } = await supabase
                .from('files')
                .select('file_key, filename')
                .eq('room_id', room.id);

            if (filesError) {
                console.error(`[Cleanup] Error fetching files for room ${room.id}:`, filesError);
                continue;
            }

            // Delete files from R2
            if (files && files.length > 0) {
                console.log(`[Cleanup] Deleting ${files.length} file(s) from R2`);

                for (const file of files) {
                    try {
                        await r2Client.send(
                            new DeleteObjectCommand({
                                Bucket: R2_BUCKET,
                                Key: file.file_key,
                            })
                        );
                        console.log(`[Cleanup] ✓ Deleted: ${file.filename}`);
                    } catch (error) {
                        console.error(`[Cleanup] ✗ Failed to delete ${file.filename}:`, error.message);
                    }
                }
            }

            // Delete room from database (cascade will delete files table rows)
            const { error: deleteError } = await supabase
                .from('rooms')
                .delete()
                .eq('id', room.id);

            if (deleteError) {
                console.error(`[Cleanup] Error deleting room ${room.id}:`, deleteError);
            } else {
                console.log(`[Cleanup] ✓ Room deleted: ${room.id}`);
            }
        }

        console.log('[Cleanup] Cleanup job completed successfully');
    } catch (error) {
        console.error('[Cleanup] Fatal error:', error);
    }
}

// Run cleanup if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    cleanupExpiredRooms()
        .then(() => {
            console.log('[Cleanup] Script finished');
            process.exit(0);
        })
        .catch((error) => {
            console.error('[Cleanup] Script failed:', error);
            process.exit(1);
        });
}

export { cleanupExpiredRooms };
