import { describe, expect, it, vi } from 'vitest';

import { idleSignal } from './abort';
import { bindingAgrees } from './binding';
import { PLAYBACK_PREFIX, TICKS_PER_SECOND, previewPath } from './constants';
import { segmentCopy } from './copy';
import { attachPluginHls, type HlsLike } from './playbackAttach';
import {
    authorizePlaybackXhr,
    continueSameFilm,
    isNakedStaticStream,
    openPlaybackSession,
    readPlayback,
    seekSeconds
} from './playbackContract';
import { playConfirmedSegment } from './playback';
import { formatTicks, groupHitsByVideo, playheadRatio } from './presentation';
import { classifyPreview, keepPreview } from './previewFetch';
import { runSegmentSearch } from './searchRun';
import { enterCommitsSearch, isUnsubmitted } from './submitQuery';
import type { SearchHitModel } from './types';
import { urlOmitsCredentials } from './urlSafety';

const BINDING = '0123456789abcdef'.repeat(4);
const OTHER_BINDING = 'fedcba9876543210'.repeat(4);
const ITEM_A = '01234567-89ab-cdef-0123-456789abcdef';
const ITEM_B = '11111111-2222-3333-4444-555555555555';
const ITEM_C = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ITEM_D = 'abcdef01-2345-6789-abcd-ef0123456789';
const TOKEN = 'MediaBrowser Client="Jellyfin Web", Token="secret-token"';

function filmHit(itemId: string, segmentId: string, score: number): SearchHitModel {
    return {
        itemId,
        mediaSourceId: 'source-a',
        segmentId,
        startTicks: 296 * TICKS_PER_SECOND,
        endTicks: 320 * TICKS_PER_SECOND,
        indexComplete: false,
        quality: 'candidate',
        score,
        rawScore: 0.2,
        representation: 'jointAudioVideo',
        candidateId: segmentId,
        bindingVersion: BINDING
    };
}

describe('explicit description submit', () => {
    it('commits on enter and ignores an in-progress Chinese composition', () => {
        expect(enterCommitsSearch({ key: 'Enter', isComposing: false })).toBe(true);
        expect(enterCommitsSearch({ key: 'Enter', isComposing: true })).toBe(false);
        expect(enterCommitsSearch({ key: 'Enter', isComposing: false, keyCode: 229 })).toBe(false);
        expect(enterCommitsSearch({ key: 'a', isComposing: false })).toBe(false);
        expect(isUnsubmitted('窗边晚霞啊', '窗边晚霞')).toBe(true);
        expect(isUnsubmitted('窗边晚霞', '窗边晚霞')).toBe(false);
        expect(isUnsubmitted('窗边晚霞', '')).toBe(false);
    });
});

describe('absolute times and indexed range', () => {
    it('shows S1 at 4:56 and D2 at 9:26 instead of a local zero', () => {
        expect(formatTicks(296 * TICKS_PER_SECOND)).toBe('4:56');
        expect(formatTicks(566 * TICKS_PER_SECOND)).toBe('9:26');
        expect(seekSeconds(296 * TICKS_PER_SECOND)).toBe(296);
        expect(playheadRatio(400 * TICKS_PER_SECOND, 1000 * TICKS_PER_SECOND)).toBe(0.4);
        expect(formatTicks(302 * TICKS_PER_SECOND)).toBe('5:02');
        const copy = segmentCopy('zh-CN');
        expect(copy.partialItem).toBe('仅部分内容可搜索');
        expect(copy.notice('partial-index')).toBe('仅搜索已建立索引的范围，其他位置暂不可搜索。');
        expect(copy.notice('partial-index')).not.toMatch(/处理中|完成率|还没完成/);
    });
});

describe('grouping by film', () => {
    it('keeps server film order and does not promote the film with more hits', () => {
        const sparse = filmHit(ITEM_A, 'abcdef01-2345-6789-abcd-ef0123456781', 0.1);
        const crowded = [0, 1, 2, 3, 4].map(index => filmHit(
            ITEM_B,
            `abcdef01-2345-6789-abcd-ef012345679${index}`,
            9
        ));
        const groups = groupHitsByVideo([sparse, ...crowded]);
        expect(groups.map(group => group.itemId)).toEqual([ITEM_A, ITEM_B]);
        expect(groups[0]?.hits).toHaveLength(1);
        expect(groups[1]?.hits).toHaveLength(5);
    });

    it('drops a sixth hit and a fourth film without making a new group per hit', () => {
        const oneFilm = [0, 1, 2, 3, 4, 5].map(index => filmHit(
            ITEM_A,
            `abcdef01-2345-6789-abcd-ef012345678${index}`,
            index
        ));
        expect(groupHitsByVideo(oneFilm)).toHaveLength(1);
        expect(groupHitsByVideo(oneFilm)[0]?.hits).toHaveLength(5);
        const films = [ITEM_A, ITEM_B, ITEM_C, ITEM_D].map((itemId, index) => filmHit(
            itemId,
            `abcdef01-2345-6789-abcd-ef01234567${index}0`,
            index
        ));
        expect(groupHitsByVideo(films).map(group => group.itemId)).toEqual([ITEM_A, ITEM_B, ITEM_C]);
    });
});

describe('binding stamp', () => {
    const hit = filmHit(ITEM_A, 'abcdef01-2345-6789-abcd-ef0123456781', 1);

    it('refuses playback when the fresh detail stamp is missing or different', async () => {
        const play = vi.fn();
        const missing = await playConfirmedSegment({
            clicked: hit,
            signal: idleSignal(),
            stillCurrent: () => true,
            fetchSegment: () => Promise.resolve({ kind: 'hit', hit: { ...hit, bindingVersion: undefined } }),
            fetchItem: () => Promise.resolve({ Id: ITEM_A, MediaSources: [{ Id: 'source-a' }] }),
            play
        });
        const changed = await playConfirmedSegment({
            clicked: hit,
            signal: idleSignal(),
            stillCurrent: () => true,
            fetchSegment: () => Promise.resolve({ kind: 'hit', hit: { ...hit, bindingVersion: OTHER_BINDING } }),
            fetchItem: () => Promise.resolve({ Id: ITEM_A, MediaSources: [{ Id: 'source-a' }] }),
            play
        });
        expect(missing).toEqual({ ok: false, reason: 'binding' });
        expect(changed).toEqual({ ok: false, reason: 'binding' });
        expect(play).not.toHaveBeenCalled();
        expect(bindingAgrees(BINDING, BINDING.toUpperCase())).toBe(true);
    });

    it('posts the hit stamp and rejects a playback response with another stamp', async () => {
        const calls: { body?: unknown }[] = [];
        const removed: string[] = [];
        const opened = await openPlaybackSession({
            transport: { request: (call) => {
                calls.push(call);
                return Promise.resolve({
                    kind: 'response',
                    status: 200,
                    data: {
                        playbackId: 'play-1',
                        manifestUrl: `${PLAYBACK_PREFIX}play-1/index.m3u8`,
                        itemId: ITEM_A,
                        mediaSourceId: 'source-a',
                        startTicks: hit.startTicks,
                        durationTicks: 3600 * TICKS_PER_SECOND,
                        timelineOriginTicks: 0,
                        bindingVersion: OTHER_BINDING
                    }
                });
            } },
            getUri: path => `https://jellyfin.example${path}`,
            authorization: TOKEN,
            hit,
            signal: idleSignal(),
            deleteSession: session => {
                removed.push(session.deleteUrl);
                return Promise.resolve();
            }
        });
        expect(calls[0]?.body).toEqual({
            segmentId: hit.segmentId,
            expectedBindingVersion: BINDING
        });
        expect(opened.kind).toBe('incompatible');
        expect(removed[0]).toContain('/playback/play-1');
        expect(removed[0]).not.toContain('secret-token');
        expect(readPlayback({
            playbackId: 'play-1',
            manifestUrl: `${PLAYBACK_PREFIX}play-1/index.m3u8`,
            itemId: ITEM_A,
            mediaSourceId: 'source-a',
            startTicks: hit.startTicks,
            durationTicks: 3600 * TICKS_PER_SECOND,
            timelineOriginTicks: 0
        }, hit, TOKEN).ok).toBe(false);
    });

    it('does not post when the hit has no stamp', async () => {
        const request = vi.fn();
        const opened = await openPlaybackSession({
            transport: { request },
            getUri: path => `https://jellyfin.example${path}`,
            authorization: TOKEN,
            hit: { ...hit, bindingVersion: undefined },
            signal: idleSignal()
        });
        expect(opened.kind).toBe('incompatible');
        expect(request).not.toHaveBeenCalled();
    });

    it('treats a stale 409 as a version mismatch and does not open media', async () => {
        const request = vi.fn(() => Promise.resolve({
            kind: 'response' as const,
            status: 409,
            data: { error: { code: 'stale' } }
        }));
        const opened = await openPlaybackSession({
            transport: { request },
            getUri: path => `https://jellyfin.example${path}`,
            authorization: TOKEN,
            hit,
            signal: idleSignal()
        });
        expect(opened.kind).toBe('incompatible');
        expect(request).toHaveBeenCalledOnce();
    });

    it('puts the stamp on preview without treating it as a login secret', () => {
        const url = `https://jellyfin.example${previewPath(hit.segmentId, BINDING)}`;
        expect(url).toContain(`expectedBindingVersion=${BINDING}`);
        expect(urlOmitsCredentials(url)).toBe(true);
        expect(url).not.toContain('secret-token');
        expect(classifyPreview(404, undefined).kind).toBe('none');
        expect(classifyPreview(401, undefined).kind).toBe('failed');
        expect(classifyPreview(409, new Blob(['old'])).kind).toBe('failed');
        expect(classifyPreview(429, undefined).kind).toBe('busy');
    });

    it('seeks inside the same film only when the authorization snapshot still matches', () => {
        const active = { itemId: ITEM_A, mediaSourceId: 'source-a', authorization: TOKEN };
        expect(continueSameFilm(active, hit, TOKEN)).toBe(true);
        expect(continueSameFilm(active, hit, 'MediaBrowser Token="other"')).toBe(false);
        expect(continueSameFilm(active, { ...hit, mediaSourceId: 'other-source' }, TOKEN)).toBe(false);
    });
});

describe('page media guard', () => {
    const prefix = `https://jellyfin.example${PLAYBACK_PREFIX}`;

    it('blocks a naked static film url and a changed authorization header', () => {
        const naked = 'https://jellyfin.example/Videos/abc/stream.mp4?static=true';
        expect(isNakedStaticStream(naked)).toBe(true);
        expect(authorizePlaybackXhr({
            prefix,
            authorization: TOKEN,
            currentAuthorization: TOKEN,
            url: naked
        })).toBe(false);
        expect(authorizePlaybackXhr({
            prefix,
            authorization: TOKEN,
            currentAuthorization: 'MediaBrowser Token="other"',
            url: `${prefix}play-1/index.m3u8`
        })).toBe(false);
        expect(authorizePlaybackXhr({
            prefix,
            authorization: TOKEN,
            currentAuthorization: TOKEN,
            url: `${prefix}play-1/index.m3u8`
        })).toBe(true);
    });

    it('does not play when the session changes before the manifest is ready', async () => {
        let parsed: () => void = () => {
            // The manifest event is installed by the player before this runs.
        };
        const play = vi.fn(() => Promise.resolve());
        const listeners = new Map<string, Set<() => void>>();
        const video = {
            readyState: 1,
            currentTime: 0,
            play,
            pause: vi.fn(),
            load: vi.fn(),
            removeAttribute: vi.fn(),
            addEventListener: (name: string, callback: () => void) => {
                const set = listeners.get(name) ?? new Set<() => void>();
                set.add(callback);
                listeners.set(name, set);
            },
            removeEventListener: (name: string, callback: () => void) => {
                listeners.get(name)?.delete(callback);
            }
        };
        const hls: HlsLike = {
            on: (event, handler) => {
                if (event === 'hlsManifestParsed') {
                    parsed = () => handler(event);
                }
            },
            loadSource: vi.fn(),
            attachMedia: vi.fn(),
            destroy: vi.fn()
        };
        let current = true;
        const attached = attachPluginHls({
            video: video as unknown as HTMLVideoElement,
            sourceUrl: `${prefix}play-1/index.m3u8`,
            startSeconds: 296,
            stillCurrent: () => current,
            xhrSetup: () => undefined,
            createHls: () => hls
        });
        current = false;
        parsed();
        await expect(attached.done).resolves.toBe('interrupted');
        expect(play).not.toHaveBeenCalled();
        expect(hls.destroy).toHaveBeenCalled();
    });
});

describe('preview cleanup', () => {
    it('drops a late frame after the user key changes', () => {
        expect(keepPreview({
            requestedKey: 'user-a\nheader-a',
            currentKey: 'user-a\nheader-b',
            aborted: false
        })).toBe(false);
        expect(keepPreview({
            requestedKey: 'user-a\nheader-a',
            currentKey: 'user-a\nheader-a',
            aborted: true
        })).toBe(false);
        expect(keepPreview({
            requestedKey: 'user-a\nheader-a',
            currentKey: 'user-a\nheader-a',
            aborted: false
        })).toBe(true);
    });
});

describe('grouped capability', () => {
    it('does not search a reference-score plugin that lacks grouped video', async () => {
        const methods: string[] = [];
        const result = await runSegmentSearch({
            request: (call) => {
                methods.push(call.method);
                return Promise.resolve({
                    kind: 'response',
                    status: 200,
                    data: {
                        apiVersion: '1',
                        ticksPerSecond: TICKS_PER_SECOND,
                        availability: { search: 'available' },
                        coverage: { indexComplete: true },
                        qualityPolicy: { scoreMeaning: 'referenceTailR' }
                    }
                });
            }
        }, { query: '晚霞', clientQueryId: 'one', signal: idleSignal() });
        expect(result).toEqual({ kind: 'problem', problem: 'contract' });
        expect(methods).toEqual(['GET']);
    });
});
