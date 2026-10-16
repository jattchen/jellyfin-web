export const API_VERSION = '1';
export const TICKS_PER_SECOND = 10000000;
export const API_PREFIX = '/EmbeddingVideoSearch/v1';
export const CAPABILITIES_PATH = `${API_PREFIX}/capabilities`;
export const SEARCH_PATH = `${API_PREFIX}/search`;
export const PLAYBACK_PATH = `${API_PREFIX}/playback`;
export const PLAYBACK_PREFIX = `${PLAYBACK_PATH}/`;
export const GROUPED_VIDEO_FEATURE = 'grouped-video-v1';
/** Request limit is the maximum number of films, not hit rows. */
export const RESULT_LIMIT = 3;
export const VIDEO_LIMIT = 3;
export const HITS_PER_VIDEO = 5;
export const CLIENT_QUERY_ID_MAX = 80;
export const QUERY_MAX_LENGTH = 1000;
export const CAPABILITIES_TIMEOUT_MS = 10000;
export const SEARCH_TIMEOUT_MS = 35000;
export const SEGMENT_TIMEOUT_MS = 10000;
export const ITEM_TIMEOUT_MS = 15000;
export const PLAYBACK_TIMEOUT_MS = 20000;
export const PREVIEW_TIMEOUT_MS = 15000;
export const DELETE_TIMEOUT_MS = 10000;

export const SEARCH_AVAILABILITY = [
    'available',
    'empty',
    'incompatible',
    'modelOffline',
    'timeout',
    'cancelled',
    'queueFull',
    'schemaNewer',
    'hostIncompatible'
] as const;

export type SearchAvailability = typeof SEARCH_AVAILABILITY[number];

export function segmentPath(segmentId: string): string {
    return `${API_PREFIX}/segments/${encodeURIComponent(segmentId)}`;
}

export function previewPath(segmentId: string, bindingVersion: string): string {
    const query = new URLSearchParams({ expectedBindingVersion: bindingVersion });
    return `${segmentPath(segmentId)}/preview?${query.toString()}`;
}

export function playbackItemPath(playbackId: string): string {
    return `${PLAYBACK_PATH}/${encodeURIComponent(playbackId)}`;
}
