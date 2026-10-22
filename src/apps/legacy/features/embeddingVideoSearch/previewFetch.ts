import { PREVIEW_TIMEOUT_MS, previewPath } from './constants';
import { isAbortError, type PluginApi } from './transport';
import { urlContainsSecret, urlOmitsCredentials } from './urlSafety';

export type PreviewFetch =
    | { kind: 'image'; blob: Blob }
    | { kind: 'none' }
    | { kind: 'busy' }
    | { kind: 'failed' }
    | { kind: 'aborted' };

export function previewBlobOk(blob: Blob): boolean {
    if (blob.size <= 0) {
        return false;
    }

    const type = blob.type.toLowerCase();
    return type.length === 0 || type === 'image/jpeg' || type === 'image/jpg';
}

export function classifyPreview(status: number, blob: Blob | undefined): Exclude<PreviewFetch, { kind: 'aborted' }> {
    if (status === 404) {
        return { kind: 'none' };
    }

    if (status === 429) {
        return { kind: 'busy' };
    }

    if (status === 200 && blob && previewBlobOk(blob)) {
        return { kind: 'image', blob };
    }

    return { kind: 'failed' };
}

export function keepPreview(input: { requestedKey: string; currentKey: string; aborted: boolean }): boolean {
    return input.requestedKey.length > 0 && input.requestedKey === input.currentKey && !input.aborted;
}

export async function fetchSegmentPreview(
    api: PluginApi,
    segmentId: string,
    bindingVersion: string | undefined,
    signal: AbortSignal
): Promise<PreviewFetch> {
    if (!bindingVersion) {
        return { kind: 'failed' };
    }

    const header = api.authorizationHeader;
    const url = api.getUri(previewPath(segmentId, bindingVersion));
    if (header.length === 0 || !urlOmitsCredentials(url) || urlContainsSecret(url, header)) {
        return { kind: 'failed' };
    }

    try {
        const response = await api.axiosInstance.get(url, {
            headers: {
                Authorization: header,
                Accept: 'image/jpeg',
                'Cache-Control': 'no-cache'
            },
            responseType: 'blob',
            signal,
            timeout: PREVIEW_TIMEOUT_MS,
            validateStatus: () => true
        });
        const blob = response.data instanceof Blob ? response.data : undefined;
        return classifyPreview(response.status, blob);
    } catch (error) {
        if (isAbortError(error) || signal.aborted) {
            return { kind: 'aborted' };
        }

        return { kind: 'failed' };
    }
}
