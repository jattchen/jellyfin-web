import { confirmSeek, type HlsLike } from './playbackAttach';
import {
    continueSameFilm,
    deletePlaybackSession,
    openPlaybackSession,
    seekSeconds,
    type ActivePlayback,
    type OpenPlayback
} from './playbackContract';
import { IncompatiblePlayback, type NativePlayOptions } from './playback';
import type { PluginTransport } from './transport';
import type { SearchHitModel } from './types';

export function abortedError(): DOMException {
    return new DOMException('The operation was aborted.', 'AbortError');
}

async function seekCurrentFilm(input: {
    hit: SearchHitModel
    live: () => boolean
    video: HTMLVideoElement | null
}): Promise<void> {
    if (!input.video) {
        throw new Error('no-video');
    }

    const sought = await confirmSeek(input.video, seekSeconds(input.hit.startTicks), input.live);
    if (!input.live() || sought === 'interrupted') {
        throw abortedError();
    }

    if (sought !== 'ok') {
        throw new Error('seek');
    }

    try {
        await input.video.play();
    } catch {
        // The seek already landed. Controls can start playback.
    }

    if (!input.live()) {
        try {
            input.video.pause();
        } catch {
            // Detached while pausing.
        }

        throw abortedError();
    }
}

async function openFreshPlayback(input: {
    hit: SearchHitModel
    live: () => boolean
    signal: AbortSignal
    video: HTMLVideoElement | null
    active: ActivePlayback | undefined
    openSession: (hit: SearchHitModel, signal: AbortSignal) => Promise<OpenPlayback>
    deleteSession: (session: ActivePlayback) => Promise<void>
    attach: (
        video: HTMLVideoElement,
        session: ActivePlayback,
        live: () => boolean
    ) => Promise<{ result: 'playing' | 'interrupted' | 'failed' | 'unconfirmed'; hls?: HlsLike }>
    publish: (session: ActivePlayback, hls: HlsLike | undefined) => void
    owns: (playbackId: string) => boolean
}): Promise<void> {
    if (input.active) {
        await input.deleteSession(input.active);
    }

    const opened = await input.openSession(input.hit, input.signal);
    if (opened.kind === 'incompatible') {
        throw new IncompatiblePlayback();
    }

    if (opened.kind === 'aborted' || !input.live() || input.signal.aborted) {
        if (opened.kind === 'ready') {
            await input.deleteSession(opened.session);
        }

        throw abortedError();
    }

    if (opened.kind !== 'ready' || !input.video) {
        if (opened.kind === 'ready') {
            await input.deleteSession(opened.session);
        }

        throw new Error('playback');
    }

    input.publish(opened.session, undefined);
    const attached = await input.attach(input.video, opened.session, input.live);
    if (attached.hls && input.owns(opened.session.playbackId) && input.live()) {
        input.publish(opened.session, attached.hls);
    }

    if (attached.result === 'playing' && input.live()) {
        return;
    }

    if (input.owns(opened.session.playbackId)) {
        await input.deleteSession(opened.session);
    }

    throw attached.result === 'interrupted' || !input.live() ? abortedError() : new Error('playback');
}

export async function runHitPlayback(input: {
    hit: SearchHitModel
    live: () => boolean
    signal: AbortSignal
    video: HTMLVideoElement | null
    authorization: string
    active: ActivePlayback | undefined
    canPlayInPage: () => Promise<boolean>
    nativePlay: (options: NativePlayOptions) => Promise<unknown>
    options: NativePlayOptions
    openSession: (hit: SearchHitModel, signal: AbortSignal) => Promise<OpenPlayback>
    deleteSession: (session: ActivePlayback) => Promise<void>
    attach: (
        video: HTMLVideoElement,
        session: ActivePlayback,
        live: () => boolean
    ) => Promise<{ result: 'playing' | 'interrupted' | 'failed' | 'unconfirmed'; hls?: HlsLike }>
    publish: (session: ActivePlayback, hls: HlsLike | undefined) => void
    owns: (playbackId: string) => boolean
}): Promise<void> {
    if (!input.hit.bindingVersion) {
        throw new IncompatiblePlayback();
    }

    if (!input.live() || input.signal.aborted) {
        throw abortedError();
    }

    const inPage = await input.canPlayInPage();
    if (!input.live() || input.signal.aborted) {
        throw abortedError();
    }

    if (!inPage) {
        await input.nativePlay(input.options);
        return;
    }

    if (continueSameFilm(input.active, input.hit, input.authorization)) {
        await seekCurrentFilm(input);
        return;
    }

    await openFreshPlayback(input);
}

export function openSessionForHit(input: {
    transport: PluginTransport
    getUri: (path: string) => string
    authorization: string
    hit: SearchHitModel
    signal: AbortSignal
    api: { axiosInstance: { delete?: (url: string, config: object) => Promise<unknown> } }
}): Promise<OpenPlayback> {
    return openPlaybackSession({
        transport: input.transport,
        getUri: input.getUri,
        authorization: input.authorization,
        hit: input.hit,
        signal: input.signal,
        deleteSession: session => deletePlaybackSession(input.api, session)
    });
}
