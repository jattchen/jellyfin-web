const CREDENTIAL_QUERY_KEYS = new Set([
    'apikey',
    'token',
    'accesstoken',
    'authorization'
]);

function queryKeyName(key: string): string {
    return key.toLowerCase().replace(/[_-]/g, '');
}

export function urlOmitsCredentials(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url, 'https://jellyfin.local');
    } catch {
        return false;
    }

    for (const key of parsed.searchParams.keys()) {
        if (CREDENTIAL_QUERY_KEYS.has(queryKeyName(key))) {
            return false;
        }
    }

    return true;
}

export function urlContainsSecret(url: string, secret: string): boolean {
    return secret.length > 0 && url.includes(secret);
}
