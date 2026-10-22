import type { Api } from '@jellyfin/sdk';

import { SEARCH_TIMEOUT_MS, SEGMENT_TIMEOUT_MS, segmentPath } from './constants';
import { guidKey } from './guid';
import { loadOfficialItem } from './items';
import { parseSegmentDetail } from './parse';
import { partitionHits } from './presentation';
import { applyItemLoads } from './results';
import { classifySegment } from './searchRun';
import {
    classifySimilarHttp,
    classifySimilarTransport,
    parseSimilarBody,
    SIMILAR_PATH,
    similarRequestBody,
    type ParsedSimilarBody,
    type SimilarFailure
} from './similarSearch';
import { createSdkTransport, isAbortError, type PluginTransport, type TransportResult } from './transport';
import type { ItemCard, ItemLoad, SearchHitModel } from './types';
import { acceptsQuery } from './viewState';

export interface SimilarExecution {
    api: Api
    userId: string
    segmentId: string
    expectedBindingVersion?: string
    parentId?: string
    clientQueryId: string
    signal: AbortSignal
    /** Known when the click already has the moment. Refresh leaves this empty and reads the segment. */
    known?: { itemId: string; mediaSourceId: string }
    transport?: PluginTransport
    loadItem?: (itemId: string, signal: AbortSignal) => Promise<ItemLoad>
}

export type SimilarExecutionResult =
    | { kind: 'aborted' }
    | {
        kind: 'failure'
        failure: SimilarFailure
        itemId?: string
        mediaSourceId?: string
    }
    | { kind: 'ready'; body: ParsedSimilarBody; cards: Map<string, ItemCard> };

function failureFromSegment(status: number, data: unknown): SimilarFailure {
    const read = classifySegment(status, data);
    if (read.kind === 'hit') {
        return { kind: 'stay', problem: 'transport' };
    }

    if (read.reason === 'notFound' || read.reason === 'denied') {
        return { kind: 'return', notice: 'gone', withdraw: 'item' };
    }

    if (read.reason === 'stale') {
        return { kind: 'return', notice: 'gone', withdraw: 'media' };
    }

    if (read.reason === 'incompatible') {
        return { kind: 'return', notice: 'gone', withdraw: 'none', problem: 'incompatible' };
    }

    return { kind: 'stay', problem: 'transport' };
}

async function loadCards(
    hits: readonly SearchHitModel[],
    referenceItemId: string,
    signal: AbortSignal,
    loadItem: (itemId: string, signal: AbortSignal) => Promise<ItemLoad>
): Promise<{ loads: Map<string, ItemLoad>; cards: Map<string, ItemCard> }> {
    const loads = new Map<string, ItemLoad>();
    const cards = new Map<string, ItemCard>();
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const itemId of [referenceItemId, ...hits.map(hit => hit.itemId)]) {
        const key = guidKey(itemId);
        if (!key || seen.has(key)) {
            continue;
        }

        seen.add(key);
        ids.push(itemId);
    }

    await Promise.all(ids.map(async (itemId) => {
        const load = await loadItem(itemId, signal);
        const key = guidKey(itemId);
        if (!key) {
            return;
        }

        loads.set(key, load);
        if (load.status === 'ready') {
            cards.set(key, load.card);
        }
    }));
    return { loads, cards };
}

interface KnownMedia {
    itemId?: string
    mediaSourceId?: string
}

type BindingResolution =
    | { kind: 'aborted' }
    | { kind: 'failure'; failure: SimilarFailure; itemId?: string; mediaSourceId?: string }
    | { kind: 'ready'; binding: string; itemId?: string; mediaSourceId?: string };

function stopped(read: TransportResult, signal: AbortSignal): boolean {
    return read.kind === 'aborted' || signal.aborted;
}

function transportStay(
    read: TransportResult,
    known: KnownMedia
): Extract<SimilarExecutionResult, { kind: 'failure' }> | undefined {
    if (read.kind !== 'timeout' && read.kind !== 'blocked' && read.kind !== 'network') {
        return undefined;
    }

    return {
        kind: 'failure',
        failure: classifySimilarTransport(read.kind),
        itemId: known.itemId,
        mediaSourceId: known.mediaSourceId
    };
}

async function readSimilarBinding(
    transport: PluginTransport,
    segmentId: string,
    signal: AbortSignal,
    known: KnownMedia
): Promise<BindingResolution> {
    const read = await transport.request({
        method: 'GET',
        path: segmentPath(segmentId),
        timeoutMs: SEGMENT_TIMEOUT_MS,
        signal
    });
    if (stopped(read, signal)) {
        return { kind: 'aborted' };
    }

    const stayed = transportStay(read, known);
    if (stayed) {
        return stayed;
    }

    if (read.kind !== 'response' || read.status !== 200) {
        const status = read.kind === 'response' ? read.status : 0;
        const data = read.kind === 'response' ? read.data : undefined;
        return {
            kind: 'failure',
            failure: failureFromSegment(status, data),
            itemId: known.itemId,
            mediaSourceId: known.mediaSourceId
        };
    }

    const detail = parseSegmentDetail(read.data);
    if (!detail) {
        return {
            kind: 'failure',
            failure: { kind: 'stay', problem: 'contract' },
            itemId: known.itemId,
            mediaSourceId: known.mediaSourceId
        };
    }

    if (!detail.bindingVersion) {
        return {
            kind: 'failure',
            failure: { kind: 'return', notice: 'unavailable', withdraw: 'none' },
            itemId: detail.itemId,
            mediaSourceId: detail.mediaSourceId
        };
    }

    return {
        kind: 'ready',
        binding: detail.bindingVersion,
        itemId: detail.itemId,
        mediaSourceId: detail.mediaSourceId
    };
}

async function loadSimilarBody(
    input: SimilarExecution,
    transport: PluginTransport,
    loadItem: NonNullable<SimilarExecution['loadItem']>,
    binding: string,
    known: KnownMedia
): Promise<SimilarExecutionResult> {
    const posted = await transport.request({
        method: 'POST',
        path: SIMILAR_PATH,
        body: similarRequestBody({
            segmentId: input.segmentId,
            expectedBindingVersion: binding,
            parentId: input.parentId,
            clientQueryId: input.clientQueryId
        }),
        timeoutMs: SEARCH_TIMEOUT_MS,
        signal: input.signal
    });
    if (stopped(posted, input.signal)) {
        return { kind: 'aborted' };
    }

    const stayed = transportStay(posted, known);
    if (stayed) {
        return stayed;
    }

    if (posted.kind !== 'response' || posted.status !== 200) {
        const status = posted.kind === 'response' ? posted.status : 0;
        const data = posted.kind === 'response' ? posted.data : undefined;
        return {
            kind: 'failure',
            failure: classifySimilarHttp(status, data),
            itemId: known.itemId,
            mediaSourceId: known.mediaSourceId
        };
    }

    const body = parseSimilarBody(posted.data);
    if (!body || !acceptsQuery({
        expectedClientQueryId: input.clientQueryId,
        responseClientQueryId: body.clientQueryId
    })) {
        return {
            kind: 'failure',
            failure: { kind: 'stay', problem: 'contract' },
            itemId: known.itemId,
            mediaSourceId: known.mediaSourceId
        };
    }

    const parts = partitionHits(body.hits);
    const loaded = await loadCards(
        [...parts.related, ...parts.weak],
        body.reference.itemId,
        input.signal,
        loadItem
    );
    if (input.signal.aborted) {
        return { kind: 'aborted' };
    }

    const visible = applyItemLoads({
        phase: 'ready',
        clientQueryId: body.clientQueryId ?? input.clientQueryId,
        availability: body.hits.length > 0 ? 'available' : 'empty',
        indexComplete: body.indexComplete,
        related: parts.related,
        weak: parts.weak,
        notices: [],
        collapsedRuns: true,
        similarSegments: true
    }, loaded.loads);
    return {
        kind: 'ready',
        body: {
            ...body,
            hits: [...visible.related, ...visible.weak] as ParsedSimilarBody['hits']
        },
        cards: loaded.cards
    };
}

export async function executeSimilarSearch(input: SimilarExecution): Promise<SimilarExecutionResult> {
    const transport = input.transport ?? createSdkTransport(input.api);
    const loadItem = input.loadItem ?? ((itemId, signal) => loadOfficialItem(input.api, input.userId, itemId, signal));
    let known: KnownMedia = {
        itemId: input.known?.itemId,
        mediaSourceId: input.known?.mediaSourceId
    };
    let binding = input.expectedBindingVersion;
    try {
        if (!binding) {
            const resolved = await readSimilarBinding(transport, input.segmentId, input.signal, known);
            if (resolved.kind !== 'ready') {
                return resolved;
            }

            binding = resolved.binding;
            known = { itemId: resolved.itemId, mediaSourceId: resolved.mediaSourceId };
        }

        const loaded = await loadSimilarBody(input, transport, loadItem, binding, known);
        return loaded;
    } catch (error) {
        if (isAbortError(error) || input.signal.aborted) {
            return { kind: 'aborted' };
        }

        return {
            kind: 'failure',
            failure: classifySimilarTransport('network'),
            itemId: known.itemId,
            mediaSourceId: known.mediaSourceId
        };
    }
}
