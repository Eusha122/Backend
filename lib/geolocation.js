// Enhanced geolocation using ipinfo.io (50k requests/month free tier)
// Returns city, region, country, postal code, and timezone
export async function getGeolocation(ip) {
    // Helper to check if IP is local/private
    const isLocalIP = (addr) => {
        if (!addr) return true;
        // Normalize IPv6-mapped IPv4 addresses (e.g., ::ffff:127.0.0.1 -> 127.0.0.1)
        const normalized = addr.replace(/^::ffff:/, '');
        return (
            normalized === '::1' ||
            normalized === '127.0.0.1' ||
            normalized.startsWith('192.168.') ||
            normalized.startsWith('10.') ||
            normalized.startsWith('172.16.') ||
            normalized.startsWith('172.17.') ||
            normalized.startsWith('172.18.') ||
            normalized.startsWith('172.19.') ||
            normalized.startsWith('172.2') ||
            normalized.startsWith('172.30.') ||
            normalized.startsWith('172.31.')
        );
    };

    // Skip for localhost/private IPs
    if (isLocalIP(ip)) {
        return {
            country: 'Local',
            city: 'Development',
            region: 'Local Network',
            postal: 'N/A',
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        };
    }

    try {
        // Use ipinfo.io with optional token for higher limits
        const token = process.env.IPINFO_TOKEN || '';
        const url = token
            ? `https://ipinfo.io/${ip}/json?token=${token}`
            : `https://ipinfo.io/${ip}/json`;

        const response = await fetch(url, {
            headers: { 'User-Agent': 'ShareSafe/1.0' }
        });

        if (response.ok) {
            const data = await response.json();
            return {
                country: data.country || `IP: ${ip}`,
                city: data.city || 'Unknown',
                region: data.region || '',
                postal: data.postal || '',
                timezone: data.timezone || ''
            };
        }
    } catch (error) {
        console.error('ipinfo.io error:', error.message);
    }

    // Better fallback - show IP instead of generic "Unknown"
    return {
        country: `IP: ${ip.substring(0, 15)}...`,
        city: 'Online',
        region: '',
        postal: '',
        timezone: ''
    };
}
