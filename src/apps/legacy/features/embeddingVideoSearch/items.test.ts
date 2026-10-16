import type { Api } from '@jellyfin/sdk';
import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { idleSignal } from './abort';
import { ITEM_TIMEOUT_MS } from './constants';
import { fetchOfficialItem } from './items';

const getItem = vi.hoisted(() => vi.fn());

vi.mock('@jellyfin/sdk/lib/utils/api/library-api', () => ({
    getLibraryApi: () => ({
        getItem
    })
}));

const ITEM_D = '01234567-89ab-cdef-0123-456789abcdef';
const ITEM_N = '0123456789abcdef0123456789abcdef';

describe('fetchOfficialItem', () => {
    it('sends the item timeout and treats 401, 403, and 404 as inaccessible', async () => {
        const missing = new axios.AxiosError('missing');
        missing.response = {
            status: 404,
            data: {},
            statusText: 'Not Found',
            headers: {},
            config: {} as never
        };
        getItem.mockRejectedValueOnce(missing);

        await expect(fetchOfficialItem({} as Api, 'user-1', ITEM_D, idleSignal())).resolves.toBeNull();
        expect(getItem).toHaveBeenCalledWith(
            { userId: 'user-1', itemId: ITEM_N },
            expect.objectContaining({ timeout: ITEM_TIMEOUT_MS })
        );

        for (const status of [401, 403]) {
            const denied = new axios.AxiosError('denied');
            denied.response = {
                status,
                data: {},
                statusText: 'Denied',
                headers: {},
                config: {} as never
            };
            getItem.mockRejectedValueOnce(denied);
            await expect(fetchOfficialItem({} as Api, 'user-1', ITEM_D, idleSignal())).resolves.toBeNull();
        }
    });

    it('does not turn a metadata timeout into an empty item', async () => {
        const timeout = new axios.AxiosError('timeout', 'ECONNABORTED');
        getItem.mockRejectedValueOnce(timeout);

        await expect(fetchOfficialItem({} as Api, 'user-1', ITEM_D, idleSignal())).rejects.toBe(timeout);
        expect(getItem).toHaveBeenCalledWith(
            { userId: 'user-1', itemId: ITEM_N },
            expect.objectContaining({ timeout: ITEM_TIMEOUT_MS })
        );
    });
});
