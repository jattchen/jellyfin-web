import { normalizeBindingVersion } from './binding';
import {
    API_VERSION,
    COLLAPSED_RUNS_FEATURE,
    GROUPED_VIDEO_FEATURE,
    SIMILAR_SEGMENTS_FEATURE,
    SEARCH_AVAILABILITY,
    TICKS_PER_SECOND,
    type SearchAvailability
} from './constants';
import { guidKey } from './guid';
import type { HitRun, SearchHitModel, SegmentDetailModel } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readErrorCode(data: unknown): string | undefined {
    if (!isRecord(data) || !isRecord(data.error) || typeof data.error.code !== 'string') {
        return undefined;
    }

    return data.error.code;
}

function readBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
        return value;
    }

    return undefined;
}

function readSafeInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return undefined;
    }

    return value;
}

function readFiniteNumber(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined;
    }

    return value;
}

export function parseAvailability(value: unknown): SearchAvailability | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    for (const candidate of SEARCH_AVAILABILITY) {
        if (candidate === value) {
            return candidate;
        }
    }

    return undefined;
}

export interface ParsedCapabilities {
    search: SearchAvailability
    indexComplete: boolean
    /** Older plugins omit this and keep one row per returned candidate. */
    collapsedRuns: boolean
    /** Older plugins omit this and hide Find similar. */
    similarSegments: boolean
}

export function parseCapabilities(data: unknown): ParsedCapabilities | undefined {
    if (!isRecord(data) || data.apiVersion !== API_VERSION || data.ticksPerSecond !== TICKS_PER_SECOND) {
        return undefined;
    }

    if (!isRecord(data.availability)) {
        return undefined;
    }

    // Older cosine-only plugins must not be presented as two-channel search.
    if (!isRecord(data.qualityPolicy) || data.qualityPolicy.scoreMeaning !== 'referenceTailR') {
        return undefined;
    }

    if (!Array.isArray(data.features) || !data.features.includes(GROUPED_VIDEO_FEATURE)) {
        return undefined;
    }

    const collapsedRuns = data.features.includes(COLLAPSED_RUNS_FEATURE);
    const similarSegments = data.features.includes(SIMILAR_SEGMENTS_FEATURE);

    const search = parseAvailability(data.availability.search);
    if (!search) {
        return undefined;
    }

    const coverage = isRecord(data.coverage) ? data.coverage : undefined;
    const indexComplete = coverage ? readBoolean(coverage.indexComplete) : false;
    if (indexComplete === undefined) {
        return undefined;
    }

    return {
        search,
        indexComplete,
        collapsedRuns,
        similarSegments
    };
}

/**
 * A run must wrap the representative. Missing or inverted spans are a contract
 * failure only when this client asked for collapseRuns.
 */
export function parseCollapsedRun(
    data: unknown,
    hitStart: number,
    hitEnd: number
): HitRun | undefined {
    if (!isRecord(data)) {
        return undefined;
    }

    const startTicks = readSafeInteger(data.startTicks);
    const endTicks = readSafeInteger(data.endTicks);
    const memberCount = readSafeInteger(data.memberCount);
    if (startTicks === undefined || endTicks === undefined || memberCount === undefined) {
        return undefined;
    }

    if (memberCount < 1 || startTicks < 0 || endTicks <= startTicks) {
        return undefined;
    }

    if (startTicks > hitStart || endTicks < hitEnd) {
        return undefined;
    }

    return { startTicks, endTicks, memberCount };
}

function parseIdentity(data: Record<string, unknown>): Omit<SearchHitModel, 'score' | 'quality'> | undefined {
    if (typeof data.itemId !== 'string' || typeof data.segmentId !== 'string' || typeof data.mediaSourceId !== 'string') {
        return undefined;
    }

    if (!guidKey(data.itemId) || !guidKey(data.segmentId) || data.mediaSourceId.length === 0) {
        return undefined;
    }

    const startTicks = readSafeInteger(data.startTicks);
    const endTicks = readSafeInteger(data.endTicks);
    const indexComplete = readBoolean(data.indexComplete);
    if (startTicks === undefined || endTicks === undefined || indexComplete === undefined) {
        return undefined;
    }

    if (startTicks < 0 || endTicks <= startTicks) {
        return undefined;
    }

    const parsed: Omit<SearchHitModel, 'score' | 'quality'> = {
        itemId: data.itemId.trim(),
        mediaSourceId: data.mediaSourceId,
        segmentId: data.segmentId.trim(),
        startTicks,
        endTicks,
        indexComplete
    };
    const binding = readBinding(data);
    if (binding === null) {
        return undefined;
    }

    if (binding) {
        parsed.bindingVersion = binding;
    }

    const transcript = readTranscript(data);
    if (transcript === null) {
        return undefined;
    }

    if (transcript) {
        parsed.transcript = transcript;
    }

    return parsed;
}

function readBinding(data: Record<string, unknown>): string | undefined | null {
    if (!('bindingVersion' in data)) {
        return undefined;
    }

    return normalizeBindingVersion(data.bindingVersion);
}

function readTranscript(data: Record<string, unknown>): string | undefined | null {
    if (!('transcript' in data) || data.transcript == null) {
        return undefined;
    }

    if (typeof data.transcript !== 'string') {
        return null;
    }

    const trimmed = data.transcript.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function parseSearchHit(
    data: unknown,
    options?: { expectRun?: boolean; expectSimilar?: boolean }
): SearchHitModel | undefined {
    if (!isRecord(data)) {
        return undefined;
    }

    const identity = parseIdentity(data);
    const score = readFiniteNumber(data.score);
    if (!identity || score === undefined || (data.quality !== 'candidate' && data.quality !== 'related' && data.quality !== 'weak')) {
        return undefined;
    }

    let hit: SearchHitModel;
    if (data.quality === 'candidate') {
        const rawScore = readFiniteNumber(data.rawScore);
        if (score < 0 || rawScore === undefined
            || (data.representation !== 'jointAudioVideo' && data.representation !== 'transcriptText')
            || typeof data.candidateId !== 'string' || !data.candidateId) {
            return undefined;
        }

        hit = {
            ...identity,
            score,
            quality: 'candidate',
            rawScore,
            representation: data.representation,
            candidateId: data.candidateId
        };
    } else {
        hit = {
            ...identity,
            score,
            quality: data.quality
        };
    }

    if (options?.expectRun) {
        const run = parseCollapsedRun(data.run, hit.startTicks, hit.endTicks);
        if (!run) {
            return undefined;
        }

        hit = { ...hit, run };
    }

    if (options?.expectSimilar) {
        if (typeof data.similarAvailable !== 'boolean') {
            return undefined;
        }

        hit = { ...hit, similarAvailable: data.similarAvailable };
    }

    return hit;
}

export function parseSegmentDetail(data: unknown): SegmentDetailModel | undefined {
    if (!isRecord(data)) {
        return undefined;
    }

    const identity = parseIdentity(data);
    if (!identity) {
        return undefined;
    }

    const detail: SegmentDetailModel = { ...identity };
    if ('score' in data) {
        const score = readFiniteNumber(data.score);
        if (score === undefined) {
            return undefined;
        }

        detail.score = score;
    }

    if ('representation' in data) {
        if (typeof data.representation !== 'string' || data.representation.length === 0) {
            return undefined;
        }

        detail.representation = data.representation;
    }

    if ('candidateId' in data) {
        if (typeof data.candidateId !== 'string' || !data.candidateId) {
            return undefined;
        }

        detail.candidateId = data.candidateId;
    }

    return detail;
}

export interface ParsedSearchBody {
    clientQueryId: string | undefined
    search: SearchAvailability
    indexComplete: boolean
    hits: SearchHitModel[]
}

export function parseSearchBody(
    data: unknown,
    options?: { expectRun?: boolean; expectSimilar?: boolean }
): ParsedSearchBody | undefined {
    if (!isRecord(data) || data.apiVersion !== API_VERSION || typeof data.queryId !== 'string' || !guidKey(data.queryId)) {
        return undefined;
    }

    if (!isRecord(data.availability)) {
        return undefined;
    }

    const search = parseAvailability(data.availability.search);
    const indexComplete = readBoolean(data.indexComplete);
    if (!search || indexComplete === undefined || !Array.isArray(data.results)) {
        return undefined;
    }

    let clientQueryId: string | undefined;
    if (data.clientQueryId !== null && data.clientQueryId !== undefined) {
        if (typeof data.clientQueryId !== 'string') {
            return undefined;
        }

        clientQueryId = data.clientQueryId;
    }

    const hits: SearchHitModel[] = [];
    const seen = new Set<string>();
    for (const entry of data.results) {
        const hit = parseSearchHit(entry, options);
        if (!hit) {
            return undefined;
        }

        const key = guidKey(hit.segmentId);
        if (!key || seen.has(key)) {
            return undefined;
        }

        seen.add(key);
        hits.push(hit);
    }

    return {
        clientQueryId,
        search,
        indexComplete,
        hits
    };
}
