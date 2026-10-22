import type { Api } from '@jellyfin/sdk';
import { describe, expect, it, vi } from 'vitest';

import { idleSignal } from './abort';
import { API_VERSION, TICKS_PER_SECOND } from './constants';
import { guidKey, officialItemRequest, sameGuid, toOfficialItemId } from './guid';
import { issuePlayTicket, retirePlayGate, runScopedPlay, ticketStillCurrent } from './playGate';
import {
    confirmedHit,
    hasMediaSource,
    nativePlayRequest,
    playConfirmedSegment
} from './playback';
import { noticesFor, partitionHits, toDisplayHit, weakDisclosure } from './presentation';
import { applyPlayOutcome } from './results';
import { classifySegment, readSegment, runSegmentSearch, searchBody } from './searchRun';
import { executeEmbeddingSearch } from './searchSession';
import { createSdkTransport, type PluginApi, type PluginRequest } from './transport';
import type { ItemLoad, ReadySegmentView, SearchHitModel, SegmentDetailModel } from './types';
import { acceptsQuery, canRetryView, searchScopeKey, shouldApplyResult, viewForScope } from './viewState';
import { urlContainsSecret, urlOmitsCredentials } from './urlSafety';
import type { ItemDto } from 'types/base/models/item-dto';

const BINDING = '0123456789abcdef'.repeat(4);
const ITEM_N = '0123456789abcdef0123456789abcdef';
const ITEM_D = '01234567-89ab-cdef-0123-456789abcdef';
const SEGMENT_D = 'abcdef01-2345-6789-abcd-ef0123456789';
const MEDIA = 'mediasource-main';
const PARENT_N = 'ABCDEF0123456789ABCDEF0123456789';
const TOKEN = 'MediaBrowser Client="Jellyfin Web", Token="secret-token"';

function hit(overrides: Partial<SearchHitModel> = {}): SearchHitModel {
    return {
        itemId: ITEM_D,
        mediaSourceId: MEDIA,
        segmentId: SEGMENT_D,
        startTicks: 60_000_000,
        endTicks: 120_000_000,
        score: 0.91,
        quality: 'related',
        indexComplete: true,
        bindingVersion: BINDING,
        ...overrides
    };
}

function detail(overrides: Partial<SegmentDetailModel> = {}): SegmentDetailModel {
    return {
        itemId: ITEM_D,
        mediaSourceId: MEDIA,
        segmentId: SEGMENT_D,
        startTicks: 60_000_000,
        endTicks: 120_000_000,
        indexComplete: true,
        score: 0,
        representation: 'jointAudioVideo',
        bindingVersion: BINDING,
        ...overrides
    };
}

function capabilities(search = 'available', indexComplete = false) {
    return {
        apiVersion: API_VERSION,
        ticksPerSecond: TICKS_PER_SECOND,
        availability: { search },
        coverage: { indexComplete },
        qualityPolicy: { scoreMeaning: 'referenceTailR' },
        features: ['grouped-video-v1']
    };
}

describe('guid identity', () => {
    it('matches official N ids with plugin D ids and rejects other strings', () => {
        expect(sameGuid(ITEM_N, ITEM_D)).toBe(true);
        expect(guidKey(`  ${ITEM_D}  `)).toBe(ITEM_N);
        expect(toOfficialItemId(ITEM_D)).toBe(ITEM_N);
        expect(sameGuid(ITEM_N, '0123456789abcdef0123456789abcdee')).toBe(false);
        expect(guidKey('{01234567-89ab-cdef-0123-456789abcdef}')).toBeUndefined();
        expect(guidKey('not-a-guid')).toBeUndefined();
        expect(officialItemRequest('user-n', ITEM_D)).toEqual({
            userId: 'user-n',
            itemId: ITEM_N
        });
    });

    it('does not coerce a non-guid media source into a guid', () => {
        expect(hasMediaSource([MEDIA], MEDIA)).toBe(true);
        expect(hasMediaSource([ITEM_N], ITEM_D)).toBe(false);
        expect(hasMediaSource(['mediasource-main'], 'mediasource-main ')).toBe(false);
    });
});

describe('search flow', () => {
    it('clears hits while a new query is still waiting and drops late responses', () => {
        expect(viewForScope({ query: '雨夜', signedIn: true })).toEqual({ phase: 'pending' });
        expect(viewForScope({ query: '  ', signedIn: true })).toEqual({ phase: 'idle' });
        expect(shouldApplyResult({
            requestId: 'new',
            expectedId: 'old',
            aborted: false,
            sessionMatches: true
        })).toBe(false);
        expect(shouldApplyResult({
            requestId: 'same',
            expectedId: 'same',
            aborted: true,
            sessionMatches: true
        })).toBe(false);
        expect(shouldApplyResult({
            requestId: 'same',
            expectedId: 'same',
            aborted: false,
            sessionMatches: false
        })).toBe(false);
        expect(acceptsQuery({
            expectedClientQueryId: 'query-a',
            responseClientQueryId: 'query-b'
        })).toBe(false);
        expect(weakDisclosure(true, true)).toBe(false);
        expect(weakDisclosure(true, false)).toBe(true);
    });

    it('rejects a mismatched interface version before search', async () => {
        const calls: PluginRequest[] = [];
        const result = await runSegmentSearch({
            request: (call) => {
                calls.push(call);
                return Promise.resolve({
                    kind: 'response',
                    status: 200,
                    data: { ...capabilities(), apiVersion: '2' }
                });
            }
        }, {
            query: '雨夜',
            clientQueryId: 'query-a',
            signal: idleSignal()
        });

        expect(result).toEqual({ kind: 'problem', problem: 'contract' });
        expect(calls).toHaveLength(1);
    });

    it('rejects a mismatched tick size', async () => {
        const result = await runSegmentSearch({
            request: () => Promise.resolve({
                kind: 'response',
                status: 200,
                data: { ...capabilities(), ticksPerSecond: 1000 }
            })
        }, {
            query: '雨夜',
            clientQueryId: 'query-a',
            signal: idleSignal()
        });

        expect(result).toEqual({ kind: 'problem', problem: 'contract' });
    });

    it('reports a missing plugin without inventing hits', async () => {
        const result = await runSegmentSearch({
            request: () => Promise.resolve({ kind: 'response', status: 404, data: {} })
        }, {
            query: '雨夜',
            clientQueryId: 'query-a',
            signal: idleSignal()
        });

        expect(result).toEqual({ kind: 'problem', problem: 'plugin-absent' });
    });

    it('forwards the page parent id and keeps same-film hits under the per-film cap', async () => {
        const calls: PluginRequest[] = [];
        const hits = [0.2, 0.9, 0.4, 0.8].map((score, index) => hit({
            segmentId: `abcdef01-2345-6789-abcd-ef012345678${index}`,
            score,
            quality: 'related'
        }));
        hits.push(hit({
            segmentId: 'abcdef01-2345-6789-abcd-ef0123456790',
            score: 0.1,
            quality: 'weak',
            indexComplete: false
        }));
        const result = await runSegmentSearch({
            request: (call) => {
                calls.push(call);
                if (call.method === 'GET') {
                    return Promise.resolve({
                        kind: 'response',
                        status: 200,
                        data: capabilities('available', false)
                    });
                }

                return Promise.resolve({
                    kind: 'response',
                    status: 200,
                    data: {
                        apiVersion: API_VERSION,
                        queryId: SEGMENT_D,
                        clientQueryId: 'query-a',
                        availability: { search: 'available' },
                        indexComplete: false,
                        results: hits
                    }
                });
            }
        }, {
            query: '雨夜',
            parentId: PARENT_N,
            clientQueryId: 'query-a',
            signal: idleSignal()
        });

        expect(calls[1]?.body).toEqual({
            query: '雨夜',
            limit: 3,
            groupByVideo: true,
            clientQueryId: 'query-a',
            parentId: PARENT_N
        });
        expect(calls[1]?.body).not.toHaveProperty('libraryIds');
        expect(calls[1]?.body).not.toHaveProperty('userId');
        expect(result.kind).toBe('ready');
        if (result.kind !== 'ready') {
            return;
        }

        expect(result.view.related).toHaveLength(4);
        expect(result.view.related.map(entry => entry.score)).toEqual([0.2, 0.9, 0.4, 0.8]);
        expect(result.view.weak).toHaveLength(1);
        expect(result.view.notices).toEqual(['partial-index']);
        // Kept unchanged for ordering only; the page never renders it.
        expect(toDisplayHit(result.view.related[0]).score).toBe(0.2);
        expect(noticesFor({
            availability: 'available',
            indexComplete: false,
            relatedCount: 0
        })).toEqual(['no-match-partial']);
    });

    it('does not search when the index has nothing to query', async () => {
        const calls: PluginRequest[] = [];
        const result = await runSegmentSearch({
            request: (call) => {
                calls.push(call);
                return Promise.resolve({
                    kind: 'response',
                    status: 200,
                    data: capabilities('empty', false)
                });
            }
        }, {
            query: '雨夜',
            clientQueryId: 'query-a',
            signal: idleSignal()
        });

        expect(calls).toHaveLength(1);
        expect(result.kind).toBe('ready');
        if (result.kind === 'ready') {
            expect(result.view.notices).toEqual(['nothing-searchable-partial']);
        }
    });

    it('keeps the official parent id out of the query string and out of logs', async () => {
        const seen: { url: string; params?: object; header?: string }[] = [];
        const api: PluginApi = {
            authorizationHeader: TOKEN,
            getUri: (url, params) => {
                seen.push({ url, params });
                return `https://jellyfin.example${url}`;
            },
            axiosInstance: {
                get: (url, config) => {
                    const headers = (config as { headers?: { Authorization?: string } }).headers;
                    seen.push({ url, header: headers?.Authorization });
                    return Promise.resolve({ status: 200, data: capabilities() });
                },
                post: (url, body, config) => {
                    const headers = (config as { headers?: { Authorization?: string } }).headers;
                    seen.push({ url, header: headers?.Authorization });
                    return Promise.resolve({
                        status: 200,
                        data: {
                            apiVersion: API_VERSION,
                            queryId: SEGMENT_D,
                            clientQueryId: 'query-a',
                            availability: { search: 'empty' },
                            indexComplete: true,
                            results: []
                        }
                    });
                }
            }
        };

        await runSegmentSearch(createSdkTransport(api), {
            query: '雨夜',
            parentId: PARENT_N,
            clientQueryId: 'query-a',
            signal: idleSignal()
        });

        const urls = seen.map(entry => entry.url).join('\n');
        expect(urls).not.toContain('secret-token');
        expect(urls).not.toContain('Token=');
        expect(seen.every(entry => entry.params === undefined)).toBe(true);
        expect(seen.some(entry => entry.header === TOKEN)).toBe(true);
        expect(urlOmitsCredentials('https://jellyfin.example/Items/1/Images/Primary?tag=abc&fillWidth=160')).toBe(true);
        expect(urlOmitsCredentials('https://jellyfin.example/Items/1/Images/Primary?api_key=secret-token')).toBe(false);
        expect(urlContainsSecret('https://jellyfin.example/?access_token=secret-token', 'secret-token')).toBe(true);
        expect(searchBody({
            query: '雨夜',
            parentId: ` ${PARENT_N} `,
            clientQueryId: 'query-a',
            signal: idleSignal()
        }).parentId).toBe(PARENT_N);
    });
});

describe('segment detail and playback', () => {
    it('keeps the search score when the fresh detail score is zero', () => {
        const clicked = hit({ quality: 'weak', score: 0.42, startTicks: 0, endTicks: 60_000_000 });
        const fresh = detail({ score: 0, startTicks: 0, endTicks: 60_000_000 });
        const confirmed = confirmedHit(clicked, fresh);
        expect(confirmed?.score).toBe(0.42);
        expect(confirmed?.quality).toBe('weak');
        expect(confirmedHit(clicked, detail({ startTicks: 1, endTicks: 60_000_000 }))).toBeUndefined();
    });

    it('plays from the recorded start with the original media source', async () => {
        const clicked = hit({ startTicks: 0, endTicks: 60_000_000 });
        const item = {
            Id: ITEM_N,
            MediaSources: [{ Id: MEDIA }]
        } as ItemDto;
        let options: ReturnType<typeof nativePlayRequest> | undefined;
        const result = await playConfirmedSegment({
            clicked,
            signal: idleSignal(),
            stillCurrent: () => true,
            fetchSegment: () => Promise.resolve({
                kind: 'hit',
                hit: detail({ startTicks: 0, endTicks: 60_000_000 })
            }),
            fetchItem: () => Promise.resolve(item),
            play: (request) => {
                options = request;
                return Promise.resolve();
            }
        });

        expect(result).toEqual({ ok: true });
        expect(options?.startPositionTicks).toBe(0);
        expect(options?.mediaSourceId).toBe(MEDIA);
        expect(options?.items[0]).toBe(item);
        expect(options && Object.keys(options).sort((left, right) => left.localeCompare(right))).toEqual([
            'items',
            'mediaSourceId',
            'startPositionTicks'
        ]);
    });

    it('does not play a stale, incompatible, or missing segment', async () => {
        const play = vi.fn();
        const stale = await playConfirmedSegment({
            clicked: hit(),
            signal: idleSignal(),
            stillCurrent: () => true,
            fetchSegment: () => Promise.resolve({ kind: 'gone', reason: 'stale' }),
            fetchItem: () => Promise.resolve(null),
            play
        });
        const missing = await playConfirmedSegment({
            clicked: hit(),
            signal: idleSignal(),
            stillCurrent: () => true,
            fetchSegment: () => Promise.resolve({ kind: 'gone', reason: 'notFound' }),
            fetchItem: () => Promise.resolve(null),
            play
        });

        expect(stale).toEqual({ ok: false, reason: 'stale' });
        expect(missing).toEqual({ ok: false, reason: 'notFound' });
        expect(play).not.toHaveBeenCalled();
        expect(classifySegment(409, { error: { code: 'stale' } })).toEqual({ kind: 'gone', reason: 'stale' });
        expect(classifySegment(409, { error: { code: 'incompatible' } })).toEqual({ kind: 'gone', reason: 'incompatible' });
        expect(classifySegment(404, { error: { code: 'stale' } })).toEqual({ kind: 'gone', reason: 'stale' });
        expect(classifySegment(404, { error: { code: 'notFound' } })).toEqual({ kind: 'gone', reason: 'notFound' });
    });

    it('does not send play after the session changes', async () => {
        let current = true;
        const gate: {
            resolve?: (value: { kind: 'hit'; hit: SegmentDetailModel }) => void
        } = {};
        const pending = new Promise<{ kind: 'hit'; hit: SegmentDetailModel }>((resolve) => {
            gate.resolve = resolve;
        });
        const play = vi.fn();
        const resultPromise = playConfirmedSegment({
            clicked: hit(),
            signal: idleSignal(),
            stillCurrent: () => current,
            fetchSegment: () => pending,
            fetchItem: () => Promise.resolve({
                Id: ITEM_N,
                MediaSources: [{ Id: MEDIA }]
            } as ItemDto),
            play
        });
        current = false;
        gate.resolve?.({ kind: 'hit', hit: detail() });
        await expect(resultPromise).resolves.toEqual({ ok: false, reason: 'interrupted' });
        expect(play).not.toHaveBeenCalled();
    });

    it('matches the official item id without treating media source ids as guids', async () => {
        const play = vi.fn();
        const result = await playConfirmedSegment({
            clicked: hit({ mediaSourceId: ITEM_D }),
            signal: idleSignal(),
            stillCurrent: () => true,
            fetchSegment: () => Promise.resolve({ kind: 'hit', hit: detail({ mediaSourceId: ITEM_D }) }),
            fetchItem: () => Promise.resolve({
                Id: ITEM_N,
                MediaSources: [{ Id: ITEM_N }]
            } as ItemDto),
            play
        });

        expect(result).toEqual({ ok: false, reason: 'mismatch' });
        expect(play).not.toHaveBeenCalled();
    });

    it('reads segment errors without calling play', async () => {
        const transport = {
            request: () => Promise.resolve({
                kind: 'response' as const,
                status: 409,
                data: { apiVersion: API_VERSION, error: { code: 'incompatible' } }
            })
        };
        await expect(readSegment(transport, SEGMENT_D, idleSignal())).resolves.toEqual({
            kind: 'gone',
            reason: 'incompatible'
        });
        expect(partitionHits([
            hit({ quality: 'weak', segmentId: 'abcdef01-2345-6789-abcd-ef0123456781' }),
            hit()
        ]).related).toHaveLength(1);
    });
});

const OTHER_ITEM = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_SEGMENT = 'abcdef01-2345-6789-abcd-ef0123456791';

function settleLater<T>() {
    const gate: { resolve?: (value: T) => void } = {};
    const promise = new Promise<T>((resolve) => {
        gate.resolve = resolve;
    });
    return {
        promise,
        resolve(value: T) {
            const settle = gate.resolve;
            if (!settle) {
                throw new Error('The deferred response was not ready.');
            }

            settle(value);
        }
    };
}

function readyView(hits: SearchHitModel[]): ReadySegmentView {
    const related = hits.filter(entry => entry.quality === 'related');
    const weak = hits.filter(entry => entry.quality === 'weak');
    return {
        phase: 'ready',
        clientQueryId: 'query-a',
        availability: 'available',
        indexComplete: true,
        related,
        weak,
        notices: []
    };
}

describe('fresh item access after search', () => {
    it('removes hits after the search response when the official item is withdrawn', async () => {
        const steps: string[] = [];
        const withheld = settleLater<ItemLoad>();
        const kept = settleLater<ItemLoad>();
        const pending = executeEmbeddingSearch({
            api: {} as Api,
            userId: 'user-1',
            query: '雨夜',
            clientQueryId: 'query-a',
            signal: idleSignal(),
            transport: {
                request: (call) => {
                    steps.push(call.path);
                    if (call.path.endsWith('/capabilities')) {
                        return Promise.resolve({
                            kind: 'response',
                            status: 200,
                            data: capabilities('available', false)
                        });
                    }

                    return Promise.resolve({
                        kind: 'response',
                        status: 200,
                        data: {
                            apiVersion: API_VERSION,
                            queryId: SEGMENT_D,
                            clientQueryId: 'query-a',
                            availability: { search: 'available' },
                            indexComplete: false,
                            results: [
                                hit({ score: 0.91 }),
                                hit({
                                    itemId: OTHER_ITEM,
                                    segmentId: OTHER_SEGMENT,
                                    score: 0.44
                                })
                            ]
                        }
                    });
                }
            },
            loadItem: (itemId) => {
                steps.push(`load:${itemId}`);
                if (itemId === ITEM_D) {
                    return withheld.promise;
                }

                return kept.promise;
            }
        });

        await vi.waitFor(() => {
            expect(steps).toContain(`load:${ITEM_D}`);
        });
        expect(steps[0]).toContain('/capabilities');
        expect(steps.some(step => step.endsWith('/search'))).toBe(true);
        withheld.resolve({ status: 'inaccessible' });
        kept.resolve({ status: 'ready', card: { title: '还在的影片' } });
        const result = await pending;

        expect(result.kind).toBe('ready');
        if (result.kind !== 'ready') {
            return;
        }

        expect(result.view.related.map(entry => entry.segmentId)).toEqual([OTHER_SEGMENT]);
        expect(result.view.related[0]?.score).toBe(0.44);
        expect(result.view.related.some(entry => entry.itemId === ITEM_D)).toBe(false);
        expect(result.view.notices).not.toContain('no-match');
        expect(result.cards.get(guidKey(OTHER_ITEM) ?? '')?.title).toBe('还在的影片');
    });

    it('keeps unresolved hits when metadata times out and does not call that no match', async () => {
        const result = await executeEmbeddingSearch({
            api: {} as Api,
            userId: 'user-1',
            query: '雨夜',
            clientQueryId: 'query-a',
            signal: idleSignal(),
            transport: {
                request: (call) => {
                    if (call.path.endsWith('/capabilities')) {
                        return Promise.resolve({
                            kind: 'response',
                            status: 200,
                            data: capabilities('available', true)
                        });
                    }

                    return Promise.resolve({
                        kind: 'response',
                        status: 200,
                        data: {
                            apiVersion: API_VERSION,
                            queryId: SEGMENT_D,
                            clientQueryId: 'query-a',
                            availability: { search: 'available' },
                            indexComplete: true,
                            results: [hit({ score: 0.91 })]
                        }
                    });
                }
            },
            loadItem: () => Promise.resolve({ status: 'failed' })
        });

        expect(result.kind).toBe('ready');
        if (result.kind !== 'ready') {
            return;
        }

        expect(result.view.related).toHaveLength(1);
        expect(result.view.related[0]?.score).toBe(0.91);
        expect(result.view.notices).toContain('load-incomplete');
        expect(result.view.notices).not.toContain('no-match');
        expect(canRetryView(result.view)).toBe(true);
    });
});

describe('play scope', () => {
    it('does not call play when the query scope changes before the segment returns', async () => {
        const issued = issuePlayTicket({ generation: 0, scope: '' }, 'rain');
        let gate = issued.gate;
        const segment = settleLater<{ kind: 'hit'; hit: SegmentDetailModel }>();
        const fetchItem = vi.fn(() => Promise.resolve({
            Id: ITEM_N,
            MediaSources: [{ Id: MEDIA }]
        } as ItemDto));
        const play = vi.fn(() => Promise.resolve());
        const pending = runScopedPlay({
            ticket: issued.ticket,
            readGate: () => gate,
            sessionMatches: () => true,
            clicked: hit(),
            signal: idleSignal(),
            fetchSegment: () => segment.promise,
            fetchItem,
            play
        });

        gate = retirePlayGate(gate, 'snow');
        segment.resolve({ kind: 'hit', hit: detail() });
        await expect(pending).resolves.toEqual({ ok: false, reason: 'interrupted' });
        expect(fetchItem).not.toHaveBeenCalled();
        expect(play).not.toHaveBeenCalled();
        expect(ticketStillCurrent(issued.ticket, gate, true)).toBe(false);
    });

    it('leaves playback running after it has started, and ignores the old callback', async () => {
        const issued = issuePlayTicket({ generation: 0, scope: '' }, 'rain');
        let gate = issued.gate;
        const playback = settleLater<void>();
        let started = false;
        let played: { startPositionTicks: number; mediaSourceId: string } | undefined;
        const play = vi.fn((options: { startPositionTicks: number; mediaSourceId: string }) => {
            started = true;
            played = options;
            return playback.promise;
        });
        const pending = runScopedPlay({
            ticket: issued.ticket,
            readGate: () => gate,
            sessionMatches: () => true,
            clicked: hit({ startTicks: 0, endTicks: 60_000_000 }),
            signal: idleSignal(),
            fetchSegment: () => Promise.resolve({
                kind: 'hit',
                hit: detail({ startTicks: 0, endTicks: 60_000_000 })
            }),
            fetchItem: () => Promise.resolve({
                Id: ITEM_N,
                MediaSources: [{ Id: MEDIA }]
            } as ItemDto),
            play
        });

        await vi.waitFor(() => {
            expect(started).toBe(true);
        });
        gate = retirePlayGate(gate, 'snow');
        playback.resolve(undefined);
        await expect(pending).resolves.toEqual({ ok: true });
        expect(play).toHaveBeenCalledTimes(1);
        expect(played).toMatchObject({
            startPositionTicks: 0,
            mediaSourceId: MEDIA
        });
        expect(ticketStillCurrent(issued.ticket, gate, true)).toBe(false);
    });

    it('drops a stale segment and clears the list when the index is incompatible', async () => {
        const view = readyView([
            hit(),
            hit({
                itemId: OTHER_ITEM,
                segmentId: OTHER_SEGMENT,
                score: 0.2
            })
        ]);
        const stale = await runScopedPlay({
            ticket: { generation: 1, scope: 'rain' },
            readGate: () => ({ generation: 1, scope: 'rain' }),
            sessionMatches: () => true,
            clicked: hit(),
            signal: idleSignal(),
            fetchSegment: () => Promise.resolve({ kind: 'gone', reason: 'stale' }),
            fetchItem: () => Promise.resolve(null),
            play: () => Promise.resolve()
        });
        const afterStale = applyPlayOutcome(view, hit(), stale);
        expect(afterStale.phase).toBe('ready');
        if (afterStale.phase !== 'ready') {
            return;
        }

        expect(afterStale.related.map(entry => entry.segmentId)).toEqual([OTHER_SEGMENT]);

        const denied = await runScopedPlay({
            ticket: { generation: 1, scope: 'rain' },
            readGate: () => ({ generation: 1, scope: 'rain' }),
            sessionMatches: () => true,
            clicked: hit({ itemId: OTHER_ITEM, segmentId: OTHER_SEGMENT }),
            signal: idleSignal(),
            fetchSegment: () => Promise.resolve({
                kind: 'hit',
                hit: detail({ itemId: OTHER_ITEM, segmentId: OTHER_SEGMENT })
            }),
            fetchItem: () => Promise.resolve(null),
            play: () => Promise.resolve()
        });
        const afterDenied = applyPlayOutcome(afterStale, hit({
            itemId: OTHER_ITEM,
            segmentId: OTHER_SEGMENT
        }), denied);
        expect(afterDenied.phase).toBe('ready');
        if (afterDenied.phase !== 'ready') {
            return;
        }

        expect(afterDenied.related).toEqual([]);
        expect(afterDenied.notices).toContain('results-hidden');

        const incompatible = await runScopedPlay({
            ticket: { generation: 1, scope: 'rain' },
            readGate: () => ({ generation: 1, scope: 'rain' }),
            sessionMatches: () => true,
            clicked: hit(),
            signal: idleSignal(),
            fetchSegment: () => Promise.resolve({ kind: 'gone', reason: 'incompatible' }),
            fetchItem: () => Promise.resolve(null),
            play: () => Promise.resolve()
        });
        expect(applyPlayOutcome(view, hit(), incompatible)).toEqual({
            phase: 'problem',
            problem: 'incompatible'
        });
        expect(canRetryView({ phase: 'problem', problem: 'incompatible' })).toBe(false);
        expect(canRetryView({ phase: 'problem', problem: 'timeout' })).toBe(true);
    });
});

describe('cached windows after access is withdrawn', () => {
    it('removes all windows of the item after a privacy-preserving 404', async () => {
        const anotherWindow = hit({
            itemId: ITEM_N,
            segmentId: 'abcdef01-2345-6789-abcd-ef0123456780',
            startTicks: 100_000_000,
            endTicks: 160_000_000,
            quality: 'weak'
        });
        const unaffected = hit({ itemId: OTHER_ITEM, segmentId: OTHER_SEGMENT });
        const view = readyView([hit(), unaffected, anotherWindow]);
        const play = vi.fn();
        const refusal = await runScopedPlay({
            ticket: { generation: 1, scope: 'rain' },
            readGate: () => ({ generation: 1, scope: 'rain' }),
            sessionMatches: () => true,
            clicked: hit(),
            signal: idleSignal(),
            fetchSegment: () => Promise.resolve(classifySegment(404, { error: { code: 'notFound' } })),
            fetchItem: () => Promise.resolve(null),
            play
        });
        const after = applyPlayOutcome(view, hit(), refusal);
        expect(play).not.toHaveBeenCalled();
        expect(after.phase).toBe('ready');
        if (after.phase === 'ready') {
            expect(after.related.map(entry => entry.itemId)).toEqual([OTHER_ITEM]);
            expect(after.weak).toEqual([]);
        }
    });
});

describe('retry scope', () => {
    it('changes request scope without changing the query text and resets the weak fold', () => {
        const base = {
            sessionEpoch: 1,
            userId: 'user-1',
            serverId: 'server-1',
            basePath: 'https://jellyfin.example',
            query: '雨夜',
            parentId: PARENT_N,
            retryNonce: 0
        };
        const again = searchScopeKey({ ...base, retryNonce: 1 });
        expect(searchScopeKey(base)).not.toBe(again);
        expect(again).toContain('雨夜');
        expect(again).toContain(PARENT_N);
        expect(weakDisclosure(true, searchScopeKey(base) !== again)).toBe(false);
    });
});
