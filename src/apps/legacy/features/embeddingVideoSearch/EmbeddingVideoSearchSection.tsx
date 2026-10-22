import React, { useEffect, useRef, useState, type FC } from 'react';

import { TICKS_PER_SECOND } from './constants';
import { isUnsubmitted } from './submitQuery';
import { segmentCopy } from './copy';
import { guidKey } from './guid';
import MomentRow from './MomentRow';
import MomentStage from './MomentStage';
import MomentTimeline from './MomentTimeline';
import { filmTag, foldRanked, hitsForFilm } from './presentation';
import { useEmbeddingVideoSearch } from './useEmbeddingVideoSearch';
import { getCurrentLocale } from 'lib/globalize';
import type { RankedHit } from './types';

import 'material-design-icons-iconfont';
import 'elements/emby-button/emby-button.scss';
import './embeddingVideoSearch.scss';

interface EmbeddingVideoSearchSectionProps {
    query: string
    draft?: string
    parentId?: string
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

const EmbeddingVideoSearchSection: FC<EmbeddingVideoSearchSectionProps> = ({ query, draft, parentId }) => {
    const copy = segmentCopy(getCurrentLocale());
    const videoRef = useRef<HTMLVideoElement>(null);
    const model = useEmbeddingVideoSearch(query, parentId, videoRef);
    const playingId = model.playing?.segmentId;
    const playheadTicks = usePlayhead(videoRef.current, playingId && model.mse ? playingId : undefined);

    if (model.view.phase === 'idle') {
        return null;
    }

    const ready = model.view.phase === 'ready';
    const ranked = model.ranked;
    const { shown, folded } = foldRanked(ranked);
    const filmKeys = new Set(ranked.map(hit => guidKey(hit.itemId)));
    const seriesNames = new Set([...model.cards.values()].map(card => card.series).filter(Boolean));
    const cardFor = (hit: RankedHit) => model.cards.get(guidKey(hit.itemId) ?? '');
    const titleFor = (hit: RankedHit) => cardFor(hit)?.title || copy.fallbackTitle;
    const tagFor = (hit: RankedHit) => filmTag(cardFor(hit), seriesNames.size > 1, copy.fallbackTitle);

    const playingHit = playingId ? ranked.find(hit => hit.segmentId === playingId) : undefined;
    const stageHit = playingHit ?? ranked[0];
    const stageCard = stageHit ? cardFor(stageHit) : undefined;
    let durationTicks = stageCard?.runtimeTicks;
    if (playingHit && model.playing?.durationTicks) {
        durationTicks = model.playing.durationTicks;
    }

    let status = '';
    if (model.view.phase === 'pending') {
        status = copy.searching;
    } else if (model.view.phase === 'problem') {
        status = copy.problem(model.view.problem);
    } else if (model.playNote) {
        status = copy.play(model.playNote);
    } else if (model.busySegmentId) {
        status = copy.opening;
    }

    const row = (hit: RankedHit) => (
        <MomentRow
            key={hit.segmentId}
            hit={hit}
            title={titleFor(hit)}
            tag={tagFor(hit)}
            thumb={model.thumbs.get(hit.segmentId)}
            current={hit.segmentId === playingId}
            busy={hit.segmentId === model.busySegmentId}
            copy={copy}
            onPlay={model.onPlay}
            onPreview={model.onPreview}
        />
    );

    return (
        <section className='evs padded-left padded-right' aria-labelledby='embedding-video-search-title' aria-busy={model.view.phase === 'pending'}>
            <header className='evsHead'>
                <h2 id='embedding-video-search-title' className='evsTitle'>{copy.title}</h2>
                {ready && ranked.length > 0 && (
                    <p className='evsSummary'>{copy.summary(filmKeys.size, ranked.length)}</p>
                )}
                <p className='evsCaveat'>{copy.caveat}</p>
                {model.view.phase === 'ready' && model.view.collapsedRuns && ranked.length > 0 && (
                    <p className='evsCaveat'>{copy.collapsedNote}</p>
                )}
                {draft !== undefined && isUnsubmitted(draft, query) && (
                    <p className='evsNotice is-attention' role='status'>{copy.unsubmitted}</p>
                )}
                {model.view.phase === 'ready' && model.view.notices.map(notice => (
                    <p key={notice} className='evsNotice' role='status'>{copy.notice(notice)}</p>
                ))}
                {status && <p className='evsNotice' role='status'>{status}</p>}
                {model.canRetry && (
                    <button type='button' className='emby-button button-flat evsRetry' onClick={model.retry}>
                        {copy.retry}
                    </button>
                )}
            </header>

            {model.view.phase === 'pending' && (
                <div className='evsLayout is-skeleton' aria-hidden='true'>
                    <div className='evsStage'><div className='evsPlayer' /></div>
                    <div className='evsList'>
                        {[0, 1, 2].map(key => <div key={key} className='evsSkeletonRow' />)}
                    </div>
                </div>
            )}

            {ready && stageHit && (
                <div className='evsLayout'>
                    <div className='evsStage'>
                        <MomentStage
                            hit={stageHit}
                            title={titleFor(stageHit)}
                            thumb={model.thumbs.get(stageHit.segmentId)}
                            playing={Boolean(playingHit)}
                            busy={stageHit.segmentId === model.busySegmentId}
                            mse={model.mse}
                            videoRef={videoRef}
                            copy={copy}
                            onPlay={model.onPlay}
                        >
                            <MomentTimeline
                                title={titleFor(stageHit)}
                                hits={hitsForFilm(ranked, stageHit.itemId)}
                                durationTicks={durationTicks}
                                playheadTicks={playingHit ? (playheadTicks ?? model.playing?.startTicks) : undefined}
                                currentId={playingId}
                                thumbs={model.thumbs}
                                copy={copy}
                                onPlay={model.onPlay}
                                onPreview={model.onPreview}
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
            )}
        </section>
    );
};

export default EmbeddingVideoSearchSection;
