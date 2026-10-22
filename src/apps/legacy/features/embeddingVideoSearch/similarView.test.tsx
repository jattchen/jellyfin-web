import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TICKS_PER_SECOND } from './constants';
import { segmentCopy } from './copy';
import MomentRow from './MomentRow';
import MomentStage from './MomentStage';
import MomentTimeline from './MomentTimeline';
import SimilarReferenceBar from './SimilarReferenceBar';
import { hitBand } from './presentation';
import type { SimilarReference } from './similarSearch';
import type { RankedHit } from './types';

const SECOND = TICKS_PER_SECOND;
const copy = segmentCopy('zh-CN');

function noop() {
    return undefined;
}

function rowHit(similarAvailable: boolean): RankedHit {
    return {
        segmentId: 'abcdef01-2345-6789-abcd-ef0123456789',
        itemId: '01234567-89ab-cdef-0123-456789abcdef',
        range: '0:10–0:22',
        partial: false,
        startTicks: 10 * SECOND,
        endTicks: 22 * SECOND,
        score: 0.91,
        rank: 2,
        representation: 'jointAudioVideo',
        similarAvailable,
        run: { startTicks: 80 * SECOND, endTicks: 112 * SECOND, memberCount: 3 }
    };
}

const reference: SimilarReference = {
    segmentId: 'abcdef01-2345-6789-abcd-ef0123456789',
    itemId: '01234567-89ab-cdef-0123-456789abcdef',
    mediaSourceId: 'source-a',
    startTicks: 9 * SECOND,
    endTicks: 14 * SECOND,
    representation: 'transcriptText',
    bindingVersion: '0123456789abcdef'.repeat(4),
    source: {
        segmentId: 'abcdef01-2345-6789-abcd-ef0123456780',
        startTicks: 10 * SECOND,
        endTicks: 22 * SECOND,
        representation: 'jointAudioVideo',
        bindingVersion: 'fedcba9876543210'.repeat(4)
    },
    excluded: { startTicks: 9 * SECOND, endTicks: 22 * SECOND }
};

describe('similar moment controls', () => {
    it('places play and find-similar as sibling buttons and names the merged run without a score', () => {
        const row = renderToStaticMarkup(
            <MomentRow
                hit={rowHit(true)}
                title='样片'
                tag='同一部其他位置'
                current={false}
                busy={false}
                copy={copy}
                onPlay={noop}
                onPreview={noop}
                onFindSimilar={noop}
            />
        );
        expect(row.match(/<button/g)).toHaveLength(2);
        expect(row).toContain('</button><button');
        expect(row).toContain('找与第 2 名相似的片段');
        expect(row).toContain('image_search');
        expect(row).toContain('已合并相连的 3 段 · 1:20–1:52');
        expect(row).not.toContain('0.91');
        expect(row).not.toContain('<button type="button" class="evsRow" disabled');
    });

    it('disables find-similar when the moment has no picture and sound', () => {
        const row = renderToStaticMarkup(
            <MomentRow
                hit={rowHit(false)}
                title='样片'
                tag='S1:E2'
                current={false}
                busy={false}
                copy={copy}
                onPlay={noop}
                onPreview={noop}
                onFindSimilar={noop}
            />
        );
        expect(row).toContain('disabled=""');
        expect(row).toContain('这段没有可用的画面与声音');
        const similarButton = row.slice(row.indexOf('evsSimilar'));
        expect(similarButton.startsWith('evsSimilar" disabled=""')).toBe(true);
    });

    it('puts find-similar before fullscreen for the moment on stage', () => {
        const stage = renderToStaticMarkup(
            <MomentStage
                hit={rowHit(true)}
                title='样片'
                playing={false}
                busy={false}
                mse
                videoRef={{ current: null }}
                copy={copy}
                onPlay={noop}
                onFindSimilar={noop}
            />
        );
        expect(stage.indexOf('image_search')).toBeGreaterThan(-1);
        expect(stage.indexOf('image_search')).toBeLessThan(stage.indexOf('fullscreen'));
        expect(stage).toContain('找与第 2 名相似的片段');
    });

    it('shows the joint window that was actually compared and a hollow reference mark', () => {
        const bar = renderToStaticMarkup(
            <SimilarReferenceBar
                reference={reference}
                title='雨夜'
                copy={copy}
                onPlay={noop}
            />
        );
        expect(bar).toContain('0:09–0:14');
        expect(bar).toContain('按 0:10–0:22 的画面与声音比较');
        expect(bar).toContain('播放参照');
        expect(bar).not.toContain('0.91');

        const duration = 120 * SECOND;
        const band = hitBand(reference.source.startTicks, reference.source.endTicks, duration);
        const timeline = renderToStaticMarkup(
            <MomentTimeline
                title='雨夜'
                hits={[rowHit(true)]}
                durationTicks={duration}
                thumbs={new Map()}
                copy={copy}
                onPlay={noop}
                onPreview={noop}
                referenceMark={band ? { ...band, label: copy.referenceMark } : undefined}
            />
        );
        expect(timeline).toContain('evsRefMark');
        expect(timeline).toContain('>参照<');
        expect(timeline).toContain('evsRunBand');
    });
});
