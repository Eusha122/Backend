# ShareSafe Backend

Express server for ShareSafe Rooms file sharing application with Cloudflare R2 storage.

## Features

- 🔒 Secure file upload to Cloudflare R2
- 🔗 Signed URLs for file downloads (5-minute expiry)
- ⏰ Auto-cleanup of expired rooms and files (24-hour TTL)
- 🛡️ Room password validation
- 📦 Support for large files (up to 500MB)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables

Copy `.env` and fill in your credentials:

```env
NODE_ENV=development
PORT=3001

# Supabase (for database access)
SUPABASE_URL=https://reqjbhbpobfofkpnskun.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key_here

# Cloudflare R2
R2_ACCOUNT_ID=your_account_id
R2_ACCESS_KEY_ID=your_access_key
R2_SECRET_ACCESS_KEY=your_secret_key
R2_BUCKET_NAME=sharesafe-files
R2_ENDPOINT=https://your_account_id.r2.cloudflarestorage.com
```

**Important:** Get your Supabase Service Role Key from:
- Dashboard → Project Settings → API → service_role (secret)

Create new R2 credentials if you exposed the old ones:
- Cloudflare → R2 → Manage R2 API Tokens → Create API Token

### 3. Database Migration

Run the migration to add `expires_at` and `file_key` columns:

```bash
# In the main project directory
npx supabase db push
```

Or manually run `../supabase/migrations/20260108_add_r2_support.sql` in your Supabase SQL editor.

## Development

Start the server:

```bash
npm run dev
```

Server will run on http://localhost:3001

## API Endpoints

### POST /api/upload
Upload a file to R2 storage.

**Request:**
- Content-Type: multipart/form-data
- Body: `file` (file), `roomId` (string)

**Response:**
```json
{
  "success": true,
  "fileKey": "room-uuid/file-uuid_filename.ext",
  "file": { ... }
}
```

### GET /api/download
Generate a signed URL for file download.

**Query Parameters:**
- `fileKey`: R2 object key

**Response:**
```json
{
  "signedUrl": "https://...",
  "filename": "file.pdf"
}
```

### GET /health
Health check endpoint.

## Cleanup Job

The cleanup cron job runs hourly and:
1. Finds rooms where `expires_at < now()`
2. Deletes all associated files from R2
3. Deletes room and file records from database

**Manual cleanup:**
```bash
npm run cleanup
```

## Production Deployment

### Option 1: Traditional Server (Oracle Cloud, Render, etc.)

1. Set environment variables
2. Start server: `npm start`
3. Use a process manager like PM2:
   ```bash
   npm install -g pm2
   pm2 start server.js --name sharesafe-backend
   pm2 save
   ```

### Option 2: Railway / Render / Fly.io

1. Connect GitHub repo
2. Set build command: `npm install`
3. Set start command: `npm start`
4. Add environment variables in dashboard

### Option 3: Docker

Create `Dockerfile`:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3001
CMD ["npm", "start"]
```

Build and run:
```bash
docker build -t sharesafe-backend .
docker run -p 3001:3001 --env-file .env sharesafe-backend
```

## Security Notes

⚠️ **Never commit `.env` files**
⚠️ **Never use `VITE_` prefix for R2 credentials**
⚠️ **Always use HTTPS in production**
⚠️ **Keep Supabase Service key secret**

## Troubleshooting

### R2 Upload Fails

- Check R2 credentials are correct
- Verify bucket name matches
- Ensure R2 endpoint includes account ID

### Database Errors

- Verify `file_key` column exists (run migration)
- Check Supabase service key has proper permissions

### Cleanup Job Not Running

- Check cron expression in `server.js`
- Verify server stays running (use PM2)
- Check logs for errors

## Project Structure

```
backend/
├── lib/
│   ├── r2-client.js      # R2/S3 client configuration
│   └── supabase.js       # Supabase client
├── routes/
│   ├── upload.js         # File upload endpoint
│   └── download.js       # File download endpoint
├── scripts/
│   └── cleanup.js        # Cleanup expired rooms
├── server.js             # Main Express server
├── package.json
└── .env                  # Environment variables (gitignored)
```
