import {
    CAPABILITIES_PATH,
    CAPABILITIES_TIMEOUT_MS,
    CLIENT_QUERY_ID_MAX,
    RESULT_LIMIT,
    SEARCH_PATH,
    SEARCH_TIMEOUT_MS,
    SEGMENT_TIMEOUT_MS,
    segmentPath
} from './constants';
import { guidKey } from './guid';
import { parseCapabilities, parseSearchBody, parseSegmentDetail, readErrorCode } from './parse';
import { noticesFor, partitionHits } from './presentation';
import type { PluginTransport, TransportResult } from './transport';
import type { ProblemCode, ReadySegmentView, SearchHitModel, SegmentDetailModel } from './types';
import { acceptsQuery, problemForAvailability } from './viewState';

export interface SearchRunInput {
    query: string
    parentId?: string
    clientQueryId: string
    signal: AbortSignal
}

export type SearchRunResult =
    | { kind: 'aborted' }
    | { kind: 'problem'; problem: ProblemCode }
    | { kind: 'ready'; view: ReadySegmentView };

export type SegmentRead =
    | { kind: 'hit'; hit: SegmentDetailModel }
    | { kind: 'gone'; reason: 'stale' | 'incompatible' | 'notFound' | 'denied' | 'transport' };

function problemFromStatus(status: number, data: unknown): ProblemCode | undefined {
    if (status === 404) {
        return 'plugin-absent';
    }

    if (status === 401) {
        return 'signed-out';
    }

    if (status === 403) {
        return 'forbidden';
    }

    if (status === 400) {
        return 'rejected';
    }

    if (status === 429) {
        return 'busy';
    }

    if (status === 409) {
        const code = readErrorCode(data);
        if (code === 'schemaNewer') {
            return 'schema-newer';
        }

        if (code === 'hostIncompatible') {
            return 'host-incompatible';
        }

        return 'incompatible';
    }

    if (status === 0 || status >= 500) {
        return 'transport';
    }

    return undefined;
}

async function receive(
    transport: PluginTransport,
    call: Parameters<PluginTransport['request']>[0]
): Promise<TransportResult | { kind: 'problem'; problem: ProblemCode }> {
    const result = await transport.request(call);
    if (result.kind === 'aborted') {
        return result;
    }

    if (result.kind === 'timeout') {
        return { kind: 'problem', problem: 'timeout' };
    }

    if (result.kind === 'blocked' || result.kind === 'network') {
        return { kind: 'problem', problem: 'transport' };
    }

    const problem = problemFromStatus(result.status, result.data);
    if (problem) {
        return { kind: 'problem', problem };
    }

    if (result.status !== 200) {
        return { kind: 'problem', problem: 'transport' };
    }

    return result;
}

export function searchBody(input: SearchRunInput): Record<string, unknown> {
    const body: Record<string, unknown> = {
        query: input.query.trim(),
        limit: RESULT_LIMIT,
        groupByVideo: true,
        clientQueryId: input.clientQueryId
    };
    const parentId = input.parentId?.trim();
    if (parentId) {
        body.parentId = parentId;
    }

    return body;
}

export async function runSegmentSearch(
    transport: PluginTransport,
    input: SearchRunInput
): Promise<SearchRunResult> {
    const capabilities = await receive(transport, {
        method: 'GET',
        path: CAPABILITIES_PATH,
        timeoutMs: CAPABILITIES_TIMEOUT_MS,
        signal: input.signal
    });
    if (capabilities.kind === 'aborted') {
        return capabilities;
    }

    if (capabilities.kind === 'problem') {
        return capabilities;
    }

    if (capabilities.kind !== 'response') {
        return { kind: 'problem', problem: 'transport' };
    }

    const parsedCapabilities = parseCapabilities(capabilities.data);
    if (!parsedCapabilities) {
        return { kind: 'problem', problem: 'contract' };
    }

    const blocked = problemForAvailability(parsedCapabilities.search);
    if (blocked) {
        return { kind: 'problem', problem: blocked };
    }

    if (parsedCapabilities.search === 'empty') {
        const notices = noticesFor({
            availability: 'empty',
            indexComplete: parsedCapabilities.indexComplete,
            relatedCount: 0
        });
        return {
            kind: 'ready',
            view: {
                phase: 'ready',
                clientQueryId: input.clientQueryId,
                availability: 'empty',
                indexComplete: parsedCapabilities.indexComplete,
                related: [],
                weak: [],
                notices
            }
        };
    }

    const searched = await receive(transport, {
        method: 'POST',
        path: SEARCH_PATH,
        body: searchBody(input),
        timeoutMs: SEARCH_TIMEOUT_MS,
        signal: input.signal
    });
    if (searched.kind === 'aborted' || searched.kind === 'problem') {
        return searched;
    }

    if (searched.kind !== 'response') {
        return { kind: 'problem', problem: 'transport' };
    }

    const body = parseSearchBody(searched.data);
    if (!body || !acceptsQuery({
        expectedClientQueryId: input.clientQueryId,
        responseClientQueryId: body.clientQueryId
    })) {
        return { kind: 'problem', problem: 'contract' };
    }

    const availabilityProblem = problemForAvailability(body.search);
    if (availabilityProblem) {
        return { kind: 'problem', problem: availabilityProblem };
    }

    const availability = body.search === 'empty' ? 'empty' : 'available';
    const parts = partitionHits(body.hits);
    return {
        kind: 'ready',
        view: {
            phase: 'ready',
            clientQueryId: input.clientQueryId,
            availability,
            indexComplete: body.indexComplete,
            related: parts.related,
            weak: parts.weak,
            notices: noticesFor({
                availability,
                indexComplete: body.indexComplete,
                relatedCount: parts.related.length
            })
        }
    };
}

export function classifySegment(status: number, data: unknown): SegmentRead {
    const code = readErrorCode(data);
    if (code === 'stale') {
        return { kind: 'gone', reason: 'stale' };
    }

    if (code === 'incompatible') {
        return { kind: 'gone', reason: 'incompatible' };
    }

    if (status === 404) {
        return { kind: 'gone', reason: 'notFound' };
    }

    if (status === 409) {
        return { kind: 'gone', reason: 'stale' };
    }

    if (status === 401 || status === 403) {
        return { kind: 'gone', reason: 'denied' };
    }

    return { kind: 'gone', reason: 'transport' };
}

export async function readSegment(
    transport: PluginTransport,
    segmentId: string,
    signal: AbortSignal
): Promise<SegmentRead> {
    if (!guidKey(segmentId)) {
        return { kind: 'gone', reason: 'notFound' };
    }

    const result = await transport.request({
        method: 'GET',
        path: segmentPath(segmentId),
        timeoutMs: SEGMENT_TIMEOUT_MS,
        signal
    });
    if (result.kind === 'aborted') {
        return { kind: 'gone', reason: 'transport' };
    }

    if (result.kind === 'timeout' || result.kind === 'blocked' || result.kind === 'network') {
        return { kind: 'gone', reason: 'transport' };
    }

    if (result.status !== 200) {
        return classifySegment(result.status, result.data);
    }

    const hit = parseSegmentDetail(result.data);
    if (!hit) {
        return { kind: 'gone', reason: 'transport' };
    }

    return { kind: 'hit', hit };
}

export function createClientQueryId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `q-${Date.now().toString(36)}`;
}

export function clientQueryIdFits(value: string): boolean {
    return value.length > 0 && value.length <= CLIENT_QUERY_ID_MAX;
}

export function listedHits(view: ReadySegmentView): SearchHitModel[] {
    return [...view.related, ...view.weak];
}
