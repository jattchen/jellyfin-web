import type { Api } from '@jellyfin/sdk';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { playbackManager } from 'components/playback/playbackmanager';
import { useApi } from 'hooks/useApi';

import { createAbortScope, type AbortScope } from './abort';
import { PLAYBACK_PREFIX } from './constants';
import { fetchOfficialItem } from './items';
import type { NativePlayOptions } from './playback';
import { attachPluginHls, clearVideoSurface, createPluginHls, destroyHls, pageCanPlayHls, type HlsLike } from './playbackAttach';
import { authorizePlaybackXhr, deletePlaybackSession, seekSeconds, type ActivePlayback } from './playbackContract';
import { issuePlayTicket, retirePlayGate, runScopedPlay, ticketStillCurrent, type PlayGate } from './playGate';
import { fetchSegmentPreview, keepPreview } from './previewFetch';
import { openSessionForHit, runHitPlayback } from './runHitPlayback';
import { applyPlayOutcome } from './results';
import { rankHits, toDisplayHit, weakDisclosure } from './presentation';
import { executeEmbeddingSearch } from './searchSession';
import { createClientQueryId, readSegment } from './searchRun';
import { createThumbnailQueue, type ThumbQueue } from './thumbnailQueue';
import { createSdkTransport } from './transport';
import type { DisplayCard, ItemCard, PlayRefusal, RankedHit, SearchHitModel, SegmentViewState, ThumbState } from './types';
import { canRetryView, sameSession, searchScopeKey, shouldApplyResult, viewForScope, type SessionStamp } from './viewState';

interface NativePlayback {
    play: (options: NativePlayOptions) => Promise<unknown>
}

function playbackRequestGuard(session: ActivePlayback, prefix: string, readAuthorization: () => string) {
    return (xhr: XMLHttpRequest, url: string) => {
        if (!authorizePlaybackXhr({
            prefix,
            authorization: session.authorization,
            currentAuthorization: readAuthorization(),
            url
        })) {
            xhr.abort();
            throw new Error('blocked');
        }

        xhr.setRequestHeader('Authorization', session.authorization);
    };
}

async function attachAuthorizedSession(
    video: HTMLVideoElement,
    session: ActivePlayback,
    stillCurrent: () => boolean,
    prefix: string,
    readAuthorization: () => string,
    remember: (hls: HlsLike) => void
) {
    const xhrSetup = playbackRequestGuard(session, prefix, readAuthorization);
    const created = await createPluginHls(xhrSetup);
    if (!created || !stillCurrent()) {
        destroyHls(created);
        return { result: stillCurrent() ? 'failed' as const : 'interrupted' as const };
    }

    const attached = attachPluginHls({
        video,
        sourceUrl: session.mediaUrl,
        startSeconds: seekSeconds(session.startTicks),
        stillCurrent,
        xhrSetup,
        createHls: () => created
    });
    remember(attached.hls);
    return { result: await attached.done, hls: attached.hls };
}

async function releaseOwnedSession(
    session: ActivePlayback,
    api: Api,
    owns: (playbackId: string) => boolean,
    clear: () => void
) {
    if (owns(session.playbackId)) {
        clear();
    }

    await deletePlaybackSession(api, session);
}

function revokeUrls(urls: string[]) {
    for (const url of urls) {
        URL.revokeObjectURL(url);
    }
}

function cardsFromBlobs(loaded: ReadonlyMap<string, ItemCard>): { cards: Map<string, DisplayCard>; urls: string[] } {
    const cards = new Map<string, DisplayCard>();
    const urls: string[] = [];
    for (const [key, card] of loaded) {
        let posterUrl: string | undefined;
        if (card.posterBlob instanceof Blob && card.posterBlob.size > 0) {
            posterUrl = URL.createObjectURL(card.posterBlob);
            urls.push(posterUrl);
        }

        cards.set(key, {
            title: card.title,
            series: card.series,
            episodeCode: card.episodeCode,
            posterUrl,
            runtimeTicks: card.runtimeTicks
        });
    }

    return { cards, urls };
}

export interface PlayingMoment {
    segmentId: string
    itemId: string
    mediaSourceId: string
    startTicks: number
    durationTicks?: number
}

export interface EmbeddingVideoSearchModel {
    view: SegmentViewState
    /** Every listed moment across films, best first. */
    ranked: RankedHit[]
    cards: ReadonlyMap<string, DisplayCard>
    thumbs: ReadonlyMap<string, ThumbState>
    moreOpen: boolean
    toggleMore: () => void
    onPlay: (segmentId: string) => void
    /** Moves this moment's frame to the front of the loading queue. */
    onPreview: (segmentId: string) => void
    retry: () => void
    canRetry: boolean
    busySegmentId?: string
    playNote?: PlayRefusal
    playing?: PlayingMoment
    mse: boolean | null
    videoRef: RefObject<HTMLVideoElement | null>
}

export function useEmbeddingVideoSearch(
    query: string,
    parentId: string | undefined,
    videoRef: RefObject<HTMLVideoElement | null>
): EmbeddingVideoSearchModel {
    const { api, user } = useApi();
    const header = api?.authorizationHeader ?? '';
    const headerRef = useRef(header);
    const [sessionEpoch, setSessionEpoch] = useState(0);
    if (headerRef.current !== header) {
        headerRef.current = header;
        setSessionEpoch(value => value + 1);
    }

    const stampRef = useRef<SessionStamp>({
        serverId: '',
        userId: '',
        basePath: '',
        authorizationHeader: ''
    });
    stampRef.current = {
        serverId: user?.ServerId ?? '',
        userId: user?.Id ?? '',
        basePath: api?.basePath ?? '',
        authorizationHeader: header
    };
    const apiRef = useRef<Api | undefined>(api);
    apiRef.current = api;
    const [retryNonce, setRetryNonce] = useState(0);
    const signedIn = Boolean(api && user?.Id && user.ServerId);
    const scope = searchScopeKey({
        sessionEpoch,
        userId: user?.Id ?? '',
        serverId: user?.ServerId ?? '',
        basePath: api?.basePath ?? '',
        query,
        parentId,
        retryNonce
    });
    const scopeRef = useRef(scope);
    scopeRef.current = scope;

    const [appliedScope, setAppliedScope] = useState<string | undefined>(undefined);
    const [view, setView] = useState<SegmentViewState>({ phase: 'idle' });
    const [cards, setCards] = useState<Map<string, DisplayCard>>(new Map());
    const [weakOpen, setWeakOpen] = useState(false);
    const [busySegmentId, setBusySegmentId] = useState<string | undefined>(undefined);
    const [playNote, setPlayNote] = useState<PlayRefusal | undefined>(undefined);
    const hitsRef = useRef<SearchHitModel[]>([]);
    const posterUrlsRef = useRef<string[]>([]);
    const requestRef = useRef('');
    const playGateRef = useRef<PlayGate>({ generation: 0, scope: '' });
    const playAbortRef = useRef<AbortScope | undefined>(undefined);
    const thumbQueueRef = useRef<ThumbQueue | undefined>(undefined);
    const viewRef = useRef<SegmentViewState>({ phase: 'idle' });
    const playbackRef = useRef<ActivePlayback | undefined>(undefined);
    const hlsRef = useRef<HlsLike | undefined>(undefined);
    const [playing, setPlaying] = useState<PlayingMoment | undefined>(undefined);
    const [thumbs, setThumbs] = useState<Map<string, ThumbState>>(new Map());
    const [mse, setMse] = useState<boolean | null>(null);

    if (appliedScope !== scope) {
        requestRef.current = '';
        playGateRef.current = retirePlayGate(playGateRef.current, scope);
        playAbortRef.current?.abort();
        thumbQueueRef.current?.dispose();
        thumbQueueRef.current = undefined;
        setAppliedScope(scope);
        setWeakOpen(open => weakDisclosure(open, true));
        setPlayNote(undefined);
        setBusySegmentId(undefined);
        setPlaying(undefined);
        setThumbs(new Map());
        setCards(new Map());
        setView(viewForScope({
            query,
            signedIn,
            parentId
        }));
    }

    const hits = view.phase === 'ready' ? [...view.related, ...view.weak] : [];
    hitsRef.current = hits;
    viewRef.current = view;
    const ranked = useMemo(() => (
        view.phase === 'ready' ? rankHits(view.related.map(toDisplayHit), view.weak.map(toDisplayHit)) : []
    ), [view]);
    const thumbOrder = ranked.map(hit => hit.segmentId).join('\n');

    useEffect(() => {
        const currentApi = apiRef.current;
        const userId = stampRef.current.userId;
        const scoped = viewForScope({
            query,
            signedIn: Boolean(currentApi && userId && stampRef.current.serverId),
            parentId
        });
        if (!currentApi || scoped.phase !== 'pending') {
            return undefined;
        }

        const clientQueryId = createClientQueryId();
        requestRef.current = clientQueryId;
        const scopeHandle = createAbortScope();
        const stamp = { ...stampRef.current };
        void executeEmbeddingSearch({
            api: currentApi,
            userId,
            query,
            parentId,
            clientQueryId,
            signal: scopeHandle.signal
        }).then((result) => {
            const current = shouldApplyResult({
                requestId: requestRef.current,
                expectedId: clientQueryId,
                aborted: scopeHandle.isAborted(),
                sessionMatches: sameSession(stamp, stampRef.current)
            });
            if (!current || result.kind === 'aborted') {
                return;
            }

            if (result.kind === 'problem') {
                setView({ phase: 'problem', problem: result.problem });
                return;
            }

            revokeUrls(posterUrlsRef.current);
            const nextCards = cardsFromBlobs(result.cards);
            posterUrlsRef.current = nextCards.urls;
            setCards(nextCards.cards);
            setView(result.view);
        });

        return () => {
            scopeHandle.abort();
            revokeUrls(posterUrlsRef.current);
            posterUrlsRef.current = [];
        };
    }, [parentId, query, scope]);

    useEffect(() => {
        let live = true;
        void pageCanPlayHls().then((supported) => {
            if (live) {
                setMse(supported);
            }
        });
        return () => {
            live = false;
        };
    }, []);

    useEffect(() => {
        return () => {
            const session = playbackRef.current;
            const hls = hlsRef.current;
            playbackRef.current = undefined;
            hlsRef.current = undefined;
            destroyHls(hls);
            clearVideoSurface(videoRef.current);
            const currentApi = apiRef.current;
            if (session && currentApi) {
                void deletePlaybackSession(currentApi, session);
            }
        };
    }, [scope, videoRef]);

    useEffect(() => {
        const stamp = { ...stampRef.current };
        const requestedKey = `${stamp.userId}\n${stamp.authorizationHeader}`;
        const queue = createThumbnailQueue({
            fetch: (job, signal) => {
                const currentApi = apiRef.current;
                if (!currentApi) {
                    return Promise.resolve({ kind: 'failed' as const });
                }

                return fetchSegmentPreview(currentApi, job.segmentId, job.bindingVersion, signal);
            },
            stillCurrent: () => keepPreview({
                requestedKey,
                currentKey: `${stampRef.current.userId}\n${stampRef.current.authorizationHeader}`,
                aborted: thumbQueueRef.current !== queue
            }),
            onChange: (segmentId, state) => {
                if (thumbQueueRef.current !== queue) {
                    return;
                }

                setThumbs(previous => new Map(previous).set(segmentId, state));
            }
        });
        thumbQueueRef.current = queue;
        return () => {
            if (thumbQueueRef.current === queue) {
                thumbQueueRef.current = undefined;
            }

            queue.dispose();
        };
    }, [scope]);

    useEffect(() => {
        if (!thumbOrder) {
            return;
        }

        const byId = new Map(hitsRef.current.map(hit => [hit.segmentId, hit]));
        thumbQueueRef.current?.enqueue(thumbOrder.split('\n').map(segmentId => ({
            segmentId,
            bindingVersion: byId.get(segmentId)?.bindingVersion
        })));
    }, [scope, thumbOrder]);

    useEffect(() => {
        return () => {
            playGateRef.current = retirePlayGate(playGateRef.current, '');
            playAbortRef.current?.abort();
        };
    }, []);

    const toggleWeak = useCallback(() => {
        setWeakOpen(open => weakDisclosure(!open, false));
    }, []);

    const onPlay = useCallback((segmentId: string) => {
        const hit = hitsRef.current.find(entry => entry.segmentId === segmentId);
        const currentApi = apiRef.current;
        const userId = stampRef.current.userId;
        if (!hit || !currentApi || userId.length === 0) {
            return;
        }

        const opened = issuePlayTicket(playGateRef.current, scopeRef.current);
        playGateRef.current = opened.gate;
        const ticket = opened.ticket;
        playAbortRef.current?.abort();
        const playScope = createAbortScope();
        playAbortRef.current = playScope;
        const stamp = { ...stampRef.current };
        setBusySegmentId(segmentId);
        setPlayNote(undefined);
        const manager = playbackManager as NativePlayback;
        const live = () => ticketStillCurrent(ticket, playGateRef.current, sameSession(stamp, stampRef.current));
        const clearPlayback = () => {
            destroyHls(hlsRef.current);
            hlsRef.current = undefined;
            playbackRef.current = undefined;
            clearVideoSurface(videoRef.current);
        };
        const rememberHls = (hls: HlsLike) => {
            hlsRef.current = hls;
        };
        const getUri = (path: string) => currentApi.getUri(path);
        const ownsPlayback = (playbackId: string) => playbackRef.current?.playbackId === playbackId;
        const readAuthorization = () => apiRef.current?.authorizationHeader ?? '';
        const openSession = (clicked: SearchHitModel, signal: AbortSignal) => openSessionForHit({
            transport: createSdkTransport(currentApi),
            getUri,
            authorization: stamp.authorizationHeader,
            hit: clicked,
            signal,
            api: currentApi
        });
        const deleteSession = (session: ActivePlayback) => releaseOwnedSession(
            session,
            currentApi,
            ownsPlayback,
            clearPlayback
        );
        const attach = (video: HTMLVideoElement, session: ActivePlayback, stillCurrent: () => boolean) => (
            attachAuthorizedSession(
                video,
                session,
                stillCurrent,
                currentApi.getUri(PLAYBACK_PREFIX),
                readAuthorization,
                rememberHls
            )
        );
        const publish = (session: ActivePlayback, hls: HlsLike | undefined) => {
            if (!live()) {
                return;
            }

            playbackRef.current = session;
            if (hls) {
                hlsRef.current = hls;
            }
        };
        void runScopedPlay({
            ticket,
            readGate: () => playGateRef.current,
            sessionMatches: () => sameSession(stamp, stampRef.current),
            clicked: hit,
            signal: playScope.signal,
            fetchSegment: (id, signal) => readSegment(createSdkTransport(currentApi), id, signal),
            fetchItem: (itemId, signal) => fetchOfficialItem(currentApi, userId, itemId, signal),
            play: options => runHitPlayback({
                hit,
                live,
                signal: playScope.signal,
                video: videoRef.current,
                authorization: stamp.authorizationHeader,
                active: playbackRef.current,
                canPlayInPage: pageCanPlayHls,
                nativePlay: nativeOptions => manager.play(nativeOptions),
                options,
                openSession,
                deleteSession,
                attach,
                publish,
                owns: ownsPlayback
            })
        }).then((result) => {
            if (!ticketStillCurrent(ticket, playGateRef.current, sameSession(stamp, stampRef.current))) {
                return;
            }

            setBusySegmentId(undefined);
            if (result.ok) {
                setPlaying({
                    segmentId: hit.segmentId,
                    itemId: hit.itemId,
                    mediaSourceId: hit.mediaSourceId,
                    startTicks: hit.startTicks,
                    durationTicks: playbackRef.current?.durationTicks
                });
                return;
            }

            const nextView = applyPlayOutcome(viewRef.current, hit, result);
            setView(nextView);
            if (nextView.phase === 'problem') {
                setPlayNote(undefined);
                return;
            }

            setPlayNote(result.reason);
        });
    }, [videoRef]);

    const onPreview = useCallback((segmentId: string) => {
        thumbQueueRef.current?.prioritize(segmentId);
    }, []);

    const retry = useCallback(() => {
        setRetryNonce(value => value + 1);
    }, []);

    return {
        view,
        ranked,
        cards,
        thumbs,
        moreOpen: weakOpen,
        toggleMore: toggleWeak,
        onPlay,
        onPreview,
        retry,
        canRetry: canRetryView(view),
        busySegmentId,
        playNote,
        playing,
        mse,
        videoRef
    };
}
