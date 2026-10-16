import axios from 'axios';

import { urlContainsSecret, urlOmitsCredentials } from './urlSafety';

export interface PluginHttp {
    get: (url: string, config: object) => Promise<{ status: number; data: unknown }>
    post: (url: string, body: unknown, config: object) => Promise<{ status: number; data: unknown }>
}

export interface PluginApi {
    axiosInstance: PluginHttp
    getUri: (url: string, params?: object) => string
    authorizationHeader: string
}

export type TransportResult =
    | { kind: 'response'; status: number; data: unknown }
    | { kind: 'aborted' }
    | { kind: 'timeout' }
    | { kind: 'blocked' }
    | { kind: 'network' };

export interface PluginRequest {
    method: 'GET' | 'POST'
    path: string
    body?: unknown
    timeoutMs: number
    signal: AbortSignal
}

export interface PluginTransport {
    request: (call: PluginRequest) => Promise<TransportResult>
}

export function isAbortError(error: unknown): boolean {
    if (axios.isCancel(error)) {
        return true;
    }

    if (axios.isAxiosError(error) && error.code === 'ERR_CANCELED') {
        return true;
    }

    return error instanceof DOMException && error.name === 'AbortError';
}

export function isTimeoutError(error: unknown): boolean {
    return axios.isAxiosError(error) && error.code === 'ECONNABORTED';
}

export function createSdkTransport(api: PluginApi): PluginTransport {
    return {
        request: async (call) => {
            const header = api.authorizationHeader;
            if (header.length === 0) {
                return { kind: 'blocked' };
            }

            const url = api.getUri(call.path);
            if (!urlOmitsCredentials(url) || urlContainsSecret(url, header)) {
                return { kind: 'blocked' };
            }

            const config = {
                headers: {
                    Authorization: header,
                    Accept: 'application/json',
                    'Cache-Control': 'no-cache'
                },
                signal: call.signal,
                timeout: call.timeoutMs,
                validateStatus: () => true
            };

            try {
                let response;
                if (call.method === 'GET') {
                    response = await api.axiosInstance.get(url, config);
                } else {
                    response = await api.axiosInstance.post(url, call.body, config);
                }
                return {
                    kind: 'response',
                    status: response.status,
                    data: response.data
                };
            } catch (error) {
                if (isAbortError(error)) {
                    return { kind: 'aborted' };
                }

                if (isTimeoutError(error)) {
                    return { kind: 'timeout' };
                }

                if (axios.isAxiosError(error) && error.response) {
                    return {
                        kind: 'response',
                        status: error.response.status,
                        data: error.response.data
                    };
                }

                return { kind: 'network' };
            }
        }
    };
}
