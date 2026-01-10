// Simple geolocation using ipapi.co free tier (1000 requests/day)
export async function getGeolocation(ip) {
    // Skip for localhost/private IPs
    if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
        return { country: 'Local', city: 'Local' };
    }

    try {
        const response = await fetch(`https://ipapi.co/${ip}/json/`);
        if (response.ok) {
            const data = await response.json();
            return {
                country: data.country_name || 'Unknown',
                city: data.city || 'Unknown'
            };
        }
    } catch (error) {
        console.error('Geolocation error:', error);
    }

    return { country: 'Unknown', city: 'Unknown' };
}
