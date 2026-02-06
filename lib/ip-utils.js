export function getClientIP(req) {
    if (!req) return '';

    // Highest priority — proxy chain (Vercel, Nginx, CDN)
    const xff = req.headers['x-forwarded-for'];
    if (xff && typeof xff === 'string') {
        const first = xff.split(',')[0].trim();
        if (first) return normalizeIP(first);
    }

    // Secondary proxy header
    const realIP = req.headers['x-real-ip'];
    if (realIP && typeof realIP === 'string') {
        return normalizeIP(realIP.trim());
    }

    // Express computed IP (works only when trust proxy is enabled)
    if (req.ip) {
        return normalizeIP(req.ip);
    }

    // Socket fallback
    if (req.socket && req.socket.remoteAddress) {
        return normalizeIP(req.socket.remoteAddress);
    }

    return '';
}

function normalizeIP(ip) {
    if (!ip) return '';

    // Convert IPv6-mapped IPv4 → IPv4
    if (ip.startsWith('::ffff:')) {
        return ip.substring(7);
    }

    return ip;
}
