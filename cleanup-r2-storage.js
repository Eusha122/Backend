/**
 * R2 CLEANUP SCRIPT - Delete all files from Cloudflare R2 bucket
 * 
 * This script will delete ALL files from your R2 bucket.
 * ⚠️ WARNING: This is IRREVERSIBLE!
 */

import dotenv from 'dotenv';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '.env') });

// Initialize R2 client
const r2Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

const BUCKET_NAME = process.env.R2_BUCKET || 'upshares-files';

async function deleteAllFromR2() {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║         R2 Storage - Complete Cleanup Script          ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log(`\n🗑️  Deleting all files from bucket: ${BUCKET_NAME}`);
    console.log('⚠️  This action is IRREVERSIBLE!\n');

    console.log('Starting in 3 seconds... (Press Ctrl+C to cancel)');
    await new Promise(resolve => setTimeout(resolve, 3000));

    try {
        let continuationToken = undefined;
        let totalDeleted = 0;
        let batchCount = 0;

        do {
            // List objects
            const listCommand = new ListObjectsV2Command({
                Bucket: BUCKET_NAME,
                ContinuationToken: continuationToken,
                MaxKeys: 1000, // Process 1000 at a time
            });

            console.log(`\n📋 Fetching batch ${++batchCount}...`);
            const listResponse = await r2Client.send(listCommand);

            if (!listResponse.Contents || listResponse.Contents.length === 0) {
                console.log('   ✓ No more files to delete');
                break;
            }

            // Delete objects in this batch
            const objectsToDelete = listResponse.Contents.map(obj => ({ Key: obj.Key }));

            const deleteCommand = new DeleteObjectsCommand({
                Bucket: BUCKET_NAME,
                Delete: {
                    Objects: objectsToDelete,
                    Quiet: false,
                },
            });

            console.log(`   Deleting ${objectsToDelete.length} files...`);
            const deleteResponse = await r2Client.send(deleteCommand);

            const deletedCount = deleteResponse.Deleted?.length || 0;
            totalDeleted += deletedCount;

            console.log(`   ✓ Deleted ${deletedCount} files (total: ${totalDeleted})`);

            if (deleteResponse.Errors && deleteResponse.Errors.length > 0) {
                console.error(`   ⚠️  ${deleteResponse.Errors.length} errors occurred`);
                deleteResponse.Errors.forEach(err => {
                    console.error(`      - ${err.Key}: ${err.Message}`);
                });
            }

            continuationToken = listResponse.NextContinuationToken;
        } while (continuationToken);

        console.log('\n╔════════════════════════════════════════════════════════╗');
        console.log('║                  ✅ CLEANUP COMPLETE                   ║');
        console.log('╚════════════════════════════════════════════════════════╝');
        console.log(`\n   🗑️  Deleted ${totalDeleted} files from R2`);
        console.log(`   📦 Bucket: ${BUCKET_NAME}`);
        console.log('\n   Your R2 storage is now clean! 🎉\n');

    } catch (error) {
        console.error('\n❌ Cleanup failed:', error.message);
        console.error('\nPossible issues:');
        console.error('  • Check your .env file has correct R2 credentials');
        console.error('  • Verify R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
        console.error('  • Ensure bucket name is correct:', BUCKET_NAME);
        process.exit(1);
    }
}

// Run the cleanup
deleteAllFromR2();
