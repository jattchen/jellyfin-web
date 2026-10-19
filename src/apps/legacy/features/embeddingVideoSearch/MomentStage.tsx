import React, { type FC, type ReactNode, type RefObject, useCallback } from 'react';

import type { SegmentCopy } from './copy';
import MomentThumb from './MomentThumb';
import { formatTicks } from './presentation';
import type { RankedHit, ThumbState } from './types';

interface MomentStageProps {
    hit: RankedHit
    title: string
    thumb?: ThumbState
    playing: boolean
    busy: boolean
    mse: boolean | null
    videoRef: RefObject<HTMLVideoElement>
    copy: SegmentCopy
    onPlay: (segmentId: string) => void
    onFindSimilar?: (segmentId: string) => void
    children?: ReactNode
}

interface WebkitVideo extends HTMLVideoElement {
    webkitEnterFullscreen?: () => void
}

const MomentStage: FC<MomentStageProps> = ({ hit, title, thumb, playing, busy, mse, videoRef, copy, onPlay, onFindSimilar, children }) => {
    const play = useCallback(() => onPlay(hit.segmentId), [hit.segmentId, onPlay]);
    const findSimilar = useCallback(() => {
        onFindSimilar?.(hit.segmentId);
    }, [hit.segmentId, onFindSimilar]);
    const fullscreen = useCallback(() => {
        const video = videoRef.current as WebkitVideo | null;
        if (!video) {
            return;
        }

        if (typeof video.requestFullscreen === 'function') {
            void video.requestFullscreen();
        } else {
            video.webkitEnterFullscreen?.();
        }
    }, [videoRef]);
    const top = hit.rank === 1;

    return (
        <>
            <div className={playing ? 'evsPlayer is-playing' : 'evsPlayer'}>
                {mse !== false && (
                    <video
                        ref={videoRef}
                        className='evsVideo'
                        controls={mse === true && playing}
                        playsInline
                        preload='none'
                    >
                        <track kind='captions' />
                    </video>
                )}
                {!playing && (
                    <button type='button' className='evsCue' onClick={play} disabled={mse === null} aria-label={copy.playNamed(title, hit.range, hit.partial)}>
                        <MomentThumb
                            state={thumb}
                            time={formatTicks(hit.startTicks)}
                            alt={hit.range}
                            missingText={copy.thumbMissing}
                            className='evsThumb-stage'
                        />
                        <span className='evsCuePlay'>
                            <span className='material-icons' aria-hidden='true'>{busy ? 'hourglass_empty' : 'play_arrow'}</span>
                            <span>{busy ? copy.opening : copy.playFrom(hit.range)}</span>
                        </span>
                    </button>
                )}
            </div>
            {children}
            <div className='evsNow'>
                <div className='evsNowHead'>
                    {playing && <span className='evsBadge evsBadge-live'>{copy.nowPlaying}</span>}
                    {top && <span className='evsBadge'>{copy.best}</span>}
                    <span className='evsMeta'>{copy.rank(hit.rank)} · {copy.kind(hit.representation)}</span>
                    <span className='evsNowActions'>
                        {onFindSimilar && (
                            <button
                                type='button'
                                className='evsSimilar evsSimilar-stage'
                                onClick={findSimilar}
                                disabled={hit.similarAvailable !== true}
                                title={hit.similarAvailable === true ? copy.findSimilar : copy.similarDisabled}
                                aria-label={hit.rank >= 1 ? copy.findSimilarNamed(hit.rank) : copy.findSimilar}
                            >
                                <span className='material-icons' aria-hidden='true'>image_search</span>
                                <span className='evsSimilarLabel'>{copy.findSimilar}</span>
                            </button>
                        )}
                        {mse === true && (
                            <button type='button' className='evsIconButton' onClick={fullscreen} disabled={!playing} title={copy.fullscreen} aria-label={copy.fullscreen}>
                                <span className='material-icons' aria-hidden='true'>fullscreen</span>
                            </button>
                        )}
                        {mse === false && (
                            <button type='button' className='emby-button raised evsNative' onClick={play}>
                                {copy.openNative}
                            </button>
                        )}
                    </span>
                </div>
                <h3 className='evsNowTitle'>{title}</h3>
                <p className='evsNowTime'>{hit.range}{hit.partial ? ` · ${copy.partialItem}` : ''}</p>
                {hit.transcript && <p className='evsNowQuote'>{hit.transcript}</p>}
                {mse === null && <p className='evsNote'>{copy.checkingPlayer}</p>}
                {mse === false && <p className='evsNote'>{copy.playerUnsupported}</p>}
            </div>
        </>
    );
};

export default MomentStage;
