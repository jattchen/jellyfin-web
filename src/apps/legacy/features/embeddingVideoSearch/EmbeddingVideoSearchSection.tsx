import React, { useCallback, useEffect, useRef, useState, type FC } from 'react';

import { TICKS_PER_SECOND } from './constants';
import { isUnsubmitted } from './submitQuery';
import { segmentCopy } from './copy';
import { guidKey } from './guid';
import { positionFrame } from './playbackContract';
import { groupDisplayedHits, hitBand, playheadRatio } from './presentation';
import { useEmbeddingVideoSearch } from './useEmbeddingVideoSearch';
import { getCurrentLocale } from 'lib/globalize';
import type { DisplayCard, DisplayHit } from './types';

import 'components/listview/listview.scss';
import 'elements/emby-button/emby-button.scss';
import 'material-design-icons-iconfont';
import './embeddingVideoSearch.scss';

interface HitButtonProps {
    hit: DisplayHit
    title: string
    busy: boolean
    selected: boolean
    label: string
    partialText?: string
    onPlay: (segmentId: string) => void
    onPreview: (segmentId: string) => void
}

const HitButton: FC<HitButtonProps> = ({ hit, title, busy, selected, label, partialText, onPlay, onPreview }) => {
    const onClick = useCallback(() => {
        onPreview(hit.segmentId);
        onPlay(hit.segmentId);
    }, [hit.segmentId, onPlay, onPreview]);
    const onFocus = useCallback(() => {
        onPreview(hit.segmentId);
    }, [hit.segmentId, onPreview]);

    return (
        <button
            type='button'
            className='listItem listItem-button listItem-border embeddingHit'
            onClick={onClick}
            onFocus={onFocus}
            onPointerEnter={onFocus}
            disabled={busy}
            aria-busy={busy}
            aria-current={selected ? 'true' : undefined}
            aria-label={label}
        >
            <div className='listItemBody'>
                <div className='listItemBodyText'>{title}</div>
                <div className='secondary listItemBodyText'>{hit.range}</div>
                {hit.transcript && <div className='secondary embeddingTranscript'>{hit.transcript}</div>}
                {partialText && <div className='secondary listItemBodyText'>{partialText}</div>}
            </div>
        </button>
    );
};

interface TimelineMarkProps {
    hit: DisplayHit
    title: string
    selected: boolean
    label: string
    left: number
    width: number
    lane: number
    onPlay: (segmentId: string) => void
    onPreview: (segmentId: string) => void
}

const TimelineMark: FC<TimelineMarkProps> = ({ hit, title, selected, label, left, width, lane, onPlay, onPreview }) => {
    const preview = useCallback(() => {
        onPreview(hit.segmentId);
    }, [hit.segmentId, onPreview]);
    const activate = useCallback(() => {
        preview();
        onPlay(hit.segmentId);
    }, [hit.segmentId, onPlay, preview]);

    return (
        <button
            type='button'
            className={selected ? 'embeddingMark is-selected' : 'embeddingMark'}
            style={{ left: `${left}%`, width: `${width}%`, top: `${0.4 + lane * 2.2}rem` }}
            aria-label={label || title}
            aria-current={selected ? 'true' : undefined}
            onClick={activate}
            onFocus={preview}
            onPointerEnter={preview}
        />
    );
};

interface FilmGroupProps {
    itemId: string
    hits: DisplayHit[]
    cards: ReadonlyMap<string, DisplayCard>
    durationTicks?: number
    playheadTicks?: number
    selectedId?: string
    busySegmentId?: string
    fallbackTitle: string
    partialText: string
    unknownLength: string
    playNamed: (title: string, range: string, partial: boolean) => string
    onPlay: (segmentId: string) => void
    onPreview: (segmentId: string) => void
}

const FilmGroupView: FC<FilmGroupProps> = ({
    itemId,
    hits,
    cards,
    durationTicks,
    playheadTicks,
    selectedId,
    busySegmentId,
    fallbackTitle,
    partialText,
    unknownLength,
    playNamed,
    onPlay,
    onPreview
}) => {
    const card = cards.get(guidKey(itemId) ?? '');
    const title = card?.title || fallbackTitle;
    const posterStyle = card?.posterUrl ? { backgroundImage: `url("${card.posterUrl}")` } : undefined;
    const playhead = playheadRatio(playheadTicks ?? Number.NaN, durationTicks);
    const laneEnds: number[] = [];
    const marks = hits.flatMap(hit => {
        const band = hitBand(hit.startTicks, hit.endTicks, durationTicks);
        if (!band) return [];
        // Reserve the visible pointer target as well as the true time interval.
        const width = Math.max(band.width, 0.015);
        const left = Math.min(band.left, 1 - width);
        let lane = laneEnds.findIndex(end => end + 0.005 <= left);
        if (lane < 0) lane = laneEnds.length;
        laneEnds[lane] = left + Math.max(width, 0.045);
        return [{ hit, left, width, lane }];
    });

    return (
        <div className='embeddingFilm'>
            <div className='embeddingFilmHead'>
                <span className='listItemImage embeddingPoster' style={posterStyle}>
                    {!card?.posterUrl && <span className='material-icons listItemIcon' aria-hidden='true'>movie</span>}
                </span>
                <h3 className='embeddingFilmTitle'>{title}</h3>
            </div>
            {durationTicks ? (
                <div className='embeddingTimeline' role='group' aria-label={title} style={{ height: `${0.8 + laneEnds.length * 2.2}rem` }}>
                    {playhead !== undefined && <span className='embeddingPlayhead' style={{ left: `${playhead * 100}%` }} />}
                    {marks.map(({ hit, left, width, lane }) => {
                        return (
                            <TimelineMark
                                key={hit.segmentId}
                                hit={hit}
                                title={title}
                                selected={hit.segmentId === selectedId}
                                label={playNamed(title, hit.range, hit.partial)}
                                left={left * 100}
                                width={width * 100}
                                lane={lane}
                                onPlay={onPlay}
                                onPreview={onPreview}
                            />
                        );
                    })}
                </div>
            ) : <p className='secondaryText'>{unknownLength}</p>}
            <div className='padded-left padded-right'>
                {hits.map(hit => (
                    <HitButton
                        key={hit.segmentId}
                        hit={hit}
                        title={title}
                        busy={busySegmentId === hit.segmentId}
                        selected={hit.segmentId === selectedId}
                        label={playNamed(title, hit.range, hit.partial)}
                        partialText={hit.partial ? partialText : undefined}
                        onPlay={onPlay}
                        onPreview={onPreview}
                    />
                ))}
            </div>
        </div>
    );
};

interface EmbeddingVideoSearchSectionProps {
    query: string
    draft?: string
    parentId?: string
}

const EmbeddingVideoSearchSection: FC<EmbeddingVideoSearchSectionProps> = ({ query, draft, parentId }) => {
    const copy = segmentCopy(getCurrentLocale());
    const videoRef = useRef<HTMLVideoElement>(null);
    const model = useEmbeddingVideoSearch(query, parentId, videoRef);
    const [playheadTicks, setPlayheadTicks] = useState<number | undefined>(undefined);
    const playingId = model.playing?.segmentId;
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !playingId) {
            return undefined;
        }

        const sync = () => {
            if (!Number.isFinite(video.currentTime)) {
                return;
            }

            setPlayheadTicks(Math.round(video.currentTime * TICKS_PER_SECOND));
        };
        sync();
        video.addEventListener('timeupdate', sync);
        video.addEventListener('seeked', sync);
        return () => {
            video.removeEventListener('timeupdate', sync);
            video.removeEventListener('seeked', sync);
        };
    }, [playingId, model.mse]);
    const onFullscreen = useCallback(() => {
        const video = videoRef.current;
        if (!video) {
            return;
        }

        void video.requestFullscreen();
    }, []);
    const openNative = useCallback(() => {
        if (model.playing) {
            model.onPlay(model.playing.segmentId);
        }
    }, [model]);

    if (model.view.phase === 'idle') {
        return null;
    }

    const groups = model.view.phase === 'ready' ? groupDisplayedHits(model.related) : [];
    const weakCount = model.weak.length;
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

    const listed = [...model.related, ...model.weak];
    const focused = model.preview ? listed.find(hit => hit.segmentId === model.preview?.segmentId) : undefined;
    const frameUrl = model.preview?.status === 'image' ?
        positionFrame({ frameUrl: model.preview.url }) :
        undefined;
    let previewText = copy.previewHint;
    if (model.preview?.status === 'loading') {
        previewText = copy.previewLoading;
    } else if (model.preview?.status === 'busy') {
        previewText = copy.previewBusy;
    } else if (model.preview?.status === 'none' || model.preview?.status === 'failed') {
        previewText = copy.previewMissing;
    }

    return (
        <section className='verticalSection padded-bottom-page embeddingSearch' aria-labelledby='embedding-video-search-title'>
            <h2 id='embedding-video-search-title' className='sectionTitle sectionTitle-cards padded-left padded-right'>
                {copy.title}
            </h2>
            <p className='secondaryText padded-left padded-right embeddingIntro'>{copy.intro}</p>
            {draft !== undefined && isUnsubmitted(draft, query) && (
                <p className='secondaryText padded-left padded-right' role='status'>{copy.unsubmitted}</p>
            )}
            {model.view.phase === 'ready' && model.view.notices.map(notice => (
                <p key={notice} className='secondaryText padded-left padded-right' role='status'>{copy.notice(notice)}</p>
            ))}
            {status && <p className='secondaryText padded-left padded-right' role='status'>{status}</p>}
            {model.canRetry && (
                <div className='padded-left padded-right'>
                    <button type='button' className='emby-button button-flat show-focus' onClick={model.retry}>
                        {copy.retry}
                    </button>
                </div>
            )}
            <div className='embeddingWorkspace'>
                <div className='embeddingResults'>
                    {groups.map(group => {
                        const sameFilm = Boolean(model.playing && guidKey(model.playing.itemId) === guidKey(group.itemId));
                        const card = model.cards.get(guidKey(group.itemId) ?? '');
                        let durationTicks = card?.runtimeTicks;
                        if (sameFilm && model.playing?.durationTicks) {
                            durationTicks = model.playing.durationTicks;
                        }
                        let clock: number | undefined;
                        if (sameFilm) {
                            clock = playheadTicks ?? model.playing?.startTicks;
                        }
                        return (
                            <FilmGroupView
                                key={guidKey(group.itemId)}
                                itemId={group.itemId}
                                hits={group.hits}
                                cards={model.cards}
                                durationTicks={durationTicks}
                                playheadTicks={clock}
                                selectedId={model.playing?.segmentId}
                                busySegmentId={model.busySegmentId}
                                fallbackTitle={copy.fallbackTitle}
                                partialText={copy.partialItem}
                                unknownLength={copy.timelineUnknown}
                                playNamed={copy.playNamed}
                                onPlay={model.onPlay}
                                onPreview={model.onPreview}
                            />
                        );
                    })}
                    {model.view.phase === 'ready' && weakCount > 0 && (
                        <div className='padded-left padded-right'>
                            <button
                                type='button'
                                className='emby-button button-flat show-focus'
                                aria-expanded={model.weakOpen}
                                aria-controls='embedding-video-search-weak'
                                onClick={model.toggleWeak}
                            >
                                {model.weakOpen ? copy.weakHide(weakCount) : copy.weakShow(weakCount)}
                            </button>
                        </div>
                    )}
                    {model.view.phase === 'ready' && weakCount > 0 && model.weakOpen && (
                        <div id='embedding-video-search-weak' className='padded-left padded-right'>
                            {model.weak.map(hit => {
                                const card = model.cards.get(guidKey(hit.itemId) ?? '');
                                const title = card?.title || copy.fallbackTitle;
                                return (
                                    <HitButton
                                        key={hit.segmentId}
                                        hit={hit}
                                        title={title}
                                        busy={model.busySegmentId === hit.segmentId}
                                        selected={model.playing?.segmentId === hit.segmentId}
                                        label={copy.playNamed(title, hit.range, hit.partial)}
                                        partialText={hit.partial ? copy.partialItem : undefined}
                                        onPlay={model.onPlay}
                                        onPreview={model.onPreview}
                                    />
                                );
                            })}
                        </div>
                    )}
                </div>
                <div className='embeddingStage'>
                    {model.mse === null && <p className='secondaryText'>{copy.checkingPlayer}</p>}
                    {model.mse === false && <p className='secondaryText'>{copy.playerUnsupported}</p>}
                    {model.mse !== false && (
                        <video
                            ref={videoRef}
                            className={model.playing ? 'embeddingVideo' : 'embeddingVideo is-idle'}
                            controls={model.mse === true}
                            playsInline
                            preload='none'
                            hidden={model.mse !== true}
                        >
                            <track kind='captions' />
                        </video>
                    )}
                    {model.mse === true && !model.playing && <p className='secondaryText'>{copy.playerIdle}</p>}
                    {model.mse === true && (
                        <button
                            type='button'
                            className='emby-button button-flat show-focus'
                            onClick={onFullscreen}
                            disabled={!model.playing}
                        >
                            {copy.fullscreen}
                        </button>
                    )}
                    {model.mse === false && (
                        <button
                            type='button'
                            className='emby-button raised show-focus'
                            onClick={openNative}
                            disabled={!model.playing}
                        >
                            {copy.openNative}
                        </button>
                    )}
                    <div className='embeddingPreview' role='status'>
                        <div className='embeddingFrame'>
                            {frameUrl && focused ? (
                                <img src={frameUrl} alt={focused.range} />
                            ) : (
                                <p className='secondaryText'>{previewText}</p>
                            )}
                        </div>
                        {focused && (
                            <div>
                                <p>{focused.range}</p>
                                {focused.transcript && <p className='secondaryText embeddingTranscript'>{focused.transcript}</p>}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </section>
    );
};

export default EmbeddingVideoSearchSection;
