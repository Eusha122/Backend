// Simple geolocation using ipapi.co free tier (1000 requests/day)
export async function getGeolocation(ip) {
    // Skip for localhost/private IPs
    if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
        return { country: 'Local', city: 'Development' };
    }

    try {
        const response = await fetch(`https://ipapi.co/${ip}/json/`, {
            headers: { 'User-Agent': 'ShareSafe/1.0' }
        });

        if (response.ok) {
            const data = await response.json();
            return {
                country: data.country_name || `IP: ${ip}`,
                city: data.city || 'Online'
            };
        }
    } catch (error) {
        console.error('Geolocation error:', error.message);
    }

    // Better fallback - show IP instead of "Unknown, Unknown"
    return {
        country: `IP: ${ip.substring(0, 15)}...`,
        city: 'Online'
    };
}
