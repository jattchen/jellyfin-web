import type { Api } from '@jellyfin/sdk';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import { getImageApi } from '@jellyfin/sdk/lib/utils/api/image-api';
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api';
import axios from 'axios';

import { ITEM_TIMEOUT_MS } from './constants';
import { officialItemRequest } from './guid';
import { itemLabel, type ItemNameSource } from './presentation';
import { isAbortError } from './transport';
import type { ItemCard, ItemLoad } from './types';
import { urlContainsSecret, urlOmitsCredentials } from './urlSafety';
import type { ItemDto } from 'types/base/models/item-dto';

function statusOf(error: unknown): number | undefined {
    if (axios.isAxiosError(error)) {
        return error.response?.status;
    }

    return undefined;
}

export function officialItemOptions(signal: AbortSignal): { signal: AbortSignal; timeout: number } {
    return {
        signal,
        timeout: ITEM_TIMEOUT_MS
    };
}

export async function fetchOfficialItem(
    api: Api,
    userId: string,
    pluginItemId: string,
    signal: AbortSignal
): Promise<ItemDto | null> {
    const request = officialItemRequest(userId, pluginItemId);
    if (!request) {
        return null;
    }

    try {
        const response = await getLibraryApi(api).getItem(request, officialItemOptions(signal));
        return response.data as ItemDto;
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }

        const status = statusOf(error);
        if (status === 401 || status === 403 || status === 404) {
            return null;
        }

        throw error;
    }
}

export function officialPosterUrl(api: Api, item: ItemDto): string | undefined {
    const url = getImageApi(api).getItemImageUrl(item as BaseItemDto, ImageType.Primary, {
        fillWidth: 160,
        fillHeight: 160
    });
    if (!url || !urlOmitsCredentials(url) || urlContainsSecret(url, api.authorizationHeader)) {
        return undefined;
    }

    return url;
}

export async function fetchPosterBlob(api: Api, url: string, signal: AbortSignal): Promise<Blob | undefined> {
    if (!urlOmitsCredentials(url) || urlContainsSecret(url, api.authorizationHeader)) {
        return undefined;
    }

    try {
        const response = await api.axiosInstance.get(url, {
            headers: {
                Authorization: api.authorizationHeader,
                'Cache-Control': 'no-cache'
            },
            responseType: 'blob',
            signal,
            timeout: ITEM_TIMEOUT_MS,
            validateStatus: () => true
        });
        if (response.status !== 200 || !(response.data instanceof Blob) || response.data.size === 0) {
            return undefined;
        }

        return response.data;
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }

        return undefined;
    }
}

export async function loadOfficialItem(
    api: Api,
    userId: string,
    pluginItemId: string,
    signal: AbortSignal
): Promise<ItemLoad> {
    try {
        const item = await fetchOfficialItem(api, userId, pluginItemId, signal);
        if (!item) {
            return { status: 'inaccessible' };
        }

        const card: ItemCard = {
            title: itemLabel(item as ItemNameSource, '')
        };
        const runtime = item.RunTimeTicks;
        if (typeof runtime === 'number' && Number.isSafeInteger(runtime) && runtime > 0) {
            card.runtimeTicks = runtime;
        }
        const posterUrl = officialPosterUrl(api, item);
        if (posterUrl) {
            try {
                card.posterBlob = await fetchPosterBlob(api, posterUrl, signal);
            } catch (error) {
                if (isAbortError(error)) {
                    throw error;
                }
            }
        }

        return { status: 'ready', card };
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }

        return { status: 'failed' };
    }
}
