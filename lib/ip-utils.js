// Helper to get real client IP when behind reverse proxy (Vercel/Nginx)
export function getClientIP(req) {
    return (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.socket?.remoteAddress ||
        req.ip
    );
}
