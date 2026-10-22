import { describe, expect, it, vi } from 'vitest';

import { episodeCode, filmTag, foldRanked, hitsForFilm, layoutTimeline, rankHits } from './presentation';
import { createThumbnailQueue } from './thumbnailQueue';
import type { PreviewFetch } from './previewFetch';
import type { DisplayHit, ThumbState } from './types';

const FILM_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const FILM_B = 'bbbbbbbb-0000-4000-8000-000000000002';

function hit(n: number, itemId: string, score: number): DisplayHit {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    return {
        segmentId: id,
        itemId,
        range: `0:${n}`,
        partial: false,
        startTicks: n * 10_000_000,
        endTicks: (n + 10) * 10_000_000,
        score,
        representation: 'transcriptText'
    };
}

describe('unified ranking', () => {
    it('ranks across films by reference score, keeping server order on ties', () => {
        const server = [hit(1, FILM_A, 2.1), hit(2, FILM_A, 1.7), hit(3, FILM_B, 2.9), hit(4, FILM_B, 1.7)];
        const ranked = rankHits(server);
        expect(ranked.map(h => h.segmentId)).toEqual([server[2], server[0], server[1], server[3]].map(h => h.segmentId));
        expect(ranked.map(h => h.rank)).toEqual([1, 2, 3, 4]);
    });

    it('does not change scores or times, and keeps weak hits after related ones', () => {
        const strongWeak = hit(9, FILM_B, 9);
        const ranked = rankHits([hit(1, FILM_A, 0.5)], [strongWeak]);
        expect(ranked[1].segmentId).toBe(strongWeak.segmentId);
        expect(ranked[1].score).toBe(9);
        expect(ranked[1].startTicks).toBe(strongWeak.startTicks);
    });

    it('drops a duplicated segment instead of listing it twice', () => {
        const a = hit(1, FILM_A, 1);
        expect(rankHits([a, { ...a, score: 3 }])).toHaveLength(1);
    });
});

describe('folding by position', () => {
    it('shows the first five and folds the rest regardless of score', () => {
        const ranked = rankHits(Array.from({ length: 15 }, (_, i) => hit(i + 1, i % 2 ? FILM_A : FILM_B, 0.01 * i)));
        const { shown, folded } = foldRanked(ranked);
        expect(shown).toHaveLength(5);
        expect(folded).toHaveLength(10);
        expect(folded[0].rank).toBe(6);
    });

    it('never hides everything', () => {
        expect(foldRanked([1, 2], 0).shown).toEqual([1]);
    });
});

describe('film labels', () => {
    it('uses the episode code and adds the series only when results span series', () => {
        expect(episodeCode({ ParentIndexNumber: 1, IndexNumber: 2 })).toBe('S1:E2');
        expect(episodeCode({ IndexNumber: 3 })).toBe('E3');
        expect(episodeCode({ Name: 'Film' })).toBeUndefined();
        const card = { title: 'Show — 1.2 Name', series: 'Show', episodeCode: 'S1:E2' };
        expect(filmTag(card, false, 'Video')).toBe('S1:E2');
        expect(filmTag(card, true, 'Video')).toBe('Show S1:E2');
        expect(filmTag({ title: 'Movie' }, true, 'Video')).toBe('Movie');
        expect(filmTag(undefined, false, 'Video')).toBe('Video');
    });

    it('selects the stage film hits by GUID key in rank order', () => {
        const ranked = rankHits([hit(1, FILM_A, 3), hit(2, FILM_B, 2), hit(3, FILM_A, 1)]);
        expect(hitsForFilm(ranked, FILM_A.replace(/-/g, '').toUpperCase()).map(h => h.rank)).toEqual([1, 3]);
        expect(hitsForFilm(ranked, undefined)).toEqual([]);
    });
});

describe('timeline layout', () => {
    it('keeps far-apart marks on one lane and stacks colliding ones', () => {
        const duration = 1000 * 10_000_000;
        const marks = [
            { startTicks: 100 * 10_000_000, endTicks: 110 * 10_000_000 },
            { startTicks: 105 * 10_000_000, endTicks: 115 * 10_000_000 },
            { startTicks: 800 * 10_000_000, endTicks: 810 * 10_000_000 }
        ];
        const layout = layoutTimeline(marks, duration, 0.004, 0.05);
        expect(layout.lanes).toBe(2);
        expect(layout.marks.map(m => m.lane)).toEqual([0, 1, 0]);
    });

    it('skips marks outside the known runtime', () => {
        const layout = layoutTimeline([{ startTicks: 50, endTicks: 60 }], 40);
        expect(layout.marks).toHaveLength(0);
        expect(layout.lanes).toBe(1);
    });
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('position frame queue', () => {
    function setup(responses: Record<string, PreviewFetch[]>, stillCurrent = () => true) {
        const calls: string[] = [];
        const states = new Map<string, ThumbState[]>();
        const revoked: string[] = [];
        const pending = new Map<string, ReturnType<typeof deferred<PreviewFetch>>>();
        const queue = createThumbnailQueue({
            fetch: (job) => {
                calls.push(job.segmentId);
                const next = responses[job.segmentId]?.shift();
                if (next) return Promise.resolve(next);
                const d = deferred<PreviewFetch>();
                pending.set(job.segmentId, d);
                return d.promise;
            },
            onChange: (id, state) => states.set(id, [...(states.get(id) ?? []), state]),
            stillCurrent,
            createUrl: () => `blob:${calls.length}`,
            revokeUrl: url => revoked.push(url),
            wait: () => Promise.resolve(),
            maxBusyRetries: 2
        });
        return { queue, calls, states, revoked, pending };
    }

    const image = (): PreviewFetch => ({ kind: 'image', blob: new Blob(['x'], { type: 'image/jpeg' }) });

    it('loads one frame at a time in rank order', async () => {
        const { queue, calls, pending } = setup({});
        queue.enqueue([{ segmentId: 'a', bindingVersion: 'v' }, { segmentId: 'b', bindingVersion: 'v' }]);
        await flush();
        expect(calls).toEqual(['a']);
        pending.get('a')?.resolve(image());
        await flush();
        expect(calls).toEqual(['a', 'b']);
    });

    it('moves a hovered moment to the front of the queue', async () => {
        const { queue, calls, pending } = setup({});
        queue.enqueue(['a', 'b', 'c'].map(segmentId => ({ segmentId, bindingVersion: 'v' })));
        queue.prioritize('c');
        await flush();
        pending.get('a')?.resolve(image());
        await flush();
        expect(calls).toEqual(['a', 'c']);
    });

    it('retries a busy answer, then gives up as busy', async () => {
        const busy: PreviewFetch = { kind: 'busy' };
        const { queue, calls, states } = setup({ a: [busy, busy, busy] });
        queue.enqueue([{ segmentId: 'a', bindingVersion: 'v' }]);
        await flush();
        await flush();
        expect(calls).toEqual(['a', 'a', 'a']);
        expect(states.get('a')?.at(-1)).toEqual({ status: 'busy' });
    });

    it('does not request a frame without a binding stamp', async () => {
        const { queue, calls, states } = setup({});
        queue.enqueue([{ segmentId: 'a' }]);
        await flush();
        expect(calls).toEqual([]);
        expect(states.get('a')?.at(-1)).toEqual({ status: 'failed' });
    });

    it('drops a late frame after the login changes and revokes every URL on dispose', async () => {
        let current = true;
        const { queue, states, revoked, pending } = setup({ a: [image()] }, () => current);
        queue.enqueue([{ segmentId: 'a', bindingVersion: 'v' }, { segmentId: 'b', bindingVersion: 'v' }]);
        await flush();
        expect(states.get('a')?.at(-1)?.status).toBe('image');
        current = false;
        pending.get('b')?.resolve(image());
        await flush();
        expect(states.get('b')?.at(-1)?.status).toBe('loading');
        queue.dispose();
        expect(revoked).toHaveLength(1);
    });

    it('stops publishing after dispose', async () => {
        const onChange = vi.fn();
        const d = deferred<PreviewFetch>();
        const queue = createThumbnailQueue({
            fetch: () => d.promise,
            onChange,
            stillCurrent: () => true,
            createUrl: () => 'blob:1',
            revokeUrl: () => undefined
        });
        queue.enqueue([{ segmentId: 'a', bindingVersion: 'v' }]);
        await flush();
        queue.dispose();
        onChange.mockClear();
        d.resolve(image());
        await flush();
        expect(onChange).not.toHaveBeenCalled();
    });
});
