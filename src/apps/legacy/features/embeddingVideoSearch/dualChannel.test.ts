import { describe, expect, it } from 'vitest';

import { idleSignal } from './abort';
import { parseSearchHit } from './parse';
import { confirmedHit, nativePlayRequest } from './playback';
import { partitionHits } from './presentation';
import { runSegmentSearch } from './searchRun';
import type { SearchHitModel } from './types';

const candidate: SearchHitModel = {
    itemId: '01234567-89ab-cdef-0123-456789abcdef',
    mediaSourceId: 'sample-source',
    segmentId: 'abcdef01-2345-6789-abcd-ef0123456789',
    startTicks: 20_000_000,
    endTicks: 50_000_000,
    indexComplete: true,
    quality: 'candidate',
    score: 2.17,
    rawScore: 0.63,
    representation: 'transcriptText',
    candidateId: 'text-preserved-id',
    bindingVersion: '0123456789abcdef'.repeat(4)
};

describe('independent joint and transcript candidates', () => {
    it('rejects the old cosine plugin before sending any query', async () => {
        const methods: string[] = [];
        const result = await runSegmentSearch({ request: call => {
            methods.push(call.method);
            return Promise.resolve({ kind: 'response', status: 200, data: {
                apiVersion: '1', ticksPerSecond: 10_000_000,
                availability: { search: 'available' }, coverage: { indexComplete: true },
                qualityPolicy: { scoreMeaning: 'cosine' }
            } });
        } }, { query: 'frozen', clientQueryId: 'one', signal: idleSignal() });
        expect(result).toEqual({ kind: 'problem', problem: 'contract' });
        expect(methods).toEqual(['GET']);
    });

    it('preserves reference score above one, raw cosine, source and local range', () => {
        expect(parseSearchHit(candidate)).toEqual(candidate);
        expect(parseSearchHit({ ...candidate, representation: 'audioOnly' })).toBeUndefined();
        expect(parseSearchHit({ ...candidate, rawScore: NaN })).toBeUndefined();
        expect(parseSearchHit({ ...candidate, score: -1 })).toBeUndefined();
        expect(parseSearchHit({ ...candidate, candidateId: '' })).toBeUndefined();
    });

    it('keeps partially overlapping candidates in server order without thresholding R', () => {
        const overlapping = { ...candidate, segmentId: 'abcdef01-2345-6789-abcd-ef0123456788',
            startTicks: 40_000_000, endTicks: 100_000_000, score: 0.01,
            representation: 'jointAudioVideo' as const, candidateId: 'joint-id' };
        expect(partitionHits([candidate, overlapping])).toEqual({ related: [candidate, overlapping], weak: [] });
    });

    it('refuses a changed representation or candidate even when playback time still matches', () => {
        expect(confirmedHit(candidate, { ...candidate, score: 0 })).toEqual(candidate);
        expect(confirmedHit(candidate, { ...candidate, representation: 'jointAudioVideo', score: 0 })).toBeUndefined();
        expect(confirmedHit(candidate, { ...candidate, candidateId: 'replacement', score: 0 })).toBeUndefined();
        expect(nativePlayRequest({ Id: candidate.itemId }, candidate)).toEqual({
            items: [{ Id: candidate.itemId }], mediaSourceId: 'sample-source', startPositionTicks: 20_000_000
        });
    });
});
