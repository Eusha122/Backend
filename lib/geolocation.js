// Enhanced geolocation using ipinfo.io (50k requests/month free tier)
// Returns city, region, country, postal code, and timezone
export async function getGeolocation(ip) {
    // Skip for localhost/private IPs
    if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
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
