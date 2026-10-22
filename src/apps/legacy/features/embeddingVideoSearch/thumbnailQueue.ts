import { createAbortScope } from './abort';
import { THUMB_BUSY_RETRIES, THUMB_BUSY_RETRY_MS } from './constants';
import type { PreviewFetch } from './previewFetch';
import type { ThumbState } from './types';

export interface ThumbRequest {
    segmentId: string
    bindingVersion?: string
}

export interface ThumbQueueOptions {
    fetch: (job: ThumbRequest, signal: AbortSignal) => Promise<PreviewFetch>
    onChange: (segmentId: string, state: ThumbState) => void
    /** False once the login that queued the request is no longer current. */
    stillCurrent: () => boolean
    createUrl?: (blob: Blob) => string
    revokeUrl?: (url: string) => void
    wait?: (ms: number, signal: AbortSignal) => Promise<void>
    retryMs?: number
    maxBusyRetries?: number
}

export interface ThumbQueue {
    enqueue: (jobs: readonly ThumbRequest[]) => void
    prioritize: (segmentId: string) => void
    dispose: () => void
}

interface Entry {
    job: ThumbRequest
    state: ThumbState
    busyAttempts: number
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }

        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        }
        signal.addEventListener('abort', done);
    });
}

/**
 * Loads position frames one at a time. The server prepares a single preview at once
 * and answers 429 while busy, so parallel requests would only fail.
 */
export function createThumbnailQueue(options: ThumbQueueOptions): ThumbQueue {
    const createUrl = options.createUrl ?? (blob => URL.createObjectURL(blob));
    const revokeUrl = options.revokeUrl ?? (url => URL.revokeObjectURL(url));
    const wait = options.wait ?? defaultWait;
    const retryMs = options.retryMs ?? THUMB_BUSY_RETRY_MS;
    const maxBusyRetries = options.maxBusyRetries ?? THUMB_BUSY_RETRIES;
    const controller = createAbortScope();
    const entries = new Map<string, Entry>();
    const pending: string[] = [];
    const urls: string[] = [];
    let running = false;

    const live = () => !controller.isAborted() && options.stillCurrent();

    const publish = (id: string, entry: Entry, state: ThumbState) => {
        entry.state = state;
        if (!controller.isAborted()) {
            options.onChange(id, state);
        }
    };

    const runOne = async (id: string, entry: Entry): Promise<boolean> => {
        if (!entry.job.bindingVersion) {
            publish(id, entry, { status: 'failed' });
            return true;
        }

        publish(id, entry, { status: 'loading' });
        const result = await options.fetch(entry.job, controller.signal);
        if (!live() || result.kind === 'aborted') {
            return false;
        }

        if (result.kind === 'image') {
            const url = createUrl(result.blob);
            urls.push(url);
            publish(id, entry, { status: 'image', url });
            return true;
        }

        if (result.kind === 'busy') {
            entry.busyAttempts += 1;
            if (entry.busyAttempts > maxBusyRetries) {
                publish(id, entry, { status: 'busy' });
                return true;
            }

            publish(id, entry, { status: 'queued' });
            pending.unshift(id);
            await wait(retryMs * entry.busyAttempts, controller.signal);
            return live();
        }

        publish(id, entry, { status: result.kind });
        return true;
    };

    const pump = async () => {
        if (running) {
            return;
        }

        running = true;
        try {
            while (pending.length > 0 && live()) {
                const id = pending.shift() as string;
                const entry = entries.get(id);
                if (!entry || entry.state.status !== 'queued') {
                    continue;
                }

                if (!await runOne(id, entry)) {
                    break;
                }
            }
        } finally {
            running = false;
        }
    };

    return {
        enqueue(jobs) {
            for (const job of jobs) {
                if (entries.has(job.segmentId)) {
                    continue;
                }

                const entry: Entry = { job, state: { status: 'queued' }, busyAttempts: 0 };
                entries.set(job.segmentId, entry);
                pending.push(job.segmentId);
                publish(job.segmentId, entry, entry.state);
            }

            void pump();
        },
        prioritize(segmentId) {
            const entry = entries.get(segmentId);
            if (!entry) {
                return;
            }

            const { status } = entry.state;
            if (status === 'busy' || status === 'failed') {
                entry.busyAttempts = 0;
                publish(segmentId, entry, { status: 'queued' });
            } else if (status !== 'queued') {
                return;
            }

            const index = pending.indexOf(segmentId);
            if (index >= 0) {
                pending.splice(index, 1);
            }
            pending.unshift(segmentId);
            void pump();
        },
        dispose() {
            controller.abort();
            pending.length = 0;
            for (const url of urls.splice(0)) {
                revokeUrl(url);
            }
        }
    };
}
