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
import { sameGuid } from './guid';
import { rankHits, toDisplayHit, weakDisclosure } from './presentation';
import { executeEmbeddingSearch } from './searchSession';
import { createClientQueryId, readSegment } from './searchRun';
import { executeSimilarSearch, type SimilarExecutionResult } from './similarSession';
import {
    focusAfterReturn,
    similarNavigation,
    type SimilarFailure,
    type SimilarHit,
    type SimilarReference,
    type TextViewSnapshot
} from './similarSearch';
import { createThumbnailQueue, type ThumbQueue } from './thumbnailQueue';
import { createSdkTransport } from './transport';
import type { DisplayCard, ItemCard, PlayRefusal, ProblemCode, RankedHit, SearchHitModel, SegmentViewState, ThumbState } from './types';
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

export type SimilarReturnNotice =
    | { kind: 'unavailable' }
    | { kind: 'gone'; problem?: ProblemCode };

export interface FocusRequest {
    id: string
    token: number
    scrollY?: number
}

export interface SimilarController {
    segmentId?: string
    onChange: (next: string | undefined, history: 'push' | 'replace') => void
    onBack: () => void
}

type SimilarState =
    | { phase: 'off' }
    | { phase: 'pending' }
    | { phase: 'ready'; reference: SimilarReference; hits: SimilarHit[]; indexComplete: boolean }
    | { phase: 'problem'; problem: ProblemCode };

interface SimilarSnapshot extends TextViewSnapshot {
    scopeKey: string
}

const SIMILAR_RETRYABLE = new Set<ProblemCode>(['timeout', 'busy', 'transport', 'rejected']);

function referencePlayHit(reference: SimilarReference): SearchHitModel {
    return {
        itemId: reference.itemId,
        mediaSourceId: reference.mediaSourceId,
        segmentId: reference.segmentId,
        startTicks: reference.startTicks,
        endTicks: reference.endTicks,
        indexComplete: true,
        score: 0,
        quality: 'related',
        representation: reference.representation,
        bindingVersion: reference.bindingVersion,
        similarAvailable: true
    };
}

function withdrawHit(itemId: string, mediaSourceId: string): SearchHitModel {
    return {
        itemId,
        mediaSourceId,
        segmentId: itemId,
        startTicks: 0,
        endTicks: 1,
        indexComplete: true,
        score: 0,
        quality: 'related'
    };
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
    /** Ranked moment kept so playback survives a similar list that does not contain it. */
    heldHit?: RankedHit
    mse: boolean | null
    videoRef: RefObject<HTMLVideoElement | null>
    similarEnabled: boolean
    similarPhase: SimilarState['phase']
    similarReference?: SimilarReference
    similarRanked: RankedHit[]
    similarCards: ReadonlyMap<string, DisplayCard>
    similarThumbs: ReadonlyMap<string, ThumbState>
    similarIndexComplete: boolean
    returnNotice?: SimilarReturnNotice
    onFindSimilar: (segmentId: string) => void
    onSimilarBack: () => void
    retrySimilar: () => void
    canRetrySimilar: boolean
    /** Set while Find similar is showing a retryable or blocking failure. */
    similarProblemCode?: ProblemCode
    focusRequest?: FocusRequest
}

function playableMoments(similar: SimilarState, hits: SearchHitModel[]): SearchHitModel[] {
    if (similar.phase === 'off') {
        return hits;
    }

    if (similar.phase !== 'ready') {
        return [];
    }

    return [...similar.hits, referencePlayHit(similar.reference)];
}

function similarFeatureMarker(view: SegmentViewState): '0' | '1' {
    if (view.phase === 'ready' && view.similarSegments) {
        return '1';
    }

    return '0';
}

function similarThumbKey(similar: SimilarState): string {
    if (similar.phase !== 'ready') {
        return '';
    }

    return [similar.reference.segmentId, ...similar.hits.map(hit => hit.segmentId)].join('\n');
}

interface DerivedSimilarFields {
    heldHit?: RankedHit
    similarEnabled: boolean
    similarPhase: SimilarState['phase']
    similarReference?: SimilarReference
    similarIndexComplete: boolean
    canRetrySimilar: boolean
    similarProblemCode?: ProblemCode
}

function similarViewFields(
    view: SegmentViewState,
    similar: SimilarState,
    playing: PlayingMoment | undefined,
    held: RankedHit | undefined
): DerivedSimilarFields {
    let similarReference: SimilarReference | undefined;
    let similarIndexComplete = true;
    let canRetrySimilar = false;
    let similarProblemCode: ProblemCode | undefined;
    if (similar.phase === 'ready') {
        similarReference = similar.reference;
        similarIndexComplete = similar.indexComplete;
    }

    if (similar.phase === 'problem') {
        canRetrySimilar = SIMILAR_RETRYABLE.has(similar.problem);
        similarProblemCode = similar.problem;
    }

    let heldHit: RankedHit | undefined;
    if (playing) {
        heldHit = held;
    }

    return {
        heldHit,
        similarEnabled: view.phase === 'ready' && view.similarSegments === true,
        similarPhase: similar.phase,
        similarReference,
        similarIndexComplete,
        canRetrySimilar,
        similarProblemCode
    };
}

function keepsSimilarHit(entry: SimilarHit, hit: SearchHitModel, reason: PlayRefusal): boolean {
    if (reason === 'stale') {
        return !(sameGuid(entry.itemId, hit.itemId) && entry.mediaSourceId === hit.mediaSourceId);
    }

    return !sameGuid(entry.itemId, hit.itemId);
}

function similarHitsAfterRefusal(previous: SimilarState, hit: SearchHitModel, reason: PlayRefusal): SimilarState {
    if (previous.phase !== 'ready') {
        return previous;
    }

    if (reason !== 'notFound' && reason !== 'denied' && reason !== 'stale') {
        return previous;
    }

    return {
        ...previous,
        hits: previous.hits.filter(entry => keepsSimilarHit(entry, hit, reason))
    };
}

interface SimilarLeaveInput {
    snap: SimilarSnapshot | undefined
    phase: SimilarState['phase']
    posterCount: number
    scopeKey: string
    hits: readonly SearchHitModel[]
    plan: ReturnType<typeof focusAfterReturn> | undefined
    nextToken: number
}

interface SimilarLeavePlan {
    turnOff: boolean
    restore?: {
        moreOpen: boolean
        focus: FocusRequest
    }
}

function planSimilarLeave(input: SimilarLeaveInput): SimilarLeavePlan | undefined {
    const hadSimilar = input.phase !== 'off' || Boolean(input.snap) || input.posterCount > 0;
    if (!hadSimilar) {
        return undefined;
    }

    const snap = input.snap;
    let restore: SimilarLeavePlan['restore'];
    if (snap && snap.scopeKey === input.scopeKey) {
        const decision = input.plan ?? focusAfterReturn(snap, input.hits.map(hit => hit.segmentId));
        const match = input.hits.find(hit => snap.originSegmentId && sameGuid(hit.segmentId, snap.originSegmentId));
        let focusId = 'embedding-video-search-title';
        if (decision.focus === 'origin' && match) {
            focusId = `evs-similar-${match.segmentId}`;
        }

        restore = {
            moreOpen: snap.moreOpen,
            focus: {
                id: focusId,
                scrollY: snap.scrollY,
                token: input.nextToken
            }
        };
    }

    return {
        turnOff: input.phase !== 'off',
        restore
    };
}

function applyPlannedLeave(
    action: SimilarLeavePlan,
    io: {
        abort: () => void
        clearSnapshot: () => void
        clearPlan: () => void
        turnOff: () => void
        releasePosters: () => void
        clearCards: () => void
        restore: (moreOpen: boolean, focus: FocusRequest) => void
    }
): void {
    io.abort();
    io.clearSnapshot();
    io.clearPlan();
    if (action.turnOff) {
        io.turnOff();
    }

    io.releasePosters();
    io.clearCards();
    if (action.restore) {
        io.restore(action.restore.moreOpen, action.restore.focus);
    }
}

interface SimilarRuntime {
    releasePosters: () => void
    rememberPosterUrls: (urls: string[]) => void
    setSimilar: (state: SimilarState) => void
    setSimilarCards: (cards: Map<string, DisplayCard>) => void
    setView: (view: SegmentViewState) => void
    setReturnNotice: (notice: SimilarReturnNotice) => void
    setFocusPlan: (plan: ReturnType<typeof focusAfterReturn> | undefined) => void
    readHits: () => SearchHitModel[]
    readView: () => SegmentViewState
    readSnapshot: () => SimilarSnapshot | undefined
    onBack: () => void
}

function similarReturnNotice(failure: Extract<SimilarFailure, { kind: 'return' }>): SimilarReturnNotice {
    if (failure.notice === 'unavailable') {
        return { kind: 'unavailable' };
    }

    return { kind: 'gone', problem: failure.problem };
}

function withdrawReason(withdraw: 'item' | 'media'): 'stale' | 'notFound' {
    if (withdraw === 'media') {
        return 'stale';
    }

    return 'notFound';
}

function remainingSegmentIds(
    result: Extract<SimilarExecutionResult, { kind: 'failure' }>,
    runtime: SimilarRuntime
): string[] {
    const ids = runtime.readHits().map(hit => hit.segmentId);
    const failure = result.failure;
    if (failure.kind !== 'return') {
        return ids;
    }

    if (!result.itemId || !result.mediaSourceId) {
        return ids;
    }

    const view = runtime.readView();
    if (view.phase !== 'ready' || failure.withdraw === 'none') {
        return ids;
    }

    const next = applyPlayOutcome(view, withdrawHit(result.itemId, result.mediaSourceId), {
        ok: false,
        reason: withdrawReason(failure.withdraw)
    });
    runtime.setView(next);
    if (next.phase !== 'ready') {
        return ids;
    }

    return [...next.related, ...next.weak].map(hit => hit.segmentId);
}

function applySimilarFailure(
    result: Extract<SimilarExecutionResult, { kind: 'failure' }>,
    runtime: SimilarRuntime
): void {
    if (result.failure.kind === 'aborted') {
        return;
    }

    if (result.failure.kind === 'stay') {
        runtime.setSimilar({ phase: 'problem', problem: result.failure.problem });
        return;
    }

    const ids = remainingSegmentIds(result, runtime);
    const snap = runtime.readSnapshot();
    if (snap) {
        runtime.setFocusPlan(focusAfterReturn(snap, ids));
    }

    runtime.setReturnNotice(similarReturnNotice(result.failure));
    runtime.onBack();
}

function publishSimilarReady(
    result: Extract<SimilarExecutionResult, { kind: 'ready' }>,
    runtime: SimilarRuntime
): void {
    runtime.releasePosters();
    const nextCards = cardsFromBlobs(result.cards);
    runtime.rememberPosterUrls(nextCards.urls);
    runtime.setSimilarCards(nextCards.cards);
    runtime.setSimilar({
        phase: 'ready',
        reference: result.body.reference,
        hits: result.body.hits,
        indexComplete: result.body.indexComplete
    });
}

function applySimilarExecutionResult(
    result: SimilarExecutionResult,
    gate: {
        requestId: string
        expectedId: string
        aborted: boolean
        sessionMatches: boolean
        requestedSegmentId: string
    },
    runtime: SimilarRuntime
): void {
    const current = shouldApplyResult({
        requestId: gate.requestId,
        expectedId: gate.expectedId,
        aborted: gate.aborted,
        sessionMatches: gate.sessionMatches
    });
    if (!current || result.kind === 'aborted') {
        return;
    }

    if (result.kind === 'failure') {
        applySimilarFailure(result, runtime);
        return;
    }

    if (!sameGuid(gate.requestedSegmentId, result.body.reference.segmentId)) {
        runtime.setSimilar({ phase: 'problem', problem: 'contract' });
        return;
    }

    publishSimilarReady(result, runtime);
}

interface BeginSimilarInput {
    api: Api
    userId: string
    parentId?: string
    segmentId: string
    pending?: {
        segmentId: string
        bindingVersion?: string
        itemId: string
        mediaSourceId: string
    }
    readStamp: () => SessionStamp
    readRequestId: () => string
    setRequestId: (id: string) => void
    setAbort: (scope: AbortScope) => void
    readSnapshot: () => SimilarSnapshot | undefined
    writeSnapshot: (snapshot: SimilarSnapshot) => void
    moreOpen: boolean
    scopeKey: string
    takeToken: () => number
    setReturnNotice: (notice: SimilarReturnNotice | undefined) => void
    setSimilar: (state: SimilarState) => void
    setFocusRequest: (request: FocusRequest) => void
    runtime: SimilarRuntime
}

function knownMedia(pending: BeginSimilarInput['pending'], segmentId: string): BeginSimilarInput['pending'] {
    if (!pending || !sameGuid(pending.segmentId, segmentId)) {
        return undefined;
    }

    return pending;
}

function beginSimilarRequest(input: BeginSimilarInput): () => void {
    const clientQueryId = createClientQueryId();
    input.setRequestId(clientQueryId);
    const handle = createAbortScope();
    input.setAbort(handle);
    if (!input.readSnapshot()) {
        input.writeSnapshot({
            moreOpen: input.moreOpen,
            scrollY: window.scrollY,
            originSegmentId: input.segmentId,
            scopeKey: input.scopeKey
        });
    }

    input.setReturnNotice(undefined);
    input.setSimilar({ phase: 'pending' });
    input.setFocusRequest({ id: 'embedding-similar-title', token: input.takeToken() });
    const stamp = input.readStamp();
    const known = knownMedia(input.pending, input.segmentId);
    const requestedSegmentId = input.segmentId;
    let knownBody: { itemId: string; mediaSourceId: string } | undefined;
    if (known) {
        knownBody = { itemId: known.itemId, mediaSourceId: known.mediaSourceId };
    }

    void executeSimilarSearch({
        api: input.api,
        userId: input.userId,
        segmentId: requestedSegmentId,
        expectedBindingVersion: known?.bindingVersion,
        parentId: input.parentId,
        clientQueryId,
        signal: handle.signal,
        known: knownBody
    }).then((result) => {
        applySimilarExecutionResult(result, {
            requestId: input.readRequestId(),
            expectedId: clientQueryId,
            aborted: handle.isAborted(),
            sessionMatches: sameSession(stamp, input.readStamp()),
            requestedSegmentId
        }, input.runtime);
    });
    return () => {
        handle.abort();
    };
}

export function useEmbeddingVideoSearch(
    query: string,
    parentId: string | undefined,
    videoRef: RefObject<HTMLVideoElement | null>,
    similarController?: SimilarController
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
    const [heldHit, setHeldHit] = useState<RankedHit | undefined>(undefined);
    const [thumbs, setThumbs] = useState<Map<string, ThumbState>>(new Map());
    const [mse, setMse] = useState<boolean | null>(null);
    const [similar, setSimilar] = useState<SimilarState>({ phase: 'off' });
    const [similarCards, setSimilarCards] = useState<Map<string, DisplayCard>>(new Map());
    const [similarThumbs, setSimilarThumbs] = useState<Map<string, ThumbState>>(new Map());
    const [similarRetry, setSimilarRetry] = useState(0);
    const [returnNotice, setReturnNotice] = useState<SimilarReturnNotice | undefined>(undefined);
    const [focusRequest, setFocusRequest] = useState<FocusRequest | undefined>(undefined);
    const similarRef = useRef<SimilarState>({ phase: 'off' });
    const similarAbortRef = useRef<AbortScope | undefined>(undefined);
    const similarQueueRef = useRef<ThumbQueue | undefined>(undefined);
    const similarRequestRef = useRef('');
    const similarPosterUrlsRef = useRef<string[]>([]);
    const textSnapshotRef = useRef<SimilarSnapshot | undefined>(undefined);
    const focusPlanRef = useRef<ReturnType<typeof focusAfterReturn> | undefined>(undefined);
    const focusTokenRef = useRef(0);
    const pendingEntryRef = useRef<{
        segmentId: string
        bindingVersion?: string
        itemId: string
        mediaSourceId: string
    } | undefined>(undefined);
    const weakOpenRef = useRef(false);
    const rankedRef = useRef<RankedHit[]>([]);
    const similarRankedRef = useRef<RankedHit[]>([]);
    const playableRef = useRef<SearchHitModel[]>([]);
    const similarChangeRef = useRef(similarController?.onChange);
    const similarBackRef = useRef(similarController?.onBack);
    similarChangeRef.current = similarController?.onChange;
    similarBackRef.current = similarController?.onBack;
    const similarSegmentId = similarController?.segmentId;

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
        setHeldHit(undefined);
        setThumbs(new Map());
        setCards(new Map());
        setSimilar({ phase: 'off' });
        setSimilarCards(new Map());
        setSimilarThumbs(new Map());
        setReturnNotice(undefined);
        textSnapshotRef.current = undefined;
        focusPlanRef.current = undefined;
        pendingEntryRef.current = undefined;
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
    const similarRanked = useMemo(() => (
        similar.phase === 'ready' ? rankHits(similar.hits.map(toDisplayHit), []) : []
    ), [similar]);
    const thumbOrder = ranked.map(hit => hit.segmentId).join('\n');
    similarRef.current = similar;
    weakOpenRef.current = weakOpen;
    rankedRef.current = ranked;
    similarRankedRef.current = similarRanked;
    playableRef.current = playableMoments(similar, hits);
    const similarFlag = similarFeatureMarker(view);
    const similarGate = `${scope}\n${view.phase}\n${similarFlag}\n${similarSegmentId ?? ''}\n${similarRetry}`;

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

    const similarThumbOrder = similarThumbKey(similar);

    useEffect(() => {
        if (!similarSegmentId) {
            return undefined;
        }

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
                aborted: similarQueueRef.current !== queue
            }),
            onChange: (segmentId, state) => {
                if (similarQueueRef.current !== queue) {
                    return;
                }

                setSimilarThumbs(previous => new Map(previous).set(segmentId, state));
            }
        });
        similarQueueRef.current = queue;
        return () => {
            if (similarQueueRef.current === queue) {
                similarQueueRef.current = undefined;
            }

            queue.dispose();
            setSimilarThumbs(new Map());
        };
    }, [scope, similarSegmentId]);

    useEffect(() => {
        const ready = similarRef.current;
        if (!similarThumbOrder || ready.phase !== 'ready') {
            return;
        }

        const binding = new Map<string, string | undefined>();
        binding.set(ready.reference.segmentId, ready.reference.bindingVersion);
        for (const hit of ready.hits) {
            binding.set(hit.segmentId, hit.bindingVersion);
        }

        similarQueueRef.current?.enqueue(similarThumbOrder.split('\n').map(segmentId => ({
            segmentId,
            bindingVersion: binding.get(segmentId)
        })));
    }, [scope, similarThumbOrder]);

    useEffect(() => {
        const releasePosters = () => {
            revokeUrls(similarPosterUrlsRef.current);
            similarPosterUrlsRef.current = [];
        };
        if (!similarSegmentId) {
            const action = planSimilarLeave({
                snap: textSnapshotRef.current,
                phase: similarRef.current.phase,
                posterCount: similarPosterUrlsRef.current.length,
                scopeKey: scopeRef.current,
                hits: hitsRef.current,
                plan: focusPlanRef.current,
                nextToken: focusTokenRef.current + 1
            });
            if (!action) {
                return undefined;
            }

            applyPlannedLeave(action, {
                abort: () => {
                    similarAbortRef.current?.abort();
                },
                clearSnapshot: () => {
                    textSnapshotRef.current = undefined;
                },
                clearPlan: () => {
                    focusPlanRef.current = undefined;
                },
                turnOff: () => {
                    setSimilar({ phase: 'off' });
                },
                releasePosters,
                clearCards: () => {
                    setSimilarCards(new Map());
                },
                restore: (moreOpen, focus) => {
                    setWeakOpen(moreOpen);
                    focusTokenRef.current = focus.token;
                    setFocusRequest(focus);
                }
            });
            return undefined;
        }

        const currentView = viewRef.current;
        if (currentView.phase === 'pending') {
            return undefined;
        }

        if (currentView.phase !== 'ready' || !currentView.similarSegments) {
            similarChangeRef.current?.(undefined, 'replace');
            return undefined;
        }

        const currentApi = apiRef.current;
        const userId = stampRef.current.userId;
        if (!currentApi || userId.length === 0) {
            return undefined;
        }

        const runtime: SimilarRuntime = {
            releasePosters,
            rememberPosterUrls: (urls) => {
                similarPosterUrlsRef.current = urls;
            },
            setSimilar,
            setSimilarCards,
            setView,
            setReturnNotice,
            setFocusPlan: (plan) => {
                focusPlanRef.current = plan;
            },
            readHits: () => hitsRef.current,
            readView: () => viewRef.current,
            readSnapshot: () => textSnapshotRef.current,
            onBack: () => {
                similarBackRef.current?.();
            }
        };
        return beginSimilarRequest({
            api: currentApi,
            userId,
            parentId,
            segmentId: similarSegmentId,
            pending: pendingEntryRef.current,
            readStamp: () => ({ ...stampRef.current }),
            readRequestId: () => similarRequestRef.current,
            setRequestId: (id) => {
                similarRequestRef.current = id;
            },
            setAbort: (abortScope) => {
                similarAbortRef.current = abortScope;
            },
            readSnapshot: () => textSnapshotRef.current,
            writeSnapshot: (snapshot) => {
                textSnapshotRef.current = snapshot;
            },
            moreOpen: weakOpenRef.current,
            scopeKey: scopeRef.current,
            takeToken: () => {
                const token = focusTokenRef.current + 1;
                focusTokenRef.current = token;
                return token;
            },
            setReturnNotice,
            setSimilar,
            setFocusRequest,
            runtime
        });
    }, [parentId, similarGate, similarSegmentId]);

    const toggleWeak = useCallback(() => {
        setWeakOpen(open => weakDisclosure(!open, false));
    }, []);

    const onPlay = useCallback((segmentId: string) => {
        const hit = playableRef.current.find(entry => sameGuid(entry.segmentId, segmentId));
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
                const listed = [...rankedRef.current, ...similarRankedRef.current]
                    .find(entry => sameGuid(entry.segmentId, hit.segmentId));
                setHeldHit(listed ?? { ...toDisplayHit(hit), rank: 0 });
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
            if (result.reason === 'notFound' || result.reason === 'denied' || result.reason === 'stale') {
                setSimilar(previous => similarHitsAfterRefusal(previous, hit, result.reason));
            }
            if (nextView.phase === 'problem') {
                setPlayNote(undefined);
                return;
            }

            setPlayNote(result.reason);
        });
    }, [videoRef]);

    const onPreview = useCallback((segmentId: string) => {
        if (similarRef.current.phase === 'off') {
            thumbQueueRef.current?.prioritize(segmentId);
            return;
        }

        similarQueueRef.current?.prioritize(segmentId);
    }, []);

    const retry = useCallback(() => {
        setRetryNonce(value => value + 1);
    }, []);

    const onFindSimilar = useCallback((segmentId: string) => {
        const sources = [
            ...hitsRef.current,
            ...(similarRef.current.phase === 'ready' ? similarRef.current.hits : [])
        ];
        const hit = sources.find(entry => sameGuid(entry.segmentId, segmentId));
        if (!hit || hit.similarAvailable === false) {
            return;
        }

        if (similarSegmentId && sameGuid(similarSegmentId, hit.segmentId)) {
            return;
        }

        if (!textSnapshotRef.current) {
            textSnapshotRef.current = {
                moreOpen: weakOpenRef.current,
                scrollY: window.scrollY,
                originSegmentId: hit.segmentId,
                scopeKey: scopeRef.current
            };
        }

        pendingEntryRef.current = {
            segmentId: hit.segmentId,
            bindingVersion: hit.bindingVersion,
            itemId: hit.itemId,
            mediaSourceId: hit.mediaSourceId
        };
        similarChangeRef.current?.(hit.segmentId, similarNavigation(similarSegmentId, hit.segmentId));
    }, [similarSegmentId]);

    const onSimilarBack = useCallback(() => {
        similarBackRef.current?.();
    }, []);

    const retrySimilar = useCallback(() => {
        setSimilarRetry(value => value + 1);
    }, []);

    const similarFields = similarViewFields(view, similar, playing, heldHit);
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
        heldHit: similarFields.heldHit,
        mse,
        videoRef,
        similarEnabled: similarFields.similarEnabled,
        similarPhase: similarFields.similarPhase,
        similarReference: similarFields.similarReference,
        similarRanked,
        similarCards,
        similarThumbs,
        similarIndexComplete: similarFields.similarIndexComplete,
        returnNotice,
        onFindSimilar,
        onSimilarBack,
        retrySimilar,
        canRetrySimilar: similarFields.canRetrySimilar,
        similarProblemCode: similarFields.similarProblemCode,
        focusRequest
    };
}
