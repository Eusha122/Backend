import { S3Client } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize R2 client (S3-compatible)
export const r2Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// Support both variable names to fail-safe against configuration errors
export const R2_BUCKET = process.env.R2_BUCKET_NAME || process.env.R2_BUCKET;
