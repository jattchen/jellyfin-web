export interface SegmentIdentity {
    itemId: string
    mediaSourceId: string
    segmentId: string
    startTicks: number
    endTicks: number
    indexComplete: boolean
}

/** Score and quality come from POST search and stay on this object. */
export interface SearchHitModel extends SegmentIdentity {
    score: number
    quality: 'candidate' | 'related' | 'weak'
    rawScore?: number
    representation?: 'jointAudioVideo' | 'transcriptText'
    candidateId?: string
    /** SHA-256 stamp of media, content, time, candidate, and representation. */
    bindingVersion?: string
    transcript?: string
}

/** GET segments does not recompute similarity. Its score is not the search score. */
export interface SegmentDetailModel extends SegmentIdentity {
    score?: number
    representation?: string
    candidateId?: string
    bindingVersion?: string
    transcript?: string
}

export type ProblemCode =
    | 'plugin-absent'
    | 'contract'
    | 'model-offline'
    | 'timeout'
    | 'busy'
    | 'incompatible'
    | 'schema-newer'
    | 'host-incompatible'
    | 'cancelled'
    | 'parent-invalid'
    | 'query-too-long'
    | 'signed-out'
    | 'forbidden'
    | 'rejected'
    | 'transport';

export type NoticeCode =
    | 'partial-index'
    | 'no-match'
    | 'no-match-partial'
    | 'nothing-searchable'
    | 'nothing-searchable-partial'
    | 'load-incomplete'
    | 'results-hidden';

export interface ReadySegmentView {
    phase: 'ready'
    clientQueryId: string
    availability: 'available' | 'empty'
    indexComplete: boolean
    related: SearchHitModel[]
    weak: SearchHitModel[]
    notices: NoticeCode[]
}

export type SegmentViewState =
    | { phase: 'idle' }
    | { phase: 'pending' }
    | ReadySegmentView
    | { phase: 'problem'; problem: ProblemCode };

export type PlayRefusal =
    | 'interrupted'
    | 'stale'
    | 'incompatible'
    | 'notFound'
    | 'mismatch'
    | 'denied'
    | 'play-failed'
    | 'binding'
    | 'transport';

export type PlayResult = { ok: true } | { ok: false; reason: PlayRefusal };

export interface DisplayHit {
    segmentId: string
    itemId: string
    range: string
    partial: boolean
    startTicks: number
    endTicks: number
    transcript?: string
}

export interface ItemCard {
    title: string
    posterBlob?: Blob
    runtimeTicks?: number
}

export type ItemLoad =
    | { status: 'ready'; card: ItemCard }
    | { status: 'inaccessible' }
    | { status: 'failed' };

export interface DisplayCard {
    title: string
    posterUrl?: string
    runtimeTicks?: number
}
