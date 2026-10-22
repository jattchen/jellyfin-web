const GUID_N = /^[0-9a-f]{32}$/i;
const GUID_D = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valid Jellyfin N or plugin D GUID, compared as lowercase hex without hyphens. */
export function guidKey(value: string | undefined | null): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    if (GUID_N.test(trimmed)) {
        return trimmed.toLowerCase();
    }

    if (GUID_D.test(trimmed)) {
        return trimmed.replace(/-/g, '').toLowerCase();
    }

    return undefined;
}

export function sameGuid(left: string, right: string): boolean {
    const leftKey = guidKey(left);
    const rightKey = guidKey(right);
    return leftKey !== undefined && leftKey === rightKey;
}

/** Official item routes use the 32-character N form. */
export function toOfficialItemId(value: string): string | undefined {
    return guidKey(value);
}

export function officialItemRequest(
    userId: string,
    pluginItemId: string
): { userId: string; itemId: string } | undefined {
    const itemId = toOfficialItemId(pluginItemId);
    if (!itemId || userId.trim().length === 0) {
        return undefined;
    }

    return {
        userId,
        itemId
    };
}
