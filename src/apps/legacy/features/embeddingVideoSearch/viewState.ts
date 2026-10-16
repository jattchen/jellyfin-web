import { guidKey } from './guid';
import type { ProblemCode, SegmentViewState } from './types';

export interface SessionStamp {
    serverId: string
    userId: string
    basePath: string
    authorizationHeader: string
}

export function searchScopeKey(input: {
    sessionEpoch: number
    userId: string
    serverId: string
    basePath: string
    query: string
    parentId?: string
    retryNonce: number
}): string {
    return [
        String(input.sessionEpoch),
        input.userId,
        input.serverId,
        input.basePath,
        input.query.trim(),
        input.parentId ?? '',
        String(input.retryNonce)
    ].join('\n');
}

const RETRYABLE_PROBLEMS = new Set<ProblemCode>([
    'timeout',
    'busy',
    'transport',
    'model-offline',
    'cancelled',
    'rejected'
]);

export function canRetryView(view: SegmentViewState): boolean {
    if (view.phase === 'problem') {
        return RETRYABLE_PROBLEMS.has(view.problem);
    }

    if (view.phase === 'ready') {
        return view.notices.includes('load-incomplete');
    }

    return false;
}

export function sameSession(left: SessionStamp, right: SessionStamp): boolean {
    return left.serverId.length > 0
        && left.userId.length > 0
        && left.authorizationHeader.length > 0
        && left.serverId === right.serverId
        && left.userId === right.userId
        && left.basePath === right.basePath
        && left.authorizationHeader === right.authorizationHeader;
}

export interface ScopeInput {
    query: string
    signedIn: boolean
    parentId?: string
}

export function viewForScope(input: ScopeInput): SegmentViewState {
    const trimmed = input.query.trim();
    if (!trimmed) {
        return { phase: 'idle' };
    }

    if (!input.signedIn) {
        return { phase: 'problem', problem: 'signed-out' };
    }

    const parent = input.parentId?.trim();
    if (parent && !guidKey(parent)) {
        return { phase: 'problem', problem: 'parent-invalid' };
    }

    if (trimmed.length > 1000) {
        return { phase: 'problem', problem: 'query-too-long' };
    }

    return { phase: 'pending' };
}

export function problemForAvailability(search: string): ProblemCode | undefined {
    switch (search) {
        case 'available':
        case 'empty':
            return undefined;
        case 'incompatible':
            return 'incompatible';
        case 'modelOffline':
            return 'model-offline';
        case 'timeout':
            return 'timeout';
        case 'cancelled':
            return 'cancelled';
        case 'queueFull':
            return 'busy';
        case 'schemaNewer':
            return 'schema-newer';
        case 'hostIncompatible':
            return 'host-incompatible';
        default:
            return 'contract';
    }
}

export interface AcceptInput {
    expectedClientQueryId: string
    responseClientQueryId: string | undefined
}

/** A late body from another query id is dropped instead of replacing the current view. */
export function acceptsQuery(input: AcceptInput): boolean {
    return input.responseClientQueryId === input.expectedClientQueryId;
}

export function shouldApplyResult(input: {
    requestId: string
    expectedId: string
    aborted: boolean
    sessionMatches: boolean
}): boolean {
    return input.requestId === input.expectedId && !input.aborted && input.sessionMatches;
}
