import React, { type FC, useCallback, useEffect, useState } from 'react';

import type { SegmentCopy } from './copy';
import MomentThumb from './MomentThumb';
import { formatTicks, layoutTimeline, playheadRatio } from './presentation';
import type { RankedHit, ThumbState } from './types';

/** Mark head width in px; lanes are recomputed from the real track width. */
const MARK_PX = 28;
const LANE_REM = 2.1;
const HEAD_REM = 1.75;
const RAIL_REM = 0.65;
const TRACK_PAD_REM = 1.1;

interface MomentTimelineProps {
    title: string
    hits: RankedHit[]
    durationTicks?: number
    playheadTicks?: number
    currentId?: string
    thumbs: ReadonlyMap<string, ThumbState>
    copy: SegmentCopy
    onPlay: (segmentId: string) => void
    onPreview: (segmentId: string) => void
}

function useTrackWidth() {
    const [node, setNode] = useState<HTMLDivElement | null>(null);
    const [width, setWidth] = useState(0);
    useEffect(() => {
        if (!node) {
            return undefined;
        }

        setWidth(node.clientWidth);
        if (typeof ResizeObserver === 'undefined') {
            return undefined;
        }

        // eslint-disable-next-line compat/compat -- feature-detected above; old browsers keep the fallback gap
        const observer = new ResizeObserver(() => setWidth(node.clientWidth));
        observer.observe(node);
        return () => observer.disconnect();
    }, [node]);
    return [setNode, width] as const;
}

interface MarkProps {
    hit: RankedHit
    left: number
    width: number
    lane: number
    stem: number
    current: boolean
    label: string
    onPlay: (segmentId: string) => void
    onPreview: (segmentId: string) => void
    onTip: (segmentId: string | undefined) => void
}

const Mark: FC<MarkProps> = ({ hit, left, width, lane, stem, current, label, onPlay, onPreview, onTip }) => {
    const show = useCallback(() => {
        onPreview(hit.segmentId);
        onTip(hit.segmentId);
    }, [hit.segmentId, onPreview, onTip]);
    const hide = useCallback(() => onTip(undefined), [onTip]);
    const play = useCallback(() => onPlay(hit.segmentId), [hit.segmentId, onPlay]);

    return (
        <>
            <span
                className={current ? 'evsBand is-current' : 'evsBand'}
                style={{ left: `${left * 100}%`, width: `max(3px, ${width * 100}%)` }}
            />
            <button
                type='button'
                className={current ? 'evsMark is-current' : 'evsMark'}
                style={{
                    left: `min(${left * 100}%, calc(100% - ${HEAD_REM}rem))`,
                    top: `${lane * LANE_REM}rem`,
                    ['--evs-stem' as string]: `${stem}rem`
                }}
                aria-label={label}
                aria-current={current ? 'true' : undefined}
                onClick={play}
                onFocus={show}
                onBlur={hide}
                onPointerEnter={show}
                onPointerLeave={hide}
            >
                {hit.rank}
            </button>
        </>
    );
};

const MomentTimeline: FC<MomentTimelineProps> = ({
    title,
    hits,
    durationTicks,
    playheadTicks,
    currentId,
    thumbs,
    copy,
    onPlay,
    onPreview
}) => {
    const [trackRef, trackWidth] = useTrackWidth();
    const [tipId, setTipId] = useState<string | undefined>(undefined);
    if (!durationTicks) {
        return <p className='evsTimelineUnknown'>{copy.timelineUnknown}</p>;
    }

    const minGap = trackWidth > 0 ? (MARK_PX + 4) / trackWidth : 0.06;
    const { marks, lanes } = layoutTimeline(hits, durationTicks, 0.004, minGap);
    const playhead = playheadRatio(playheadTicks ?? Number.NaN, durationTicks);
    const trackRem = lanes * LANE_REM + TRACK_PAD_REM;
    const tip = tipId ? marks.find(mark => mark.hit.segmentId === tipId) : undefined;
    const tipThumb = tip ? thumbs.get(tip.hit.segmentId) : undefined;

    return (
        <div className='evsTimeline'>
            <div className='evsTimelineHead'>
                <span className='evsTimelineTitle'>{title}</span>
                <span className='evsTimelineLength'>{formatTicks(durationTicks)}</span>
            </div>
            <div
                ref={trackRef}
                className='evsTrack'
                role='group'
                aria-label={copy.timeline(title)}
                style={{ height: `${trackRem}rem` }}
            >
                <span className='evsTrackRail' />
                {playhead !== undefined && (
                    <>
                        <span className='evsTrackPlayed' style={{ width: `${playhead * 100}%` }} />
                        <span className='evsPlayhead' style={{ left: `${playhead * 100}%` }} />
                    </>
                )}
                {marks.map(({ hit, left, width, lane }) => (
                    <Mark
                        key={hit.segmentId}
                        hit={hit}
                        left={left}
                        width={width}
                        lane={lanes - 1 - lane}
                        stem={trackRem - RAIL_REM - ((lanes - 1 - lane) * LANE_REM + HEAD_REM)}
                        current={hit.segmentId === currentId}
                        label={`${copy.rank(hit.rank)}，${copy.playNamed(title, hit.range, hit.partial)}`}
                        onPlay={onPlay}
                        onPreview={onPreview}
                        onTip={setTipId}
                    />
                ))}
                {tip && (
                    <span
                        className='evsTip'
                        style={{ left: `clamp(0px, calc(${tip.left * 100}% - 6rem), calc(100% - 12rem))` }}
                        aria-hidden='true'
                    >
                        <MomentThumb state={tipThumb} time={formatTicks(tip.hit.startTicks)} missingText={copy.thumbMissing} />
                        <span className='evsTipText'>
                            <span className='evsTime'>{copy.rank(tip.hit.rank)} · {tip.hit.range}</span>
                            {tip.hit.transcript && <span className='evsQuote'>{tip.hit.transcript}</span>}
                        </span>
                    </span>
                )}
            </div>
        </div>
    );
};

export default MomentTimeline;
