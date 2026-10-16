import { guidKey, sameGuid } from './guid';
import { noticesFor } from './presentation';
import type {
    ItemLoad,
    NoticeCode,
    PlayResult,
    ReadySegmentView,
    SearchHitModel,
    SegmentViewState
} from './types';

function withLoadNotice(notices: NoticeCode[], failed: boolean, indexComplete: boolean): NoticeCode[] {
    if (!failed) {
        return notices;
    }

    const next = notices.filter(notice => notice !== 'no-match' && notice !== 'no-match-partial');
    if (!indexComplete && !next.includes('partial-index')) {
        next.unshift('partial-index');
    }

    if (!next.includes('load-incomplete')) {
        next.push('load-incomplete');
    }

    return next;
}

function hiddenNotices(indexComplete: boolean): NoticeCode[] {
    if (indexComplete) {
        return ['results-hidden'];
    }

    return ['results-hidden', 'partial-index'];
}

export function applyItemLoads(
    view: ReadySegmentView,
    loads: ReadonlyMap<string, ItemLoad>
): ReadySegmentView {
    const related: SearchHitModel[] = [];
    const weak: SearchHitModel[] = [];
    let failed = false;
    let removed = false;

    const keep = (hit: SearchHitModel) => {
        const key = guidKey(hit.itemId) ?? '';
        const load = loads.get(key);
        if (!load || load.status === 'failed') {
            failed = true;
            return true;
        }

        if (load.status === 'inaccessible') {
            removed = true;
            return false;
        }

        return true;
    };

    for (const hit of view.related) {
        if (keep(hit)) {
            related.push(hit);
        }
    }

    for (const hit of view.weak) {
        if (keep(hit)) {
            weak.push(hit);
        }
    }

    const kept = related.length + weak.length;
    const original = view.related.length + view.weak.length;
    let notices = noticesFor({
        availability: view.availability,
        indexComplete: view.indexComplete,
        relatedCount: related.length
    });
    if (removed && kept === 0 && original > 0 && !failed) {
        notices = hiddenNotices(view.indexComplete);
    } else {
        notices = withLoadNotice(notices, failed, view.indexComplete);
    }

    return {
        ...view,
        related,
        weak,
        notices
    };
}

function dropHits(
    view: ReadySegmentView,
    remove: (hit: SearchHitModel) => boolean
): ReadySegmentView {
    const related = view.related.filter(hit => !remove(hit));
    const weak = view.weak.filter(hit => !remove(hit));
    const hadHits = view.related.length + view.weak.length > 0;
    const kept = related.length + weak.length;
    let notices = noticesFor({
        availability: view.availability,
        indexComplete: view.indexComplete,
        relatedCount: related.length
    });
    if (view.notices.includes('load-incomplete')) {
        notices = withLoadNotice(notices, true, view.indexComplete);
    } else if (hadHits && kept === 0) {
        notices = hiddenNotices(view.indexComplete);
    }

    return {
        ...view,
        related,
        weak,
        notices
    };
}

export function applyPlayOutcome(
    view: SegmentViewState,
    hit: SearchHitModel,
    result: PlayResult
): SegmentViewState {
    if (result.ok || view.phase !== 'ready') {
        return view;
    }

    if (result.reason === 'incompatible') {
        return { phase: 'problem', problem: 'incompatible' };
    }

    // The plugin also returns 404 for revoked access, so withdraw every cached
    // window of this item rather than leaving its other timestamps visible.
    if (result.reason === 'denied' || result.reason === 'notFound') {
        return dropHits(view, entry => sameGuid(entry.itemId, hit.itemId));
    }

    if (result.reason === 'stale') {
        return dropHits(view, entry => sameGuid(entry.itemId, hit.itemId)
            && entry.mediaSourceId === hit.mediaSourceId);
    }

    return view;
}
