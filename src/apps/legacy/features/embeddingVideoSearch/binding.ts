const SHA256 = /^[0-9a-f]{64}$/i;

/** Absent is undefined. A present value that is not a SHA-256 digest is null. */
export function normalizeBindingVersion(value: unknown): string | undefined | null {
    if (value == null) {
        return undefined;
    }

    if (typeof value !== 'string' || !SHA256.test(value.trim())) {
        return null;
    }

    return value.trim().toLowerCase();
}

export function bindingAgrees(left: string | undefined, right: string | undefined): boolean {
    if (!left || !right) {
        return false;
    }

    return left.toLowerCase() === right.toLowerCase();
}
