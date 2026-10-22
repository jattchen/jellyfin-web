import { describe, expect, it } from 'vitest';

import { idleSignal } from './abort';
import { API_VERSION, SIMILAR_SEGMENTS_FEATURE, TICKS_PER_SECOND } from './constants';
import { parseSearchHit } from './parse';
import { runSegmentSearch } from './searchRun';
import {
    acceptSimilarResponse,
    classifySimilarHttp,
    classifySimilarTransport,
    focusAfterReturn,
    parseSimilarBody,
    queryChangeLeavesSimilar,
    referenceComparisonText,
    sameTitleMoment,
    similarNavigation,
    similarRequestBody,
    stageHitForPlayback
} from './similarSearch';
import { mergedRunText } from './presentation';
import { segmentCopy } from './copy';
import { searchScopeKey, sameSession } from './viewState';

const SECOND = TICKS_PER_SECOND;
const BINDING = '0123456789abcdef'.repeat(4);
const SOURCE_BINDING = 'fedcba9876543210'.repeat(4);
const ITEM = '01234567-89ab-cdef-0123-456789abcdef';
const ITEM_N = '0123456789abcdef0123456789abcdef';
const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SEGMENT = 'abcdef01-2345-6789-abcd-ef0123456789';
const SOURCE = 'abcdef01-2345-6789-abcd-ef0123456780';
const QUERY_ID = 'abcdef01-2345-6789-abcd-ef0123456701';

function hit(overrides: Record<string, unknown> = {}) {
    return {
        itemId: OTHER,
        mediaSourceId: 'source-b',
        segmentId: 'abcdef01-2345-6789-abcd-ef0123456792',
        startTicks: 90 * SECOND,
        endTicks: 102 * SECOND,
        indexComplete: true,
        quality: 'candidate',
        score: 0.82,
        rawScore: 0.82,
        representation: 'jointAudioVideo',
        candidateId: 'joint-90',
        bindingVersion: BINDING,
        run: { startTicks: 80 * SECOND, endTicks: 112 * SECOND, memberCount: 3 },
        similarAvailable: true,
        ...overrides
    };
}

function reference(overrides: Record<string, unknown> = {}) {
    return {
        segmentId: SEGMENT,
        itemId: ITEM,
        mediaSourceId: 'source-a',
        startTicks: 9 * SECOND,
        endTicks: 14 * SECOND,
        representation: 'transcriptText',
        bindingVersion: BINDING,
        source: {
            segmentId: SOURCE,
            startTicks: 10 * SECOND,
            endTicks: 22 * SECOND,
            representation: 'jointAudioVideo',
            bindingVersion: SOURCE_BINDING
        },
        excluded: { startTicks: 9 * SECOND, endTicks: 22 * SECOND },
        ...overrides
    };
}

function body(results: unknown[], scoreMeaning = 'documentCosine', ref: unknown = reference()) {
    return {
        apiVersion: API_VERSION,
        queryId: QUERY_ID,
        clientQueryId: 'similar-a',
        availability: { search: 'available' },
        indexComplete: true,
        qualityPolicy: { scoreMeaning },
        reference: ref,
        results
    };
}

describe('similar source mapping', () => {
    it('names the joint window used for a dialogue reference and not the dialogue ticks', () => {
        const parsed = parseSimilarBody(body([hit()]));
        expect(parsed?.reference.source).toMatchObject({
            segmentId: SOURCE,
            startTicks: 10 * SECOND,
            endTicks: 22 * SECOND,
            representation: 'jointAudioVideo'
        });
        const compared = parsed ? referenceComparisonText(parsed.reference, range => `按 ${range} 的画面与声音比较`) : undefined;
        expect(compared).toBe('按 0:10–0:22 的画面与声音比较');
        expect(compared).not.toContain('0:09–0:14');
        expect(parsed?.reference.startTicks).toBe(9 * SECOND);
    });

    it('hides the comparison sentence when the reference is already that joint window', () => {
        const joint = reference({
            segmentId: SOURCE,
            startTicks: 10 * SECOND,
            endTicks: 22 * SECOND,
            representation: 'jointAudioVideo',
            bindingVersion: SOURCE_BINDING,
            excluded: { startTicks: 10 * SECOND, endTicks: 22 * SECOND }
        });
        const parsed = parseSimilarBody(body([hit()], 'documentCosine', joint));
        expect(parsed && referenceComparisonText(parsed.reference, range => `按 ${range} 的画面与声音比较`)).toBeUndefined();
    });

    it('rejects a normal reference score, a non-joint source, and an excluded span that misses the union', () => {
        expect(parseSimilarBody(body([hit()], 'referenceTailR'))).toBeUndefined();
        expect(parseSimilarBody(body([hit()], 'cosine'))).toBeUndefined();
        const audioOnly = reference();
        (audioOnly.source as { representation: string }).representation = 'transcriptText';
        expect(parseSimilarBody(body([hit()], 'documentCosine', audioOnly))).toBeUndefined();
        const short = reference({ excluded: { startTicks: 10 * SECOND, endTicks: 14 * SECOND } });
        expect(parseSimilarBody(body([hit()], 'documentCosine', short))).toBeUndefined();
    });

    it('marks another moment in the reference film without showing the cosine', () => {
        const parsed = parseSimilarBody(body([hit({ itemId: ITEM_N, score: 0.91 })]));
        expect(sameTitleMoment(parsed?.hits[0]?.itemId ?? '', ITEM)).toBe(true);
        expect(sameTitleMoment(OTHER, ITEM)).toBe(false);
        const copy = segmentCopy('zh-CN');
        const note = mergedRunText(parsed?.hits[0] ?? {}, copy.merged);
        expect(note).toBe('已合并相连的 3 段 · 1:20–1:52');
        expect(note).not.toContain('0.91');
        expect(similarRequestBody({
            segmentId: SEGMENT,
            expectedBindingVersion: BINDING,
            parentId: '  ',
            clientQueryId: 'similar-a'
        })).toEqual({
            segmentId: SEGMENT,
            expectedBindingVersion: BINDING,
            limit: 3,
            groupByVideo: true,
            collapseRuns: true,
            clientQueryId: 'similar-a'
        });
    });
});

describe('similar cancellation and return', () => {
    const current = {
        requestId: 'similar-a',
        expectedId: 'similar-a',
        aborted: false,
        sessionMatches: true,
        requestedSegmentId: SEGMENT,
        responseSegmentId: SEGMENT
    };

    it('drops a late body after cancel, a new reference, or a sign-out', () => {
        expect(acceptSimilarResponse(current)).toBe(true);
        expect(acceptSimilarResponse({ ...current, aborted: true })).toBe(false);
        expect(acceptSimilarResponse({ ...current, expectedId: 'similar-b' })).toBe(false);
        expect(acceptSimilarResponse({
            ...current,
            responseSegmentId: SOURCE
        })).toBe(false);
        expect(acceptSimilarResponse({ ...current, sessionMatches: false })).toBe(false);
        expect(sameSession(
            { serverId: 's', userId: 'u', basePath: 'https://media.example', authorizationHeader: 'old' },
            { serverId: 's', userId: 'u', basePath: 'https://media.example', authorizationHeader: 'new' }
        )).toBe(false);
    });

    it('returns to the cached text view without calling a removed row back into focus', () => {
        expect(focusAfterReturn({ moreOpen: true, scrollY: 480, originSegmentId: SEGMENT }, [SEGMENT])).toEqual({
            moreOpen: true,
            scrollY: 480,
            focus: 'origin'
        });
        expect(focusAfterReturn({ moreOpen: true, scrollY: 480, originSegmentId: SEGMENT }, [OTHER])).toEqual({
            moreOpen: true,
            scrollY: 480,
            focus: 'title'
        });
        expect(similarNavigation(undefined, SEGMENT)).toBe('push');
        expect(similarNavigation(SEGMENT, SOURCE)).toBe('replace');
    });

    it('leaves similar when the submitted query changes and keeps text scope free of the similar id', () => {
        expect(queryChangeLeavesSimilar('雨夜', ' 雨夜 ')).toBe(false);
        expect(queryChangeLeavesSimilar('雨夜', '晚霞')).toBe(true);
        expect(searchScopeKey({
            sessionEpoch: 2,
            userId: 'user',
            serverId: 'server',
            basePath: 'https://media.example',
            query: '雨夜',
            parentId: ITEM,
            retryNonce: 0
        }).split('\n')).toEqual(['2', 'user', 'server', 'https://media.example', '雨夜', ITEM, '0']);
    });

    it('withdraws the film or media source and does not describe a retryable failure as empty', () => {
        expect(classifySimilarHttp(404, {})).toEqual({ kind: 'return', notice: 'gone', withdraw: 'item' });
        expect(classifySimilarHttp(401, {})).toEqual({ kind: 'return', notice: 'gone', withdraw: 'item' });
        expect(classifySimilarHttp(403, {})).toEqual({ kind: 'return', notice: 'gone', withdraw: 'item' });
        expect(classifySimilarHttp(409, { error: { code: 'stale' } })).toEqual({
            kind: 'return',
            notice: 'gone',
            withdraw: 'media'
        });
        expect(classifySimilarHttp(409, { error: { code: 'referenceUnavailable' } })).toEqual({
            kind: 'return',
            notice: 'unavailable',
            withdraw: 'none'
        });
        expect(classifySimilarTransport('timeout')).toEqual({ kind: 'stay', problem: 'timeout' });
        expect(classifySimilarTransport('network')).toEqual({ kind: 'stay', problem: 'transport' });
        expect(classifySimilarTransport('aborted')).toEqual({ kind: 'aborted' });
        expect(classifySimilarHttp(429, { error: { code: 'busy' } }).kind).not.toBe('empty');
    });

    it('keeps an already playing moment when the similar list is a different film', () => {
        const playing = { segmentId: SEGMENT, itemId: ITEM };
        const visible = [{ segmentId: SOURCE, itemId: OTHER }];
        expect(stageHitForPlayback(playing, visible)).toBe(playing);
        expect(stageHitForPlayback(undefined, visible)).toBe(visible[0]);
        const listed = stageHitForPlayback(playing, [playing, visible[0]]);
        expect(listed).toBe(playing);
    });
});

describe('similar availability on ordinary search', () => {
    it('ignores similarAvailable until the server declares the feature', () => {
        const raw = hit();
        expect(parseSearchHit(raw)?.similarAvailable).toBeUndefined();
        expect(parseSearchHit({ ...raw, similarAvailable: 'yes' })).toBeDefined();
        expect(parseSearchHit(raw, { expectRun: true, expectSimilar: true })?.similarAvailable).toBe(true);
        expect(parseSearchHit({ ...raw, similarAvailable: 'yes' }, { expectSimilar: true })).toBeUndefined();
        expect(parseSearchHit(hit({ similarAvailable: false }), { expectRun: true, expectSimilar: true })?.similarAvailable).toBe(false);
    });

    it('rejects a similar-capable search that omits similarAvailable and does not call similar', async () => {
        const calls: string[] = [];
        const result = await runSegmentSearch({
            request: (call) => {
                calls.push(call.path);
                if (call.method === 'GET') {
                    return Promise.resolve({
                        kind: 'response',
                        status: 200,
                        data: {
                            apiVersion: API_VERSION,
                            ticksPerSecond: TICKS_PER_SECOND,
                            availability: { search: 'available' },
                            coverage: { indexComplete: true },
                            qualityPolicy: { scoreMeaning: 'referenceTailR' },
                            features: ['grouped-video-v1', SIMILAR_SEGMENTS_FEATURE]
                        }
                    });
                }

                return Promise.resolve({
                    kind: 'response',
                    status: 200,
                    data: {
                        apiVersion: API_VERSION,
                        queryId: QUERY_ID,
                        clientQueryId: 'query-a',
                        availability: { search: 'available' },
                        indexComplete: true,
                        results: [hit({ similarAvailable: undefined, run: undefined })]
                    }
                });
            }
        }, { query: '雨夜', clientQueryId: 'query-a', signal: idleSignal() });
        expect(result).toEqual({ kind: 'problem', problem: 'contract' });
        expect(calls.some(path => path.endsWith('/similar'))).toBe(false);
    });
});
