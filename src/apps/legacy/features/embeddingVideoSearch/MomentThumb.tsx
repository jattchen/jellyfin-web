import React, { type FC, type ReactNode } from 'react';

import type { ThumbState } from './types';

interface MomentThumbProps {
    state?: ThumbState
    time: string
    alt?: string
    missingText: string
    className?: string
    children?: ReactNode
}

/** Real position frame, or an honest placeholder; never the film poster. */
const MomentThumb: FC<MomentThumbProps> = ({ state, time, alt = '', missingText, className, children }) => {
    const missing = state?.status === 'none' || state?.status === 'failed' || state?.status === 'busy';
    return (
        <span className={className ? `evsThumb ${className}` : 'evsThumb'}>
            {state?.status === 'image' ? (
                <img className='evsThumbImg' src={state.url} alt={alt} draggable={false} />
            ) : (
                <span className={missing ? 'evsThumbEmpty' : 'evsThumbEmpty is-loading'} title={missing ? missingText : undefined}>
                    {missing && <span className='material-icons evsThumbIcon' aria-hidden='true'>hide_image</span>}
                </span>
            )}
            <span className='evsThumbTime'>{time}</span>
            {children}
        </span>
    );
};

export default MomentThumb;
