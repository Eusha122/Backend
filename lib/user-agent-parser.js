// Parse user agent to extract browser and OS information
export function parseUserAgent(userAgent) {
    if (!userAgent) {
        return { browser: 'Unknown', os: 'Unknown', device: 'Unknown' };
    }

    // Detect OS
    let os = 'Unknown';
    if (/Windows NT 10/.test(userAgent)) os = 'Windows 10';
    else if (/Windows NT 11/.test(userAgent)) os = 'Windows 11';
    else if (/Windows/.test(userAgent)) os = 'Windows';
    else if (/Mac OS X/.test(userAgent)) os = 'macOS';
    else if (/Android/.test(userAgent)) os = 'Android';
    else if (/iOS|iPhone|iPad/.test(userAgent)) os = 'iOS';
    else if (/Linux/.test(userAgent)) os = 'Linux';

    // Detect Browser
    let browser = 'Unknown';
    if (/Edg\//.test(userAgent)) browser = 'Edge';
    else if (/Chrome\//.test(userAgent)) browser = 'Chrome';
    else if (/Safari\//.test(userAgent) && !/Chrome/.test(userAgent)) browser = 'Safari';
    else if (/Firefox\//.test(userAgent)) browser = 'Firefox';
    else if (/Opera|OPR\//.test(userAgent)) browser = 'Opera';

    // Detect Device Type
    let device = 'Desktop';
    if (/Mobile|Android|iPhone/.test(userAgent)) device = 'Mobile';
    else if (/Tablet|iPad/.test(userAgent)) device = 'Tablet';

    return { browser, os, device };
}
