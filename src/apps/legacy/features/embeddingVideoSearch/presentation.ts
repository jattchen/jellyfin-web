import { HITS_PER_VIDEO, TICKS_PER_SECOND, VIDEO_LIMIT } from './constants';
import { guidKey } from './guid';
import type { DisplayHit, NoticeCode, SearchHitModel } from './types';

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
        transcript: hit.transcript
    };
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

export function groupDisplayedHits(hits: readonly DisplayHit[]): { itemId: string; hits: DisplayHit[] }[] {
    const groups: { itemId: string; hits: DisplayHit[] }[] = [];
    const index = new Map<string, { itemId: string; hits: DisplayHit[] }>();
    for (const hit of hits) {
        const key = guidKey(hit.itemId);
        if (!key) {
            continue;
        }

        let group = index.get(key);
        if (!group) {
            group = { itemId: hit.itemId, hits: [] };
            index.set(key, group);
            groups.push(group);
        }

        group.hits.push(hit);
    }

    return groups;
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
