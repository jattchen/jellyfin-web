export interface AbortScope {
    signal: AbortSignal
    abort: () => void
    isAborted: () => boolean
}

/** Legacy startup loads abortcontroller-polyfill before this code runs. */
export function createAbortScope(): AbortScope {
    // eslint-disable-next-line compat/compat -- polyfilled in src/lib/legacy/index.ts
    const controller = new AbortController();

    return {
        signal: controller.signal,
        abort: () => {
            controller.abort();
        },
        isAborted: () => controller.signal.aborted
    };
}

export function idleSignal(): AbortSignal {
    return createAbortScope().signal;
}
