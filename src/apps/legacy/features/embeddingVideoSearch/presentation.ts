import { HITS_PER_VIDEO, TICKS_PER_SECOND, TOP_VISIBLE, VIDEO_LIMIT } from './constants';
import { guidKey } from './guid';
import type { DisplayHit, NoticeCode, RankedHit, SearchHitModel } from './types';

export function formatTicks(ticks: number): string {
    const total = Math.floor(ticks / TICKS_PER_SECOND);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const secondText = String(seconds).padStart(2, '0');
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${secondText}`;
    }

    return `${minutes}:${secondText}`;
}

export function formatRange(startTicks: number, endTicks: number): string {
    return `${formatTicks(startTicks)}–${formatTicks(endTicks)}`;
}

export function toDisplayHit(hit: SearchHitModel): DisplayHit {
    return {
        segmentId: hit.segmentId,
        itemId: hit.itemId,
        range: formatRange(hit.startTicks, hit.endTicks),
        partial: !hit.indexComplete,
        startTicks: hit.startTicks,
        endTicks: hit.endTicks,
        transcript: hit.transcript,
        score: hit.score,
        representation: hit.representation
    };
}

/**
 * One list across films, highest reference score first. Ties keep server order,
 * and weak hits always follow every related hit.
 */
export function rankHits(related: readonly DisplayHit[], weak: readonly DisplayHit[] = []): RankedHit[] {
    const byScore = (list: readonly DisplayHit[]) => list
        .map((hit, index) => ({ hit, index }))
        .sort((a, b) => (b.hit.score - a.hit.score) || (a.index - b.index))
        .map(entry => entry.hit);
    const seen = new Set<string>();
    const ranked: RankedHit[] = [];
    for (const hit of [...byScore(related), ...byScore(weak)]) {
        const key = guidKey(hit.segmentId);
        if (!key || seen.has(key)) {
            continue;
        }

        seen.add(key);
        ranked.push({ ...hit, rank: ranked.length + 1 });
    }

    return ranked;
}

/** Cuts by position only; no score threshold decides what is hidden. */
export function foldRanked<T>(ranked: readonly T[], top: number = TOP_VISIBLE): { shown: T[]; folded: T[] } {
    const count = Math.max(1, Math.floor(top));
    return {
        shown: ranked.slice(0, count),
        folded: ranked.slice(count)
    };
}

export function hitsForFilm<T extends { itemId: string }>(ranked: readonly T[], itemId: string | undefined): T[] {
    const key = guidKey(itemId ?? '');
    if (!key) {
        return [];
    }

    return ranked.filter(hit => guidKey(hit.itemId) === key);
}

/** Short film label for a row: the episode code, with the series only when results span series. */
export function filmTag(
    card: { title: string; series?: string; episodeCode?: string } | undefined,
    multiSeries: boolean,
    fallback: string
): string {
    if (card?.episodeCode) {
        return multiSeries && card.series ? `${card.series} ${card.episodeCode}` : card.episodeCode;
    }

    return card?.title || fallback;
}

export interface TimelineMarkLayout<T> {
    hit: T
    left: number
    width: number
    lane: number
}

/** Places marks on as few lanes as possible while keeping every pointer target reachable. */
export function layoutTimeline<T extends { startTicks: number; endTicks: number }>(
    hits: readonly T[],
    durationTicks: number | undefined,
    minWidth = 0.012,
    minGap = 0.028
): { marks: TimelineMarkLayout<T>[]; lanes: number } {
    const bands = hits.flatMap(hit => {
        const band = hitBand(hit.startTicks, hit.endTicks, durationTicks);
        return band ? [{ hit, band }] : [];
    }).sort((a, b) => a.band.left - b.band.left);
    const laneEnds: number[] = [];
    const marks = bands.map(({ hit, band }) => {
        const width = Math.max(band.width, minWidth);
        const left = Math.min(band.left, 1 - width);
        let lane = laneEnds.findIndex(end => end <= left);
        if (lane < 0) {
            lane = laneEnds.length;
        }

        laneEnds[lane] = left + Math.max(width, minGap);
        return { hit, left, width, lane };
    });
    return { marks, lanes: Math.max(1, laneEnds.length) };
}

export interface FilmGroup {
    itemId: string
    hits: SearchHitModel[]
}

/** First-seen film order. Hit count does not move a film earlier. */
export function groupHitsByVideo(hits: readonly SearchHitModel[]): FilmGroup[] {
    const groups: FilmGroup[] = [];
    const index = new Map<string, FilmGroup>();
    for (const hit of hits) {
        const key = guidKey(hit.itemId);
        if (!key) {
            continue;
        }

        let group = index.get(key);
        if (!group) {
            if (groups.length >= VIDEO_LIMIT) {
                continue;
            }

            group = { itemId: hit.itemId, hits: [] };
            index.set(key, group);
            groups.push(group);
        }

        if (group.hits.length < HITS_PER_VIDEO) {
            group.hits.push(hit);
        }
    }

    return groups;
}

export function partitionHits(hits: readonly SearchHitModel[]): { related: SearchHitModel[]; weak: SearchHitModel[] } {
    const related: SearchHitModel[] = [];
    const weak: SearchHitModel[] = [];
    for (const hit of hits) {
        if (hit.quality === 'weak') {
            weak.push(hit);
        } else {
            related.push(hit);
        }
    }

    return {
        related: groupHitsByVideo(related).flatMap(group => group.hits),
        weak: groupHitsByVideo(weak).flatMap(group => group.hits)
    };
}

export function playheadRatio(currentTicks: number, durationTicks: number | undefined): number | undefined {
    if (durationTicks === undefined || !Number.isSafeInteger(durationTicks) || durationTicks <= 0 || !Number.isFinite(currentTicks)) {
        return undefined;
    }

    return Math.min(1, Math.max(0, currentTicks / durationTicks));
}

export function hitBand(
    startTicks: number,
    endTicks: number,
    durationTicks: number | undefined
): { left: number; width: number } | undefined {
    if (durationTicks === undefined || !Number.isSafeInteger(durationTicks) || durationTicks <= 0) {
        return undefined;
    }

    if (startTicks < 0 || endTicks <= startTicks || startTicks >= durationTicks) {
        return undefined;
    }

    const end = Math.min(endTicks, durationTicks);
    return {
        left: startTicks / durationTicks,
        width: (end - startTicks) / durationTicks
    };
}

export function noticesFor(input: {
    availability: 'available' | 'empty'
    indexComplete: boolean
    relatedCount: number
}): NoticeCode[] {
    if (input.availability === 'empty') {
        return [input.indexComplete ? 'nothing-searchable' : 'nothing-searchable-partial'];
    }

    if (input.relatedCount === 0) {
        return [input.indexComplete ? 'no-match' : 'no-match-partial'];
    }

    if (!input.indexComplete) {
        return ['partial-index'];
    }

    return [];
}

export function weakDisclosure(open: boolean, scopeChanged: boolean): boolean {
    if (scopeChanged) {
        return false;
    }

    return open;
}

export interface ItemNameSource {
    Name?: string | null
    SeriesName?: string | null
    ParentIndexNumber?: number | null
    IndexNumber?: number | null
}

function episodePrefix(season: number | null | undefined, episode: number | null | undefined): string {
    if (typeof season === 'number' && typeof episode === 'number') {
        return `${season}.${episode}`;
    }

    if (typeof episode === 'number') {
        return String(episode);
    }

    return '';
}

/** Compact episode code such as S1:E2, matching the official card wording. */
export function episodeCode(item: ItemNameSource | undefined): string | undefined {
    if (!item || typeof item.IndexNumber !== 'number') {
        return undefined;
    }

    if (typeof item.ParentIndexNumber === 'number') {
        return `S${item.ParentIndexNumber}:E${item.IndexNumber}`;
    }

    return `E${item.IndexNumber}`;
}

export function itemLabel(item: ItemNameSource | undefined, fallback: string): string {
    if (!item) {
        return fallback;
    }

    const name = item.Name?.trim() ?? '';
    const series = item.SeriesName?.trim() ?? '';
    const prefix = episodePrefix(item.ParentIndexNumber, item.IndexNumber);
    let title = name;
    if (prefix && name) {
        title = `${prefix} ${name}`;
    } else if (prefix) {
        title = prefix;
    }

    if (series && title) {
        return `${series} — ${title}`;
    }

    if (title) {
        return title;
    }

    if (series) {
        return series;
    }

    return fallback;
}
