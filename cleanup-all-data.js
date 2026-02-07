/**
 * CLEANUP SCRIPT - Delete all test data from Supabase and R2
 * 
 * This script will:
 * 1. Delete all files from Cloudflare R2 bucket
 * 2. Delete all database records (files, rooms, messages)
 * 
 * ⚠️ WARNING: This is IRREVERSIBLE! All data will be permanently deleted.
 */

import { createClient } from '@supabase/supabase-js';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { config } from './lib/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Supabase
const supabase = createClient(
    config.supabaseUrl,
    config.supabaseServiceKey
);

// Initialize R2 client
const r2Client = new S3Client({
    region: 'auto',
    endpoint: config.r2.endpoint,
    credentials: {
        accessKeyId: config.r2.accessKeyId,
        secretAccessKey: config.r2.secretAccessKey,
    },
});

async function deleteAllFromR2() {
    console.log('\n🗑️  Deleting all files from R2 bucket...');

    try {
        let continuationToken = undefined;
        let totalDeleted = 0;

        do {
            // List objects
            const listCommand = new ListObjectsV2Command({
                Bucket: config.r2.bucket,
                ContinuationToken: continuationToken,
            });

            const listResponse = await r2Client.send(listCommand);

            if (!listResponse.Contents || listResponse.Contents.length === 0) {
                console.log('   No more files to delete in R2');
                break;
            }

            // Delete objects in batches
            const objectsToDelete = listResponse.Contents.map(obj => ({ Key: obj.Key }));

            const deleteCommand = new DeleteObjectsCommand({
                Bucket: config.r2.bucket,
                Delete: {
                    Objects: objectsToDelete,
                },
            });

            await r2Client.send(deleteCommand);
            totalDeleted += objectsToDelete.length;
            console.log(`   Deleted ${objectsToDelete.length} files (total: ${totalDeleted})`);

            continuationToken = listResponse.NextContinuationToken;
        } while (continuationToken);

        console.log(`✅ Deleted ${totalDeleted} files from R2`);
        return totalDeleted;
    } catch (error) {
        console.error('❌ Error deleting from R2:', error.message);
        throw error;
    }
}

async function deleteAllFromDatabase() {
    console.log('\n🗑️  Deleting all records from Supabase...');

    try {
        // Delete in order to respect foreign key constraints

        // 1. Delete all files
        const { data: files, error: filesError } = await supabase
            .from('files')
            .delete()
            .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all

        if (filesError) throw filesError;
        console.log(`   ✓ Deleted all files records`);

        // 2. Delete all messages
        const { data: messages, error: messagesError } = await supabase
            .from('messages')
            .delete()
            .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all

        if (messagesError) throw messagesError;
        console.log(`   ✓ Deleted all messages records`);

        // 3. Delete all rooms
        const { data: rooms, error: roomsError } = await supabase
            .from('rooms')
            .delete()
            .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all

        if (roomsError) throw roomsError;
        console.log(`   ✓ Deleted all rooms records`);

        console.log('✅ All database records deleted');
    } catch (error) {
        console.error('❌ Error deleting from database:', error.message);
        throw error;
    }
}

async function main() {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║       ShareSafe - Complete Data Cleanup Script        ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log('\n⚠️  WARNING: This will DELETE ALL data from:');
    console.log('   • Cloudflare R2 bucket (all uploaded files)');
    console.log('   • Supabase database (rooms, files, messages)');
    console.log('\n   This action is IRREVERSIBLE!\n');

    // Wait 3 seconds to allow user to cancel
    console.log('Starting in 3 seconds... (Press Ctrl+C to cancel)');
    await new Promise(resolve => setTimeout(resolve, 3000));

    try {
        // Step 1: Delete from R2
        const r2Count = await deleteAllFromR2();

        // Step 2: Delete from Database
        await deleteAllFromDatabase();

        console.log('\n╔════════════════════════════════════════════════════════╗');
        console.log('║                  ✅ CLEANUP COMPLETE                   ║');
        console.log('╚════════════════════════════════════════════════════════╝');
        console.log(`\n   • ${r2Count} files deleted from R2`);
        console.log('   • All database records deleted');
        console.log('\n   Your ShareSafe instance is now clean! 🎉\n');

    } catch (error) {
        console.error('\n❌ Cleanup failed:', error.message);
        process.exit(1);
    }
}

// Run the cleanup
main();
