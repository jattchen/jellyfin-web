import React, { type FC, useCallback } from 'react';

import type { SegmentCopy } from './copy';
import MomentThumb from './MomentThumb';
import { formatTicks, mergedRunText } from './presentation';
import type { RankedHit, ThumbState } from './types';

interface MomentRowProps {
    hit: RankedHit
    title: string
    tag: string
    thumb?: ThumbState
    current: boolean
    busy: boolean
    copy: SegmentCopy
    onPlay: (segmentId: string) => void
    onPreview: (segmentId: string) => void
    /** Set only when the server declared similar-segments-v1. */
    onFindSimilar?: (segmentId: string) => void
}

const MomentRow: FC<MomentRowProps> = ({ hit, title, tag, thumb, current, busy, copy, onPlay, onPreview, onFindSimilar }) => {
    const top = hit.rank === 1;
    const onClick = useCallback(() => {
        onPlay(hit.segmentId);
    }, [hit.segmentId, onPlay]);
    const onFocus = useCallback(() => {
        onPreview(hit.segmentId);
    }, [hit.segmentId, onPreview]);
    const findSimilar = useCallback(() => {
        onFindSimilar?.(hit.segmentId);
    }, [hit.segmentId, onFindSimilar]);
    const quoteId = `evs-quote-${hit.segmentId}`;
    const classes = ['evsRow'];
    if (top) classes.push('evsRow-top');
    if (current) classes.push('is-current');
    const meta = [tag, copy.kind(hit.representation)];
    if (hit.partial) meta.push(copy.partialItem);
    const runNote = mergedRunText(hit, copy.merged);
    const accessible = `${copy.rank(hit.rank)}，${copy.playNamed(title, hit.range, hit.partial)}`;
    const similarDisabled = hit.similarAvailable !== true;
    const playButton = (
        <button
            type='button'
            className={classes.join(' ')}
            onClick={onClick}
            onFocus={onFocus}
            onPointerEnter={onFocus}
            aria-current={current ? 'true' : undefined}
            aria-busy={busy}
            aria-label={runNote ? `${accessible}，${runNote}` : accessible}
            aria-describedby={hit.transcript ? quoteId : undefined}
        >
            <span className='evsRank' aria-hidden='true'>{hit.rank}</span>
            <MomentThumb
                state={thumb}
                time={formatTicks(hit.startTicks)}
                missingText={copy.thumbMissing}
                className={top ? 'evsThumb-top' : undefined}
            >
                {(current || busy) && (
                    <span className='evsThumbLive' aria-hidden='true'>
                        <span className='material-icons'>{busy ? 'hourglass_empty' : 'graphic_eq'}</span>
                    </span>
                )}
            </MomentThumb>
            <span className='evsRowBody'>
                <span className='evsRowHead'>
                    {top && <span className='evsBadge'>{copy.best}</span>}
                    {current && <span className='evsBadge evsBadge-live'>{copy.nowPlaying}</span>}
                    <span className='evsTime'>{hit.range}</span>
                </span>
                {hit.transcript && <span id={quoteId} className='evsQuote'>{hit.transcript}</span>}
                <span className='evsMeta'>
                    {meta.join(' · ')}
                    {runNote && <> · <span className='evsRunNote'>{runNote}</span></>}
                </span>
            </span>
        </button>
    );

    return (
        <li className='evsItem'>
            <div className={onFindSimilar ? 'evsItemRow has-similar' : 'evsItemRow'}>
                {playButton}
                {onFindSimilar && (
                    <button
                        type='button'
                        id={`evs-similar-${hit.segmentId}`}
                        className='evsSimilar'
                        onClick={findSimilar}
                        disabled={similarDisabled}
                        title={similarDisabled ? copy.similarDisabled : copy.findSimilar}
                        aria-label={copy.findSimilarNamed(hit.rank)}
                    >
                        <span className='material-icons' aria-hidden='true'>image_search</span>
                        <span className='evsSimilarLabel'>{copy.findSimilar}</span>
                    </button>
                )}
            </div>
        </li>
    );
};

export default MomentRow;
