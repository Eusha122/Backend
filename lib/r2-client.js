import { S3Client } from '@aws-sdk/client-s3';
import { config } from './config.js';

// Initialize R2 client (S3-compatible)
export const r2Client = new S3Client({
    region: 'auto',
    endpoint: config.r2.endpoint,
    credentials: {
        accessKeyId: config.r2.accessKeyId,
        secretAccessKey: config.r2.secretAccessKey,
    },
});

// Support both variable names to fail-safe against configuration errors
export const R2_BUCKET = config.r2.bucket;
