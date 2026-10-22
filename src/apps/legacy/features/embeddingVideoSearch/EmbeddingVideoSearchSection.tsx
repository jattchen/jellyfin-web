import React, { useEffect, useMemo, useRef, useState, type FC, type RefObject } from 'react';

import { TICKS_PER_SECOND } from './constants';
import { isUnsubmitted } from './submitQuery';
import { segmentCopy, type SegmentCopy } from './copy';
import { guidKey, sameGuid } from './guid';
import MomentRow from './MomentRow';
import MomentStage from './MomentStage';
import MomentTimeline from './MomentTimeline';
import SimilarReferenceBar from './SimilarReferenceBar';
import { filmTag, foldRanked, hitBand, hitsForFilm } from './presentation';
import { sameTitleMoment, stageHitForPlayback, type SimilarReference } from './similarSearch';
import { useEmbeddingVideoSearch, type EmbeddingVideoSearchModel, type SimilarController, type SimilarReturnNotice } from './useEmbeddingVideoSearch';
import { getCurrentLocale } from 'lib/globalize';
import type { DisplayCard, RankedHit, ThumbState } from './types';

import 'material-design-icons-iconfont';
import 'elements/emby-button/emby-button.scss';
import './embeddingVideoSearch.scss';

interface EmbeddingVideoSearchSectionProps {
    query: string
    draft?: string
    parentId?: string
    similarSegmentId?: string
    onSimilarChange?: (next: string | undefined, history: 'push' | 'replace') => void
    onSimilarBack?: () => void
}

function usePlayhead(video: HTMLVideoElement | null, active: string | undefined) {
    const [ticks, setTicks] = useState<number | undefined>(undefined);
    useEffect(() => {
        setTicks(undefined);
        if (!video || !active) {
            return undefined;
        }

        const sync = () => {
            if (Number.isFinite(video.currentTime)) {
                setTicks(Math.round(video.currentTime * TICKS_PER_SECOND));
            }
        };
        sync();
        video.addEventListener('timeupdate', sync);
        video.addEventListener('seeked', sync);
        return () => {
            video.removeEventListener('timeupdate', sync);
            video.removeEventListener('seeked', sync);
        };
    }, [video, active]);
    return ticks;
}

function returnNoticeText(notice: SimilarReturnNotice, copy: SegmentCopy): string {
    if (notice.kind === 'unavailable') {
        return copy.similarCannot;
    }

    if (notice.problem) {
        return copy.similarProblem(notice.problem);
    }

    return copy.referenceGone;
}

function isTypingTarget(target: EventTarget): boolean {
    return target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement;
}

function escapeLeavesSimilar(event: KeyboardEvent, root: HTMLElement | null): boolean {
    if (event.key !== 'Escape' || !root) {
        return false;
    }

    const target = event.target;
    if (!(target instanceof Node) || !root.contains(target)) {
        return false;
    }

    if (isTypingTarget(target) || document.fullscreenElement) {
        return false;
    }

    return true;
}

function listedMoments(
    similarActive: boolean,
    similarPhase: EmbeddingVideoSearchModel['similarPhase'],
    similarRanked: RankedHit[],
    textRanked: RankedHit[]
): RankedHit[] {
    if (!similarActive) {
        return textRanked;
    }

    if (similarPhase === 'ready') {
        return similarRanked;
    }

    return [];
}

function activeCards(
    similarActive: boolean,
    similarCards: ReadonlyMap<string, DisplayCard>,
    textCards: ReadonlyMap<string, DisplayCard>
): ReadonlyMap<string, DisplayCard> {
    if (similarActive) {
        return similarCards;
    }

    return textCards;
}

function cardForHit(
    hit: RankedHit,
    cardMap: ReadonlyMap<string, DisplayCard>,
    textCards: ReadonlyMap<string, DisplayCard>
): DisplayCard | undefined {
    const key = guidKey(hit.itemId) ?? '';
    return cardMap.get(key) ?? textCards.get(key);
}

function momentThumb(
    segmentId: string,
    similarActive: boolean,
    similarThumbs: ReadonlyMap<string, ThumbState>,
    textThumbs: ReadonlyMap<string, ThumbState>
): ThumbState | undefined {
    if (!similarActive) {
        return textThumbs.get(segmentId);
    }

    return similarThumbs.get(segmentId) ?? textThumbs.get(segmentId);
}

function mergedThumbs(
    similarActive: boolean,
    textThumbs: ReadonlyMap<string, ThumbState>,
    similarThumbs: ReadonlyMap<string, ThumbState>
): ReadonlyMap<string, ThumbState> {
    if (!similarActive) {
        return textThumbs;
    }

    return new Map([...textThumbs, ...similarThumbs]);
}

function heldOnStage(
    playing: EmbeddingVideoSearchModel['playing'],
    heldHit: RankedHit | undefined
): RankedHit | undefined {
    if (!playing || !heldHit || !sameGuid(heldHit.segmentId, playing.segmentId)) {
        return undefined;
    }

    return heldHit;
}

function stageDuration(
    runtimeTicks: number | undefined,
    stageIsPlaying: boolean,
    playingDuration: number | undefined
): number | undefined {
    if (stageIsPlaying && playingDuration) {
        return playingDuration;
    }

    return runtimeTicks;
}

function sourceMark(
    reference: SimilarReference | undefined,
    stageItemId: string | undefined,
    durationTicks: number | undefined,
    label: string
): { left: number; width: number; label: string } | undefined {
    if (!reference || !stageItemId || !sameGuid(stageItemId, reference.itemId)) {
        return undefined;
    }

    const band = hitBand(reference.source.startTicks, reference.source.endTicks, durationTicks);
    if (!band) {
        return undefined;
    }

    return { left: band.left, width: band.width, label };
}

function referenceFilmTitle(
    reference: SimilarReference | undefined,
    cardMap: ReadonlyMap<string, DisplayCard>,
    textCards: ReadonlyMap<string, DisplayCard>,
    fallback: string
): string {
    if (!reference) {
        return fallback;
    }

    const key = guidKey(reference.itemId) ?? '';
    return cardMap.get(key)?.title || textCards.get(key)?.title || fallback;
}

function rowTag(
    hit: RankedHit,
    reference: SimilarReference | undefined,
    card: DisplayCard | undefined,
    multipleSeries: boolean,
    copy: SegmentCopy
): string {
    if (reference && sameTitleMoment(hit.itemId, reference.itemId)) {
        return copy.sameFilm;
    }

    return filmTag(card, multipleSeries, copy.fallbackTitle);
}

function playbackStatus(
    similarActive: boolean,
    view: EmbeddingVideoSearchModel['view'],
    playNote: EmbeddingVideoSearchModel['playNote'],
    busySegmentId: string | undefined,
    copy: SegmentCopy
): string {
    if (!similarActive && view.phase === 'pending') {
        return copy.searching;
    }

    if (!similarActive && view.phase === 'problem') {
        return copy.problem(view.problem);
    }

    if (playNote) {
        return copy.play(playNote);
    }

    if (busySegmentId) {
        return copy.opening;
    }

    return '';
}

function activePlayheadId(playingId: string | undefined, mse: boolean | null): string | undefined {
    if (playingId && mse) {
        return playingId;
    }

    return undefined;
}

function timelinePlayhead(
    stageIsPlaying: boolean,
    playheadTicks: number | undefined,
    startTicks: number | undefined
): number | undefined {
    if (!stageIsPlaying) {
        return undefined;
    }

    if (playheadTicks === undefined) {
        return startTicks;
    }

    return playheadTicks;
}

function sectionClassName(similarActive: boolean): string {
    if (similarActive) {
        return 'evs is-similar padded-left padded-right';
    }

    return 'evs padded-left padded-right';
}

function sectionTitleId(similarActive: boolean): string {
    if (similarActive) {
        return 'embedding-similar-title';
    }

    return 'embedding-video-search-title';
}

function sectionBusy(viewPhase: string, similarPhase: string): boolean {
    return viewPhase === 'pending' || similarPhase === 'pending';
}

function showResultLayout(similarActive: boolean, ready: boolean, stageHit: RankedHit | undefined): boolean {
    return Boolean(stageHit) && (similarActive || ready);
}

function filmCountOf(ranked: readonly RankedHit[]): number {
    return new Set(ranked.map(hit => guidKey(hit.itemId))).size;
}

function seriesTotal(
    cardMap: ReadonlyMap<string, DisplayCard>,
    textCards: ReadonlyMap<string, DisplayCard>
): number {
    return new Set([...cardMap.values(), ...textCards.values()].map(card => card.series).filter(Boolean)).size;
}

function runWasMerged(ranked: readonly RankedHit[]): boolean {
    return ranked.some(hit => (hit.run?.memberCount ?? 0) > 1);
}

interface SimilarHeadProps {
    copy: SegmentCopy
    reference?: SimilarReference
    referenceTitle: string
    similarThumbs: ReadonlyMap<string, ThumbState>
    textThumbs: ReadonlyMap<string, ThumbState>
    phase: EmbeddingVideoSearchModel['similarPhase']
    ranked: RankedHit[]
    filmCount: number
    indexComplete: boolean
    problemCode: EmbeddingVideoSearchModel['similarProblemCode']
    onBack: () => void
    onPlay: (segmentId: string) => void
}

function SimilarHead({
    copy,
    reference,
    referenceTitle,
    similarThumbs,
    textThumbs,
    phase,
    ranked,
    filmCount,
    indexComplete,
    problemCode,
    onBack,
    onPlay
}: Readonly<SimilarHeadProps>) {
    const ready = phase === 'ready';
    const found = ranked.length > 0;
    const referenceThumb = reference ?
        momentThumb(reference.segmentId, true, similarThumbs, textThumbs) :
        undefined;
    let liveText = copy.similarEmpty;
    if (found) {
        liveText = copy.similarFound(ranked.length);
    }

    return (
        <>
            <button type='button' className='evsBack' onClick={onBack}>
                <span className='material-icons' aria-hidden='true'>arrow_back</span>
                {copy.backToResults}
            </button>
            <h2 id='embedding-similar-title' className='evsTitle' tabIndex={-1}>{copy.similarTitle}</h2>
            {reference && (
                <SimilarReferenceBar
                    reference={reference}
                    title={referenceTitle}
                    thumb={referenceThumb}
                    copy={copy}
                    onPlay={onPlay}
                />
            )}
            {phase === 'pending' && (
                <p className='evsNotice' role='status'>{copy.similarSearching}</p>
            )}
            {ready && found && (
                <p className='evsSummary'>{copy.similarSummary(filmCount, ranked.length)}</p>
            )}
            {ready && !found && (
                <p className='evsNotice'>{copy.similarEmpty}</p>
            )}
            {ready && (
                <p className='evsLive' role='status'>{liveText}</p>
            )}
            {ready && found && (
                <p className='evsCaveat'>{copy.similarCaveat}</p>
            )}
            {ready && runWasMerged(ranked) && (
                <p className='evsCaveat'>{copy.collapsedNote}</p>
            )}
            {ready && !indexComplete && (
                <p className='evsNotice'>{copy.notice('partial-index')}</p>
            )}
            {problemCode && (
                <p className='evsNotice' role='status'>{copy.similarProblem(problemCode)}</p>
            )}
        </>
    );
}

interface TextHeadProps {
    copy: SegmentCopy
    query: string
    draft?: string
    model: EmbeddingVideoSearchModel
}

function TextHead({ copy, query, draft, model }: Readonly<TextHeadProps>) {
    const ready = model.view.phase === 'ready';
    return (
        <>
            <h2 id='embedding-video-search-title' className='evsTitle' tabIndex={-1}>{copy.title}</h2>
            {ready && model.ranked.length > 0 && (
                <p className='evsSummary'>{copy.summary(filmCountOf(model.ranked), model.ranked.length)}</p>
            )}
            <p className='evsCaveat'>{copy.caveat}</p>
            {model.view.phase === 'ready' && model.view.collapsedRuns && model.ranked.length > 0 && (
                <p className='evsCaveat'>{copy.collapsedNote}</p>
            )}
            {draft !== undefined && isUnsubmitted(draft, query) && (
                <p className='evsNotice is-attention' role='status'>{copy.unsubmitted}</p>
            )}
            {model.returnNotice && (
                <p className='evsNotice' role='status'>{returnNoticeText(model.returnNotice, copy)}</p>
            )}
            {model.view.phase === 'ready' && model.view.notices.map(notice => (
                <p key={notice} className='evsNotice' role='status'>{copy.notice(notice)}</p>
            ))}
        </>
    );
}

function SearchSkeleton() {
    return (
        <div className='evsLayout is-skeleton' aria-hidden='true'>
            <div className='evsStage'><div className='evsPlayer' /></div>
            <div className='evsList'>
                {[0, 1, 2].map(key => <div key={key} className='evsSkeletonRow' />)}
            </div>
        </div>
    );
}

interface ResultsLayoutProps {
    model: EmbeddingVideoSearchModel
    stageHit: RankedHit
    ranked: RankedHit[]
    playingId?: string
    playheadTicks?: number
    durationTicks?: number
    stageIsPlaying: boolean
    timelineThumbs: ReadonlyMap<string, ThumbState>
    referenceMark?: { left: number; width: number; label: string }
    cardMap: ReadonlyMap<string, DisplayCard>
    similarActive: boolean
    seriesCount: number
    findSimilar?: (segmentId: string) => void
    copy: SegmentCopy
    videoRef: RefObject<HTMLVideoElement>
}

function ResultsLayout({
    model,
    stageHit,
    ranked,
    playingId,
    playheadTicks,
    durationTicks,
    stageIsPlaying,
    timelineThumbs,
    referenceMark,
    cardMap,
    similarActive,
    seriesCount,
    findSimilar,
    copy,
    videoRef
}: Readonly<ResultsLayoutProps>) {
    const { shown, folded } = foldRanked(ranked);
    const row = (hit: RankedHit) => {
        const card = cardForHit(hit, cardMap, model.cards);
        return (
            <MomentRow
                key={hit.segmentId}
                hit={hit}
                title={card?.title || copy.fallbackTitle}
                tag={rowTag(hit, model.similarReference, card, seriesCount > 1, copy)}
                thumb={momentThumb(hit.segmentId, similarActive, model.similarThumbs, model.thumbs)}
                current={Boolean(playingId && sameGuid(hit.segmentId, playingId))}
                busy={hit.segmentId === model.busySegmentId}
                copy={copy}
                onPlay={model.onPlay}
                onPreview={model.onPreview}
                onFindSimilar={findSimilar}
            />
        );
    };

    return (
        <div className='evsLayout'>
            <div className='evsStage'>
                <MomentStage
                    hit={stageHit}
                    title={cardForHit(stageHit, cardMap, model.cards)?.title || copy.fallbackTitle}
                    thumb={momentThumb(stageHit.segmentId, similarActive, model.similarThumbs, model.thumbs)}
                    playing={stageIsPlaying}
                    busy={stageHit.segmentId === model.busySegmentId}
                    mse={model.mse}
                    videoRef={videoRef}
                    copy={copy}
                    onPlay={model.onPlay}
                    onFindSimilar={findSimilar}
                >
                    <MomentTimeline
                        title={cardForHit(stageHit, cardMap, model.cards)?.title || copy.fallbackTitle}
                        hits={hitsForFilm(ranked, stageHit.itemId)}
                        durationTicks={durationTicks}
                        playheadTicks={timelinePlayhead(stageIsPlaying, playheadTicks, model.playing?.startTicks)}
                        currentId={playingId}
                        thumbs={timelineThumbs}
                        copy={copy}
                        onPlay={model.onPlay}
                        onPreview={model.onPreview}
                        referenceMark={referenceMark}
                    />
                </MomentStage>
            </div>
            <div className='evsList'>
                <ol className='evsRanked'>{shown.map(row)}</ol>
                {folded.length > 0 && (
                    <>
                        <button
                            type='button'
                            className='evsMore'
                            aria-expanded={model.moreOpen}
                            aria-controls='embedding-video-search-more'
                            onClick={model.toggleMore}
                        >
                            <span>{model.moreOpen ? copy.moreHide : copy.moreShow(folded.length)}</span>
                            <span className='material-icons' aria-hidden='true'>{model.moreOpen ? 'expand_less' : 'expand_more'}</span>
                        </button>
                        {model.moreOpen && (
                            <ol id='embedding-video-search-more' className='evsRanked' start={shown.length + 1}>
                                {folded.map(row)}
                            </ol>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

const EmbeddingVideoSearchSection: FC<EmbeddingVideoSearchSectionProps> = ({
    query,
    draft,
    parentId,
    similarSegmentId,
    onSimilarChange,
    onSimilarBack
}) => {
    const copy = segmentCopy(getCurrentLocale());
    const videoRef = useRef<HTMLVideoElement>(null);
    const sectionRef = useRef<HTMLElement>(null);
    const controller = useMemo<SimilarController | undefined>(() => {
        if (!onSimilarChange || !onSimilarBack) {
            return undefined;
        }

        return {
            segmentId: similarSegmentId,
            onChange: onSimilarChange,
            onBack: onSimilarBack
        };
    }, [onSimilarBack, onSimilarChange, similarSegmentId]);
    const model = useEmbeddingVideoSearch(query, parentId, videoRef, controller);
    const playingId = model.playing?.segmentId;
    const playheadTicks = usePlayhead(videoRef.current, activePlayheadId(playingId, model.mse));
    const similarActive = model.similarPhase !== 'off';
    useEffect(() => {
        const request = model.focusRequest;
        if (!request) {
            return;
        }

        if (request.scrollY !== undefined) {
            window.scrollTo(0, request.scrollY);
        }

        const node = document.getElementById(request.id);
        if (node) {
            node.focus();
            return;
        }

        document.getElementById('embedding-video-search-title')?.focus();
    }, [model.focusRequest]);
    useEffect(() => {
        if (!similarActive || !onSimilarBack) {
            return undefined;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (!escapeLeavesSimilar(event, sectionRef.current)) {
                return;
            }

            event.preventDefault();
            onSimilarBack();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [onSimilarBack, similarActive]);

    if (model.view.phase === 'idle') {
        return null;
    }

    const ranked = listedMoments(similarActive, model.similarPhase, model.similarRanked, model.ranked);
    const cardMap = activeCards(similarActive, model.similarCards, model.cards);
    const held = heldOnStage(model.playing, model.heldHit);
    const stageHit = stageHitForPlayback(held, ranked);
    let stageCard: DisplayCard | undefined;
    if (stageHit) {
        stageCard = cardForHit(stageHit, cardMap, model.cards);
    }

    const stageIsPlaying = Boolean(stageHit && playingId && sameGuid(stageHit.segmentId, playingId));
    const durationTicks = stageDuration(stageCard?.runtimeTicks, stageIsPlaying, model.playing?.durationTicks);
    const reference = model.similarReference;
    const referenceTitle = referenceFilmTitle(reference, cardMap, model.cards, copy.fallbackTitle);
    const timelineThumbs = mergedThumbs(similarActive, model.thumbs, model.similarThumbs);
    const referenceMark = sourceMark(reference, stageHit?.itemId, durationTicks, copy.referenceMark);
    const status = playbackStatus(similarActive, model.view, model.playNote, model.busySegmentId, copy);
    let findSimilar: ((segmentId: string) => void) | undefined;
    if (model.similarEnabled) {
        findSimilar = model.onFindSimilar;
    }

    const layout = showResultLayout(similarActive, model.view.phase === 'ready', stageHit);
    return (
        <section
            ref={sectionRef}
            className={sectionClassName(similarActive)}
            aria-labelledby={sectionTitleId(similarActive)}
            aria-busy={sectionBusy(model.view.phase, model.similarPhase)}
        >
            <header className='evsHead'>
                {similarActive ? (
                    <SimilarHead
                        copy={copy}
                        reference={reference}
                        referenceTitle={referenceTitle}
                        similarThumbs={model.similarThumbs}
                        textThumbs={model.thumbs}
                        phase={model.similarPhase}
                        ranked={ranked}
                        filmCount={filmCountOf(ranked)}
                        indexComplete={model.similarIndexComplete}
                        problemCode={model.similarProblemCode}
                        onBack={model.onSimilarBack}
                        onPlay={model.onPlay}
                    />
                ) : (
                    <TextHead copy={copy} query={query} draft={draft} model={model} />
                )}
                {status && <p className='evsNotice' role='status'>{status}</p>}
                {similarActive && model.canRetrySimilar && (
                    <button type='button' className='emby-button button-flat evsRetry' onClick={model.retrySimilar}>
                        {copy.retry}
                    </button>
                )}
                {!similarActive && model.canRetry && (
                    <button type='button' className='emby-button button-flat evsRetry' onClick={model.retry}>
                        {copy.retry}
                    </button>
                )}
            </header>

            {!similarActive && model.view.phase === 'pending' && (
                <SearchSkeleton />
            )}

            {similarActive && model.similarPhase === 'pending' && !stageHit && (
                <SearchSkeleton />
            )}

            {layout && stageHit && (
                <ResultsLayout
                    model={model}
                    stageHit={stageHit}
                    ranked={ranked}
                    playingId={playingId}
                    playheadTicks={playheadTicks}
                    durationTicks={durationTicks}
                    stageIsPlaying={stageIsPlaying}
                    timelineThumbs={timelineThumbs}
                    referenceMark={referenceMark}
                    cardMap={cardMap}
                    similarActive={similarActive}
                    seriesCount={seriesTotal(cardMap, model.cards)}
                    findSimilar={findSimilar}
                    copy={copy}
                    videoRef={videoRef}
                />
            )}
        </section>
    );
};

export default EmbeddingVideoSearchSection;
