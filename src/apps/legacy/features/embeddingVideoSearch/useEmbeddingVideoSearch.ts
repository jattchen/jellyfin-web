import type { Api } from '@jellyfin/sdk';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

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
import { toDisplayHit, weakDisclosure } from './presentation';
import { executeEmbeddingSearch } from './searchSession';
import { createClientQueryId, readSegment } from './searchRun';
import { createSdkTransport } from './transport';
import type { DisplayCard, DisplayHit, PlayRefusal, SearchHitModel, SegmentViewState } from './types';
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

function cardsFromBlobs(loaded: ReadonlyMap<string, { title: string; posterBlob?: Blob; runtimeTicks?: number }>): { cards: Map<string, DisplayCard>; urls: string[] } {
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

export interface PreviewModel {
    segmentId: string
    status: 'loading' | 'image' | 'none' | 'busy' | 'failed'
    url?: string
}

export interface EmbeddingVideoSearchModel {
    view: SegmentViewState
    related: DisplayHit[]
    weak: DisplayHit[]
    cards: ReadonlyMap<string, DisplayCard>
    weakOpen: boolean
    toggleWeak: () => void
    onPlay: (segmentId: string) => void
    onPreview: (segmentId: string) => void
    retry: () => void
    canRetry: boolean
    busySegmentId?: string
    playNote?: PlayRefusal
    playing?: PlayingMoment
    preview?: PreviewModel
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
    const previewAbortRef = useRef<AbortScope | undefined>(undefined);
    const previewKeyRef = useRef('');
    const viewRef = useRef<SegmentViewState>({ phase: 'idle' });
    const playbackRef = useRef<ActivePlayback | undefined>(undefined);
    const hlsRef = useRef<HlsLike | undefined>(undefined);
    const previewUrlsRef = useRef<string[]>([]);
    const [playing, setPlaying] = useState<PlayingMoment | undefined>(undefined);
    const [preview, setPreview] = useState<PreviewModel | undefined>(undefined);
    const [mse, setMse] = useState<boolean | null>(null);

    if (appliedScope !== scope) {
        requestRef.current = '';
        playGateRef.current = retirePlayGate(playGateRef.current, scope);
        playAbortRef.current?.abort();
        previewAbortRef.current?.abort();
        setAppliedScope(scope);
        setWeakOpen(open => weakDisclosure(open, true));
        setPlayNote(undefined);
        setBusySegmentId(undefined);
        setPlaying(undefined);
        setPreview(undefined);
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

            revokeUrls(previewUrlsRef.current);
            previewUrlsRef.current = [];
        };
    }, [scope, videoRef]);

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
        const hit = hitsRef.current.find(entry => entry.segmentId === segmentId);
        const currentApi = apiRef.current;
        if (!hit || !currentApi) {
            return;
        }

        const previewKey = `${scopeRef.current}\n${segmentId}\n${hit.bindingVersion}`;
        if (previewKeyRef.current === previewKey && !previewAbortRef.current?.isAborted()) return;
        previewKeyRef.current = previewKey;
        previewAbortRef.current?.abort();
        const previewScope = createAbortScope();
        previewAbortRef.current = previewScope;
        const stamp = { ...stampRef.current };
        const requestedKey = `${stamp.userId}\n${stamp.authorizationHeader}`;
        if (!hit.bindingVersion) {
            setPreview({ segmentId, status: 'failed' });
            return;
        }

        setPreview({ segmentId, status: 'loading' });
        void fetchSegmentPreview(currentApi, segmentId, hit.bindingVersion, previewScope.signal).then((result) => {
            const currentKey = `${stampRef.current.userId}\n${stampRef.current.authorizationHeader}`;
            if (!keepPreview({
                requestedKey,
                currentKey,
                aborted: previewScope.isAborted()
            })) {
                return;
            }

            if (result.kind === 'image') {
                const url = URL.createObjectURL(result.blob);
                if (!keepPreview({ requestedKey, currentKey, aborted: previewScope.isAborted() })) {
                    URL.revokeObjectURL(url);
                    return;
                }

                revokeUrls(previewUrlsRef.current);
                previewUrlsRef.current = [url];
                setPreview({ segmentId, status: 'image', url });
                return;
            }

            previewKeyRef.current = '';
            if (result.kind === 'aborted') {
                return;
            }

            revokeUrls(previewUrlsRef.current);
            previewUrlsRef.current = [];
            if (result.kind === 'busy') {
                setPreview({ segmentId, status: 'busy' });
                return;
            }

            setPreview({ segmentId, status: result.kind === 'none' ? 'none' : 'failed' });
        });
    }, []);

    const retry = useCallback(() => {
        setRetryNonce(value => value + 1);
    }, []);

    const related = view.phase === 'ready' ? view.related.map(toDisplayHit) : [];
    const weak = view.phase === 'ready' ? view.weak.map(toDisplayHit) : [];

    return {
        view,
        related,
        weak,
        cards,
        weakOpen,
        toggleWeak,
        onPlay,
        onPreview,
        retry,
        canRetry: canRetryView(view),
        busySegmentId,
        playNote,
        playing,
        preview,
        mse,
        videoRef
    };
}
