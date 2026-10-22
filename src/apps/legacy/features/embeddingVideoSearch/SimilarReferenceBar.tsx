import React, { type FC, useCallback } from 'react';

import type { SegmentCopy } from './copy';
import MomentThumb from './MomentThumb';
import { formatRange, formatTicks } from './presentation';
import { referenceComparisonText, type SimilarReference } from './similarSearch';
import type { ThumbState } from './types';

interface SimilarReferenceBarProps {
    reference: SimilarReference
    title: string
    thumb?: ThumbState
    copy: SegmentCopy
    onPlay: (segmentId: string) => void
}

const SimilarReferenceBar: FC<SimilarReferenceBarProps> = ({ reference, title, thumb, copy, onPlay }) => {
    const play = useCallback(() => {
        onPlay(reference.segmentId);
    }, [onPlay, reference.segmentId]);
    const comparison = referenceComparisonText(reference, copy.compareUsing);
    const range = formatRange(reference.startTicks, reference.endTicks);

    return (
        <div className='evsReference'>
            <span className='evsRefThumb'>
                <MomentThumb
                    state={thumb}
                    time={formatTicks(reference.startTicks)}
                    alt={title}
                    missingText={copy.thumbMissing}
                />
            </span>
            <div className='evsRefBody'>
                <p className='evsRefTitle'>
                    <span className='evsBadge'>{copy.referenceLabel}</span>
                    <span className='evsRefName'>{title}</span>
                </p>
                <p className='evsRefMeta'>
                    {range}
                    {' · '}
                    {copy.kind(reference.representation)}
                    {comparison && <> · <span className='evsRefCompare'>{comparison}</span></>}
                </p>
                <button type='button' className='evsRefPlay' onClick={play}>
                    {copy.playReference}
                </button>
            </div>
        </div>
    );
};

export default SimilarReferenceBar;
