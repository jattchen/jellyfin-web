import { bindingAgrees } from './binding';
import { sameGuid } from './guid';
import { isAbortError } from './transport';
import type {
    PlayResult,
    SearchHitModel,
    SegmentDetailModel
} from './types';
import type { ItemDto } from 'types/base/models/item-dto';

export interface NativePlayOptions {
    items: ItemDto[]
    startPositionTicks: number
    mediaSourceId: string
}

export function hasMediaSource(ids: readonly string[], expected: string): boolean {
    if (expected.length === 0) {
        return false;
    }

    return ids.includes(expected);
}

export function itemMediaSourceIds(item: ItemDto): string[] {
    const sources = item.MediaSources ?? [];
    const ids: string[] = [];
    for (const source of sources) {
        if (typeof source.Id === 'string' && source.Id.length > 0) {
            ids.push(source.Id);
        }
    }

    return ids;
}

export class IncompatiblePlayback extends Error {
    constructor() {
        super('binding');
        this.name = 'IncompatiblePlayback';
    }
}

/**
 * Identity, media source, recorded window, and the shared binding stamp.
 * A missing stamp does not agree. Segment detail score stays 0 and is not compared.
 */
export function segmentAgrees(clicked: SearchHitModel, fresh: SegmentDetailModel): boolean {
    return sameGuid(clicked.itemId, fresh.itemId)
        && sameGuid(clicked.segmentId, fresh.segmentId)
        && hasMediaSource([fresh.mediaSourceId], clicked.mediaSourceId)
        && clicked.startTicks === fresh.startTicks
        && clicked.endTicks === fresh.endTicks
        && bindingAgrees(clicked.bindingVersion, fresh.bindingVersion)
        && (!clicked.representation || clicked.representation === fresh.representation)
        && (!clicked.candidateId || clicked.candidateId === fresh.candidateId);
}

/** Keep the search hit, including its original score, after the detail check passes. */
export function confirmedHit(clicked: SearchHitModel, fresh: SegmentDetailModel): SearchHitModel | undefined {
    if (!segmentAgrees(clicked, fresh)) {
        return undefined;
    }

    return clicked;
}

export function nativePlayRequest(item: ItemDto, hit: SearchHitModel): NativePlayOptions {
    return {
        items: [item],
        startPositionTicks: hit.startTicks,
        mediaSourceId: hit.mediaSourceId
    };
}

export interface PlayInput {
    clicked: SearchHitModel
    signal: AbortSignal
    stillCurrent: () => boolean
    fetchSegment: (segmentId: string, signal: AbortSignal) => Promise<
        | { kind: 'hit'; hit: SegmentDetailModel }
        | { kind: 'gone'; reason: 'stale' | 'incompatible' | 'notFound' | 'denied' | 'transport' }
    >
    fetchItem: (itemId: string, signal: AbortSignal) => Promise<ItemDto | null>
    play: (options: NativePlayOptions) => Promise<unknown>
}

function interrupted(input: PlayInput): boolean {
    return input.signal.aborted || !input.stillCurrent();
}

function stopped(): PlayResult {
    return { ok: false, reason: 'interrupted' };
}

async function readPlayableSegment(input: PlayInput): Promise<PlayResult | SearchHitModel> {
    let segment: Awaited<ReturnType<PlayInput['fetchSegment']>>;
    try {
        segment = await input.fetchSegment(input.clicked.segmentId, input.signal);
    } catch (error) {
        if (isAbortError(error) || interrupted(input)) {
            return stopped();
        }

        return { ok: false, reason: 'transport' };
    }

    if (interrupted(input)) {
        return stopped();
    }

    if (segment.kind !== 'hit') {
        return { ok: false, reason: segment.reason };
    }

    if (!bindingAgrees(input.clicked.bindingVersion, segment.hit.bindingVersion)) {
        return { ok: false, reason: 'binding' };
    }

    const confirmed = confirmedHit(input.clicked, segment.hit);
    if (!confirmed) {
        return { ok: false, reason: 'mismatch' };
    }

    return confirmed;
}

async function readPlayableItem(input: PlayInput, confirmed: SearchHitModel): Promise<PlayResult | ItemDto> {
    let item: ItemDto | null;
    try {
        item = await input.fetchItem(confirmed.itemId, input.signal);
    } catch (error) {
        if (isAbortError(error) || interrupted(input)) {
            return stopped();
        }

        return { ok: false, reason: 'transport' };
    }

    if (interrupted(input)) {
        return stopped();
    }

    if (!item?.Id) {
        return { ok: false, reason: 'denied' };
    }

    if (!sameGuid(item.Id, confirmed.itemId) || !hasMediaSource(itemMediaSourceIds(item), confirmed.mediaSourceId)) {
        return { ok: false, reason: 'mismatch' };
    }

    return item;
}

function isRefusal(value: PlayResult | SearchHitModel | ItemDto): value is PlayResult {
    return 'ok' in value;
}

export async function playConfirmedSegment(input: PlayInput): Promise<PlayResult> {
    if (interrupted(input)) {
        return stopped();
    }

    const confirmed = await readPlayableSegment(input);
    if (isRefusal(confirmed)) {
        return confirmed;
    }

    const item = await readPlayableItem(input, confirmed);
    if (isRefusal(item) || interrupted(input)) {
        return isRefusal(item) ? item : stopped();
    }

    try {
        await input.play(nativePlayRequest(item, confirmed));
    } catch (error) {
        if (isAbortError(error) || interrupted(input)) {
            return stopped();
        }

        if (error instanceof IncompatiblePlayback) {
            return { ok: false, reason: 'binding' };
        }

        return { ok: false, reason: 'play-failed' };
    }

    return { ok: true };
}
