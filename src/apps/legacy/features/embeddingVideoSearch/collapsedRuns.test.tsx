import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { idleSignal } from './abort';
import { API_VERSION, COLLAPSED_RUNS_FEATURE, TICKS_PER_SECOND } from './constants';
import { segmentCopy } from './copy';
import MomentRow from './MomentRow';
import MomentTimeline from './MomentTimeline';
import { parseCapabilities, parseCollapsedRun, parseSearchBody, parseSearchHit } from './parse';
import { collapsedRunBand, mergedRunText, rankHits, toDisplayHit } from './presentation';
import { runSegmentSearch, searchBody } from './searchRun';
import type { RankedHit, SearchHitModel } from './types';

const BINDING = '0123456789abcdef'.repeat(4);
const ITEM = '01234567-89ab-cdef-0123-456789abcdef';
const SEGMENT = 'abcdef01-2345-6789-abcd-ef0123456789';
const QUERY_ID = 'abcdef01-2345-6789-abcd-ef0123456701';
const SECOND = TICKS_PER_SECOND;

function capabilities(features: string[], scoreMeaning = 'referenceTailR') {
    return {
        apiVersion: API_VERSION,
        ticksPerSecond: TICKS_PER_SECOND,
        availability: { search: 'available' },
        coverage: { indexComplete: true },
        qualityPolicy: { scoreMeaning },
        features
    };
}

function hitBody(overrides: Record<string, unknown> = {}) {
    return {
        itemId: ITEM,
        mediaSourceId: 'source-a',
        segmentId: SEGMENT,
        startTicks: 10 * SECOND,
        endTicks: 22 * SECOND,
        indexComplete: true,
        quality: 'candidate',
        score: 1.4,
        rawScore: 0.4,
        representation: 'jointAudioVideo',
        candidateId: 'joint-10',
        bindingVersion: BINDING,
        ...overrides
    };
}

function searchPayload(results: unknown[]) {
    return {
        apiVersion: API_VERSION,
        queryId: QUERY_ID,
        clientQueryId: 'query-a',
        availability: { search: 'available' },
        indexComplete: true,
        results
    };
}

function noop() {
    return undefined;
}

function ranked(run?: RankedHit['run']): RankedHit {
    return {
        segmentId: SEGMENT,
        itemId: ITEM,
        range: '0:10–0:22',
        partial: false,
        startTicks: 10 * SECOND,
        endTicks: 22 * SECOND,
        score: 1.4,
        rank: 2,
        representation: 'jointAudioVideo',
        run
    };
}

describe('collapsed run field', () => {
    const wrapped = { startTicks: 0, endTicks: 42 * SECOND, memberCount: 4 };

    it('accepts a run that wraps the representative and keeps that representative time', () => {
        const parsed = parseSearchHit(hitBody({ run: wrapped }), { expectRun: true });
        expect(parsed?.run).toEqual(wrapped);
        expect(parsed?.startTicks).toBe(10 * SECOND);
        expect(parsed?.endTicks).toBe(22 * SECOND);
        const shown = parsed ? toDisplayHit(parsed) : undefined;
        expect(shown?.range).toBe('0:10–0:22');
        expect(mergedRunText(shown ?? {}, segmentCopy('zh-CN').merged)).toBe('已合并相连的 4 段 · 0:00–0:42');
        expect(mergedRunText(shown ?? {}, segmentCopy('en').merged)).toBe('Merged 4 connected moments · 0:00–0:42');
    });

    it('rejects a run that starts late, ends early, or has no members', () => {
        expect(parseCollapsedRun({ startTicks: 11 * SECOND, endTicks: 42 * SECOND, memberCount: 4 }, 10 * SECOND, 22 * SECOND)).toBeUndefined();
        expect(parseCollapsedRun({ startTicks: 0, endTicks: 20 * SECOND, memberCount: 4 }, 10 * SECOND, 22 * SECOND)).toBeUndefined();
        expect(parseCollapsedRun({ startTicks: 0, endTicks: 42 * SECOND, memberCount: 0 }, 10 * SECOND, 22 * SECOND)).toBeUndefined();
        expect(parseCollapsedRun({ startTicks: 0, endTicks: 42 * SECOND, memberCount: 1.5 }, 10 * SECOND, 22 * SECOND)).toBeUndefined();
        expect(parseCollapsedRun({ startTicks: -1, endTicks: 42 * SECOND, memberCount: 2 }, 10 * SECOND, 22 * SECOND)).toBeUndefined();
        expect(parseSearchHit(hitBody(), { expectRun: true })).toBeUndefined();
        expect(parseSearchBody(searchPayload([hitBody({ run: { startTicks: '0', endTicks: 42 * SECOND, memberCount: 4 } })]), {
            expectRun: true
        })).toBeUndefined();
    });

    it('does not invent a merge caption when the server says the run has one member', () => {
        const wider = { startTicks: 0, endTicks: 42 * SECOND, memberCount: 1 };
        const parsed = parseSearchHit(hitBody({ run: wider }), { expectRun: true });
        expect(parsed?.run).toEqual(wider);
        expect(mergedRunText(parsed ?? {}, segmentCopy('zh-CN').merged)).toBeUndefined();
        const band = collapsedRunBand({ run: wider }, 120 * SECOND);
        expect(band).toBeUndefined();
    });

    it('draws the faint bed across the whole run and leaves the representative band on its own span', () => {
        const duration = 120 * SECOND;
        const bed = collapsedRunBand({ run: { startTicks: 0, endTicks: 42 * SECOND, memberCount: 4 } }, duration);
        expect(bed).toEqual({ left: 0, width: 42 / 120 });
        expect(bed && bed.left + bed.width).toBeGreaterThan((22 * SECOND) / duration);
    });

    it('does not merge touching hits itself when the server returned them separately', () => {
        const first: SearchHitModel = {
            ...parseSearchHit(hitBody())!,
            startTicks: 0,
            endTicks: 12 * SECOND
        };
        const second: SearchHitModel = {
            ...parseSearchHit(hitBody({
                segmentId: 'abcdef01-2345-6789-abcd-ef0123456788',
                candidateId: 'joint-12',
                score: 0.2
            }))!,
            startTicks: 12 * SECOND,
            endTicks: 24 * SECOND
        };
        expect(rankHits([toDisplayHit(first), toDisplayHit(second)])).toHaveLength(2);
    });
});

describe('collapsed run capability', () => {
    it('keeps the old reference score and omits collapseRuns when the feature is absent', async () => {
        const calls: { method: string; body?: unknown }[] = [];
        const result = await runSegmentSearch({
            request: (call) => {
                calls.push({ method: call.method, body: call.body });
                if (call.method === 'GET') {
                    return Promise.resolve({
                        kind: 'response',
                        status: 200,
                        data: capabilities(['grouped-video-v1'])
                    });
                }

                return Promise.resolve({
                    kind: 'response',
                    status: 200,
                    data: searchPayload([hitBody({ run: { startTicks: 50 * SECOND, endTicks: 40 * SECOND, memberCount: 0 } })])
                });
            }
        }, { query: '雨夜', clientQueryId: 'query-a', signal: idleSignal() });

        expect(parseCapabilities(capabilities(['grouped-video-v1']))?.collapsedRuns).toBe(false);
        expect(calls[1]?.body).not.toHaveProperty('collapseRuns');
        expect(result.kind).toBe('ready');
        if (result.kind === 'ready') {
            expect(result.view.collapsedRuns).toBe(false);
            expect(result.view.related[0]?.run).toBeUndefined();
            expect(result.view.related[0]?.startTicks).toBe(10 * SECOND);
        }
    });

    it('asks for collapseRuns only with the feature, and rejects a hit that has no run', async () => {
        expect(searchBody({
            query: '雨夜',
            clientQueryId: 'query-a',
            signal: idleSignal(),
            collapseRuns: true
        }).collapseRuns).toBe(true);
        const calls: unknown[] = [];
        const result = await runSegmentSearch({
            request: (call) => {
                calls.push(call.body);
                if (call.method === 'GET') {
                    return Promise.resolve({
                        kind: 'response',
                        status: 200,
                        data: capabilities(['grouped-video-v1', COLLAPSED_RUNS_FEATURE])
                    });
                }

                return Promise.resolve({
                    kind: 'response',
                    status: 200,
                    data: searchPayload([hitBody()])
                });
            }
        }, { query: '雨夜', clientQueryId: 'query-a', signal: idleSignal() });

        expect(calls[1]).toMatchObject({ collapseRuns: true, groupByVideo: true, limit: 3 });
        expect(result).toEqual({ kind: 'problem', problem: 'contract' });
    });

    it('keeps the representative when the server run is valid', async () => {
        const result = await runSegmentSearch({
            request: (call) => {
                if (call.method === 'GET') {
                    return Promise.resolve({
                        kind: 'response',
                        status: 200,
                        data: capabilities(['grouped-video-v1', COLLAPSED_RUNS_FEATURE])
                    });
                }

                return Promise.resolve({
                    kind: 'response',
                    status: 200,
                    data: searchPayload([hitBody({
                        run: { startTicks: 0, endTicks: 42 * SECOND, memberCount: 4 }
                    })])
                });
            }
        }, { query: '雨夜', clientQueryId: 'query-a', signal: idleSignal() });

        expect(result.kind).toBe('ready');
        if (result.kind !== 'ready') {
            return;
        }

        expect(result.view.collapsedRuns).toBe(true);
        expect(result.view.related).toHaveLength(1);
        expect(result.view.related[0]?.startTicks).toBe(10 * SECOND);
        expect(result.view.related[0]?.run).toEqual({ startTicks: 0, endTicks: 42 * SECOND, memberCount: 4 });
    });

    it('still rejects cosine and documentCosine capabilities before any search', async () => {
        for (const scoreMeaning of ['cosine', 'documentCosine']) {
            const methods: string[] = [];
            const result = await runSegmentSearch({
                request: (call) => {
                    methods.push(call.method);
                    return Promise.resolve({
                        kind: 'response',
                        status: 200,
                        data: capabilities(['grouped-video-v1', COLLAPSED_RUNS_FEATURE], scoreMeaning)
                    });
                }
            }, { query: '雨夜', clientQueryId: 'query-a', signal: idleSignal() });
            expect(result).toEqual({ kind: 'problem', problem: 'contract' });
            expect(methods).toEqual(['GET']);
        }
    });

    it('still requires grouped-video even when collapsed runs are advertised', () => {
        expect(parseCapabilities(capabilities([COLLAPSED_RUNS_FEATURE]))).toBeUndefined();
    });
});

describe('collapsed run display', () => {
    const copy = segmentCopy('zh-CN');

    it('appends the merged range on the row and a faint bed on the timeline', () => {
        const run = { startTicks: 0, endTicks: 42 * SECOND, memberCount: 4 };
        const row = renderToStaticMarkup(
            <MomentRow
                hit={ranked(run)}
                title='样片'
                tag='S1:E2'
                current={false}
                busy={false}
                copy={copy}
                onPlay={noop}
                onPreview={noop}
            />
        );
        expect(row).toContain('0:10–0:22');
        expect(row).toContain('已合并相连的 4 段 · 0:00–0:42');
        expect(row).toContain('evsRunNote');
        expect(row.match(/<button/g)).toHaveLength(1);

        const timeline = renderToStaticMarkup(
            <MomentTimeline
                title='样片'
                hits={[ranked(run)]}
                durationTicks={120 * SECOND}
                thumbs={new Map()}
                copy={copy}
                onPlay={noop}
                onPreview={noop}
            />
        );
        expect(timeline).toContain('evsRunBand');
        expect(timeline).toContain('left:0%');
        expect(timeline).toContain('>2<');
    });

    it('leaves a one-member run visually identical to an old row', () => {
        const row = renderToStaticMarkup(
            <MomentRow
                hit={ranked({ startTicks: 0, endTicks: 42 * SECOND, memberCount: 1 })}
                title='样片'
                tag='S1:E2'
                current={false}
                busy={false}
                copy={copy}
                onPlay={noop}
                onPreview={noop}
            />
        );
        expect(row).not.toContain('已合并');
        expect(row).not.toContain('evsRunNote');
        const timeline = renderToStaticMarkup(
            <MomentTimeline
                title='样片'
                hits={[ranked()]}
                durationTicks={120 * SECOND}
                thumbs={new Map()}
                copy={copy}
                onPlay={noop}
                onPreview={noop}
            />
        );
        expect(timeline).not.toContain('evsRunBand');
    });
});
