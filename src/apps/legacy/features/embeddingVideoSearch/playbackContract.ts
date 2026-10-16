import { bindingAgrees, normalizeBindingVersion } from './binding';
import { readErrorCode } from './parse';
import {
    DELETE_TIMEOUT_MS,
    PLAYBACK_PATH,
    PLAYBACK_PREFIX,
    PLAYBACK_TIMEOUT_MS,
    TICKS_PER_SECOND,
    playbackItemPath
} from './constants';
import { sameGuid } from './guid';
import type { PluginTransport } from './transport';
import type { SearchHitModel } from './types';
import { urlContainsSecret, urlOmitsCredentials } from './urlSafety';

export interface ActivePlayback {
    playbackId: string
    itemId: string
    mediaSourceId: string
    startTicks: number
    durationTicks: number
    authorization: string
    deleteUrl: string
    mediaUrl: string
}

export type OpenPlayback =
    | { kind: 'ready'; session: ActivePlayback }
    | { kind: 'aborted' }
    | { kind: 'rejected' }
    | { kind: 'incompatible' };

/** Official static streams answer without a login, so they are never a page source. */
export function isNakedStaticStream(url: string): boolean {
    return /\/videos\/[^/?#]+\/stream(?:\.mp4)?(?:$|[?#])/i.test(url)
        || /(?:^|[?&#])static=true(?:&|$)/i.test(url);
}

export function seekSeconds(startTicks: number): number {
    return startTicks / TICKS_PER_SECOND;
}

export function seekConfirmed(currentTime: number, targetSeconds: number): boolean {
    return Number.isFinite(currentTime) && Math.abs(currentTime - targetSeconds) <= 0.75;
}

export function needsSeek(currentTime: number, targetSeconds: number): boolean {
    return !Number.isFinite(currentTime) || Math.abs(currentTime - targetSeconds) > 0.25;
}

export function isAllowedPlaybackUrl(prefix: string, requestUrl: string, secret: string): boolean {
    if (secret.length === 0 || urlContainsSecret(requestUrl, secret) || !urlOmitsCredentials(requestUrl)) {
        return false;
    }

    if (isNakedStaticStream(requestUrl)) {
        return false;
    }

    let root: URL;
    let target: URL;
    try {
        root = new URL(prefix);
        target = new URL(requestUrl, root);
    } catch {
        return false;
    }

    if (target.origin !== root.origin) {
        return false;
    }

    const rootPath = root.pathname.endsWith('/') ? root.pathname : `${root.pathname}/`;
    return rootPath.includes(PLAYBACK_PREFIX) && target.pathname.startsWith(rootPath);
}

export function authorizePlaybackXhr(input: {
    prefix: string
    authorization: string
    currentAuthorization: string
    url: string
}): boolean {
    // The server hashes the header that created the session. A newer token of the same user is not that header.
    if (input.currentAuthorization.length === 0 || input.currentAuthorization !== input.authorization) {
        return false;
    }

    return isAllowedPlaybackUrl(input.prefix, input.url, input.authorization);
}

export function continueSameFilm(
    active: { itemId: string; mediaSourceId: string; authorization: string } | undefined,
    hit: { itemId: string; mediaSourceId: string },
    authorization: string
): boolean {
    if (!active || active.authorization !== authorization) {
        return false;
    }

    return sameGuid(active.itemId, hit.itemId) && active.mediaSourceId === hit.mediaSourceId;
}

export function shouldClearVideo(currentPlaybackId: string | undefined, playbackId: string): boolean {
    return currentPlaybackId === playbackId;
}

export function positionFrame(input: { frameUrl?: string; posterUrl?: string }): string | undefined {
    if (!input.frameUrl || input.frameUrl === input.posterUrl || isNakedStaticStream(input.frameUrl)) {
        return undefined;
    }

    return input.frameUrl;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPlaybackId(value: unknown, secret: string): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const id = value.trim();
    if (!id || /[/?#\\]/.test(id) || urlContainsSecret(id, secret)) {
        return undefined;
    }

    return id;
}

function readManifestPath(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.startsWith(PLAYBACK_PREFIX) || value.length <= PLAYBACK_PREFIX.length) {
        return undefined;
    }

    if (value.includes('://') || isNakedStaticStream(value) || !urlOmitsCredentials(value)) {
        return undefined;
    }

    return value;
}

function readSafeInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return undefined;
    }

    return value;
}

export interface ParsedPlayback {
    playbackId: string
    manifestPath: string
    itemId: string
    mediaSourceId: string
    startTicks: number
    durationTicks: number
}

/** Returns the id even when the rest of the body cannot be used, so the caller can close it. */
export function readPlayback(
    data: unknown,
    hit: SearchHitModel,
    secret: string
): { ok: true; session: ParsedPlayback } | { ok: false; playbackId?: string; binding: boolean } {
    if (!isRecord(data)) {
        return { ok: false, binding: false };
    }

    const playbackId = readPlaybackId(data.playbackId, secret);
    const manifestPath = readManifestPath(data.manifestUrl);
    const itemId = typeof data.itemId === 'string' ? data.itemId.trim() : '';
    const mediaSourceId = typeof data.mediaSourceId === 'string' ? data.mediaSourceId : '';
    const startTicks = readSafeInteger(data.startTicks);
    const durationTicks = readSafeInteger(data.durationTicks);
    const responseBinding = normalizeBindingVersion('bindingVersion' in data ? data.bindingVersion : undefined);
    const bindingOk = typeof responseBinding === 'string' && bindingAgrees(responseBinding, hit.bindingVersion);
    const agrees = Boolean(bindingOk && playbackId && manifestPath && itemId && mediaSourceId
        && startTicks !== undefined && durationTicks !== undefined
        && data.timelineOriginTicks === 0
        && sameGuid(itemId, hit.itemId)
        && mediaSourceId === hit.mediaSourceId
        && startTicks === hit.startTicks
        && durationTicks > startTicks);
    if (!agrees || !playbackId || !manifestPath || startTicks === undefined || durationTicks === undefined) {
        return { ok: false, playbackId, binding: !bindingOk };
    }

    return {
        ok: true,
        session: {
            playbackId,
            manifestPath,
            itemId,
            mediaSourceId,
            startTicks,
            durationTicks
        }
    };
}

function pluginUrl(getUri: (path: string) => string, path: string, secret: string): string | undefined {
    const absolute = getUri(path);
    const prefix = getUri(PLAYBACK_PREFIX);
    if (!isAllowedPlaybackUrl(prefix, absolute, secret)) {
        return undefined;
    }

    return absolute;
}

export async function deletePlaybackSession(
    api: { axiosInstance: { delete?: (url: string, config: object) => Promise<unknown> } },
    session: { deleteUrl: string; authorization: string }
): Promise<void> {
    const remove = api.axiosInstance.delete;
    if (!remove || !urlOmitsCredentials(session.deleteUrl) || urlContainsSecret(session.deleteUrl, session.authorization)) {
        return;
    }

    try {
        await remove(session.deleteUrl, {
            headers: {
                Authorization: session.authorization,
                Accept: 'application/json',
                'Cache-Control': 'no-cache'
            },
            timeout: DELETE_TIMEOUT_MS,
            validateStatus: () => true
        });
    } catch {
        // Closing a session that is already gone should not block the next one.
    }
}

export async function openPlaybackSession(input: {
    transport: PluginTransport
    getUri: (path: string) => string
    authorization: string
    hit: SearchHitModel
    signal: AbortSignal
    deleteSession?: (session: { deleteUrl: string; authorization: string }) => Promise<void>
}): Promise<OpenPlayback> {
    if (!input.hit.bindingVersion) {
        return { kind: 'incompatible' };
    }

    const posted = await input.transport.request({
        method: 'POST',
        path: PLAYBACK_PATH,
        body: {
            segmentId: input.hit.segmentId,
            expectedBindingVersion: input.hit.bindingVersion
        },
        timeoutMs: PLAYBACK_TIMEOUT_MS,
        signal: input.signal
    });
    if (posted.kind === 'aborted') {
        return { kind: 'aborted' };
    }

    if (posted.kind === 'response' && posted.status === 409 && readErrorCode(posted.data) === 'stale') {
        return { kind: 'incompatible' };
    }

    if (posted.kind !== 'response' || posted.status !== 200) {
        return { kind: 'rejected' };
    }

    const read = readPlayback(posted.data, input.hit, input.authorization);
    const close = async (playbackId: string) => {
        const deleteUrl = pluginUrl(input.getUri, playbackItemPath(playbackId), input.authorization);
        if (!deleteUrl || !input.deleteSession) {
            return;
        }

        await input.deleteSession({ deleteUrl, authorization: input.authorization });
    };

    if (!read.ok) {
        if (read.playbackId) {
            await close(read.playbackId);
        }

        return { kind: read.binding ? 'incompatible' : 'rejected' };
    }

    const mediaUrl = pluginUrl(input.getUri, read.session.manifestPath, input.authorization);
    const deleteUrl = pluginUrl(input.getUri, playbackItemPath(read.session.playbackId), input.authorization);
    if (!mediaUrl || !deleteUrl) {
        await close(read.session.playbackId);
        return { kind: 'rejected' };
    }

    return {
        kind: 'ready',
        session: {
            ...read.session,
            authorization: input.authorization,
            deleteUrl,
            mediaUrl
        }
    };
}
