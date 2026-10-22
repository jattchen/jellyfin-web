import { normalizeBindingVersion } from './binding';
import { API_PREFIX, RESULT_LIMIT } from './constants';
import { guidKey, sameGuid } from './guid';
import { parseSearchBody, readErrorCode } from './parse';
import { formatRange } from './presentation';
import type { ProblemCode, SearchHitModel } from './types';
import { shouldApplyResult } from './viewState';

export const SIMILAR_PATH = `${API_PREFIX}/similar`;
export const DOCUMENT_COSINE = 'documentCosine';

export interface SimilarSourceWindow {
    segmentId: string
    startTicks: number
    endTicks: number
    representation: 'jointAudioVideo'
    bindingVersion: string
}

export interface SimilarReference {
    segmentId: string
    itemId: string
    mediaSourceId: string
    startTicks: number
    endTicks: number
    representation: 'jointAudioVideo' | 'transcriptText'
    bindingVersion: string
    source: SimilarSourceWindow
    excluded: { startTicks: number; endTicks: number }
}

export interface SimilarHit extends SearchHitModel {
    similarAvailable: boolean
}

export interface ParsedSimilarBody {
    clientQueryId: string | undefined
    indexComplete: boolean
    hits: SimilarHit[]
    reference: SimilarReference
}

export type SimilarFailure =
    | { kind: 'aborted' }
    | { kind: 'stay'; problem: ProblemCode }
    | {
        kind: 'return'
        notice: 'gone' | 'unavailable'
        withdraw: 'item' | 'media' | 'none'
        problem?: ProblemCode
    };

export interface TextViewSnapshot {
    moreOpen: boolean
    scrollY: number
    originSegmentId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSafeInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return undefined;
    }

    return value;
}

function readSpan(data: unknown): { startTicks: number; endTicks: number } | undefined {
    if (!isRecord(data)) {
        return undefined;
    }

    const startTicks = readSafeInteger(data.startTicks);
    const endTicks = readSafeInteger(data.endTicks);
    if (startTicks === undefined || endTicks === undefined || startTicks < 0 || endTicks <= startTicks) {
        return undefined;
    }

    return { startTicks, endTicks };
}

function parseReference(data: unknown): SimilarReference | undefined {
    if (!isRecord(data)) {
        return undefined;
    }

    if (typeof data.segmentId !== 'string' || !guidKey(data.segmentId)
        || typeof data.itemId !== 'string' || !guidKey(data.itemId)
        || typeof data.mediaSourceId !== 'string' || data.mediaSourceId.length === 0) {
        return undefined;
    }

    const span = readSpan(data);
    const bindingVersion = normalizeBindingVersion(data.bindingVersion);
    if (!span || !bindingVersion) {
        return undefined;
    }

    if (data.representation !== 'jointAudioVideo' && data.representation !== 'transcriptText') {
        return undefined;
    }

    if (!isRecord(data.source) || data.source.representation !== 'jointAudioVideo'
        || typeof data.source.segmentId !== 'string' || !guidKey(data.source.segmentId)) {
        return undefined;
    }

    const sourceSpan = readSpan(data.source);
    const sourceBinding = normalizeBindingVersion(data.source.bindingVersion);
    const excluded = readSpan(data.excluded);
    if (!sourceSpan || !sourceBinding || !excluded) {
        return undefined;
    }

    const coveredStart = Math.min(span.startTicks, sourceSpan.startTicks);
    const coveredEnd = Math.max(span.endTicks, sourceSpan.endTicks);
    if (excluded.startTicks > coveredStart || excluded.endTicks < coveredEnd) {
        return undefined;
    }

    return {
        segmentId: data.segmentId,
        itemId: data.itemId,
        mediaSourceId: data.mediaSourceId,
        startTicks: span.startTicks,
        endTicks: span.endTicks,
        representation: data.representation,
        bindingVersion,
        source: {
            segmentId: data.source.segmentId,
            startTicks: sourceSpan.startTicks,
            endTicks: sourceSpan.endTicks,
            representation: 'jointAudioVideo',
            bindingVersion: sourceBinding
        },
        excluded
    };
}

/** Similar ordering uses document cosine. A normal search body never goes through here. */
export function parseSimilarBody(data: unknown): ParsedSimilarBody | undefined {
    if (!isRecord(data) || !isRecord(data.qualityPolicy) || data.qualityPolicy.scoreMeaning !== DOCUMENT_COSINE) {
        return undefined;
    }

    const body = parseSearchBody(data, { expectRun: true });
    if (!body || !Array.isArray(data.results) || data.results.length !== body.hits.length) {
        return undefined;
    }

    const reference = parseReference(data.reference);
    if (!reference) {
        return undefined;
    }

    const hits: SimilarHit[] = [];
    for (let index = 0; index < body.hits.length; index += 1) {
        const raw = data.results[index];
        const hit = body.hits[index];
        if (!isRecord(raw) || typeof raw.similarAvailable !== 'boolean' || !hit) {
            return undefined;
        }

        hits.push({ ...hit, similarAvailable: raw.similarAvailable });
    }

    return {
        clientQueryId: body.clientQueryId,
        indexComplete: body.indexComplete,
        hits,
        reference
    };
}

export function similarRequestBody(input: {
    segmentId: string
    expectedBindingVersion: string
    parentId?: string
    clientQueryId: string
}): Record<string, unknown> {
    const body: Record<string, unknown> = {
        segmentId: input.segmentId,
        expectedBindingVersion: input.expectedBindingVersion,
        limit: RESULT_LIMIT,
        groupByVideo: true,
        collapseRuns: true,
        clientQueryId: input.clientQueryId
    };
    const parentId = input.parentId?.trim();
    if (parentId) {
        body.parentId = parentId;
    }

    return body;
}

/** Dialogue references name the joint window the server actually compared. */
export function referenceComparisonText(
    reference: SimilarReference,
    label: (range: string) => string
): string | undefined {
    const sameWindow = reference.representation === 'jointAudioVideo'
        && sameGuid(reference.segmentId, reference.source.segmentId)
        && reference.startTicks === reference.source.startTicks
        && reference.endTicks === reference.source.endTicks;
    if (sameWindow) {
        return undefined;
    }

    return label(formatRange(reference.source.startTicks, reference.source.endTicks));
}

export function sameTitleMoment(hitItemId: string, referenceItemId: string): boolean {
    return sameGuid(hitItemId, referenceItemId);
}

export function similarNavigation(currentSegmentId: string | undefined, nextSegmentId: string): 'push' | 'replace' {
    const currentKey = guidKey(currentSegmentId);
    const nextKey = guidKey(nextSegmentId);
    if (!currentKey && nextKey) {
        return 'push';
    }

    if (currentKey) {
        return 'replace';
    }

    return 'push';
}

export function classifySimilarHttp(status: number, data: unknown): SimilarFailure {
    const code = readErrorCode(data);
    if (status === 404 || status === 401 || status === 403) {
        return { kind: 'return', notice: 'gone', withdraw: 'item' };
    }

    if (status === 409 && code === 'stale') {
        return { kind: 'return', notice: 'gone', withdraw: 'media' };
    }

    if (status === 409 && code === 'referenceUnavailable') {
        return { kind: 'return', notice: 'unavailable', withdraw: 'none' };
    }

    if (status === 409 && code === 'bindingMismatch') {
        return { kind: 'return', notice: 'gone', withdraw: 'none' };
    }

    if (status === 409 && code === 'schemaNewer') {
        return { kind: 'return', notice: 'gone', withdraw: 'none', problem: 'schema-newer' };
    }

    if (status === 409 && code === 'hostIncompatible') {
        return { kind: 'return', notice: 'gone', withdraw: 'none', problem: 'host-incompatible' };
    }

    if (status === 409) {
        return { kind: 'return', notice: 'gone', withdraw: 'none', problem: 'incompatible' };
    }

    if (status === 429) {
        return { kind: 'stay', problem: 'busy' };
    }

    if (status === 400) {
        return { kind: 'stay', problem: 'rejected' };
    }

    return { kind: 'stay', problem: 'transport' };
}

export function classifySimilarTransport(kind: 'aborted' | 'timeout' | 'blocked' | 'network'): SimilarFailure {
    if (kind === 'aborted') {
        return { kind: 'aborted' };
    }

    if (kind === 'timeout') {
        return { kind: 'stay', problem: 'timeout' };
    }

    return { kind: 'stay', problem: 'transport' };
}

export function acceptSimilarResponse(input: {
    requestId: string
    expectedId: string
    aborted: boolean
    sessionMatches: boolean
    requestedSegmentId: string
    responseSegmentId: string | undefined
}): boolean {
    return shouldApplyResult(input)
        && sameGuid(input.requestedSegmentId, input.responseSegmentId ?? '');
}

export function queryChangeLeavesSimilar(previousQuery: string, nextQuery: string): boolean {
    return previousQuery.trim() !== nextQuery.trim();
}

export function focusAfterReturn(
    snapshot: TextViewSnapshot,
    visibleSegmentIds: readonly string[]
): { moreOpen: boolean; scrollY: number; focus: 'origin' | 'title' } {
    const origin = snapshot.originSegmentId;
    if (origin && visibleSegmentIds.some(id => sameGuid(id, origin))) {
        return { moreOpen: snapshot.moreOpen, scrollY: snapshot.scrollY, focus: 'origin' };
    }

    return { moreOpen: snapshot.moreOpen, scrollY: snapshot.scrollY, focus: 'title' };
}

/** The playing moment stays on stage even when the visible list no longer contains it. */
export function stageHitForPlayback<T extends { segmentId: string }>(
    playing: T | undefined,
    visible: readonly T[]
): T | undefined {
    if (!playing) {
        return visible[0];
    }

    return visible.find(hit => sameGuid(hit.segmentId, playing.segmentId)) ?? playing;
}
