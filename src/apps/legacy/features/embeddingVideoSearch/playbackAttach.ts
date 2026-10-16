import { isNakedStaticStream, needsSeek, seekConfirmed } from './playbackContract';

export interface HlsLike {
    on(event: string, handler: (event: string, data?: { fatal?: boolean }) => void): void
    loadSource(url: string): void
    attachMedia(media: HTMLMediaElement): void
    destroy(): void
}

export const HLS_MANIFEST_PARSED = 'hlsManifestParsed';
export const HLS_ERROR = 'hlsError';

export function clearVideoSurface(video: HTMLMediaElement | null): void {
    if (!video) {
        return;
    }

    try {
        video.pause();
    } catch {
        // The element may already be detached.
    }

    video.removeAttribute('src');
    video.load();
}

export function destroyHls(hls: HlsLike | undefined): void {
    if (!hls) {
        return;
    }

    try {
        hls.destroy();
    } catch {
        // A second close is harmless.
    }
}

export function confirmSeek(
    video: HTMLMediaElement,
    seconds: number,
    stillCurrent: () => boolean
): Promise<'ok' | 'interrupted' | 'unconfirmed'> {
    if (!stillCurrent()) {
        return Promise.resolve('interrupted');
    }

    if (video.readyState >= 1 && !needsSeek(video.currentTime, seconds)) {
        return Promise.resolve(stillCurrent() && seekConfirmed(video.currentTime, seconds) ? 'ok' : 'interrupted');
    }

    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: 'ok' | 'interrupted' | 'unconfirmed') => {
            if (settled) {
                return;
            }

            settled = true;
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('loadedmetadata', onMeta);
            resolve(value);
        };
        const confirm = () => {
            if (!stillCurrent()) {
                finish('interrupted');
                return;
            }

            finish(seekConfirmed(video.currentTime, seconds) ? 'ok' : 'unconfirmed');
        };
        const onSeeked = () => {
            confirm();
        };
        const assign = () => {
            if (!stillCurrent()) {
                finish('interrupted');
                return;
            }

            try {
                video.currentTime = seconds;
            } catch {
                finish('unconfirmed');
                return;
            }

            if (!needsSeek(video.currentTime, seconds)) {
                confirm();
            }
        };
        const onMeta = () => {
            assign();
        };
        video.addEventListener('seeked', onSeeked);
        if (video.readyState >= 1) {
            assign();
        } else {
            video.addEventListener('loadedmetadata', onMeta);
        }
    });
}

export type AttachResult = 'playing' | 'interrupted' | 'failed' | 'unconfirmed';

export function attachPluginHls(input: {
    video: HTMLVideoElement
    sourceUrl: string
    startSeconds: number
    stillCurrent: () => boolean
    xhrSetup: (xhr: XMLHttpRequest, url: string) => void
    createHls: (xhrSetup: (xhr: XMLHttpRequest, url: string) => void) => HlsLike
}): { hls: HlsLike; done: Promise<AttachResult> } {
    const hls = input.createHls(input.xhrSetup);
    if (isNakedStaticStream(input.sourceUrl) || !input.stillCurrent()) {
        destroyHls(hls);
        return { hls, done: Promise.resolve(input.stillCurrent() ? 'failed' : 'interrupted') };
    }

    const done = new Promise<AttachResult>((resolve) => {
        let settled = false;
        const finish = (value: AttachResult) => {
            if (settled) {
                return;
            }

            settled = true;
            if (value !== 'playing') {
                destroyHls(hls);
            }

            resolve(value);
        };
        hls.on(HLS_MANIFEST_PARSED, () => {
            void confirmSeek(input.video, input.startSeconds, input.stillCurrent).then(async (sought) => {
                if (sought !== 'ok') {
                    finish(sought === 'interrupted' ? 'interrupted' : 'unconfirmed');
                    return;
                }

                if (!input.stillCurrent()) {
                    finish('interrupted');
                    return;
                }

                try {
                    await input.video.play();
                } catch {
                    // Autoplay can be blocked after the seek. Controls stay available.
                }

                if (!input.stillCurrent()) {
                    try {
                        input.video.pause();
                    } catch {
                        // Already detached.
                    }

                    finish('interrupted');
                    return;
                }

                finish('playing');
            });
        });
        hls.on(HLS_ERROR, (_event, data) => {
            if (data?.fatal) {
                destroyHls(hls);
                clearVideoSurface(input.video);
                finish(input.stillCurrent() ? 'failed' : 'interrupted');
            }
        });
        hls.attachMedia(input.video);
        hls.loadSource(input.sourceUrl);
    });

    return { hls, done };
}

export function pageCanPlayHls(): Promise<boolean> {
    return import('hls.js/dist/hls.js')
        .then(({ default: Hls }) => Hls.isSupported())
        .catch(() => false);
}

export function createPluginHls(xhrSetup: (xhr: XMLHttpRequest, url: string) => void): Promise<HlsLike | undefined> {
    return import('hls.js/dist/hls.js').then(({ default: Hls }) => {
        if (!Hls.isSupported()) {
            return undefined;
        }

        return new Hls({
            xhrSetup: (xhr, url) => {
                xhr.withCredentials = false;
                xhrSetup(xhr, url);
            },
            lowLatencyMode: false,
            manifestLoadingTimeOut: 20000
        }) as HlsLike;
    }).catch(() => undefined);
}
