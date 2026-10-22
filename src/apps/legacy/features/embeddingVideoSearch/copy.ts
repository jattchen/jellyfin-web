import type { NoticeCode, PlayRefusal, ProblemCode } from './types';

export interface SegmentCopy {
    nameSearch: string
    searchAction: string
    unsubmitted: string
    title: string
    summary: (films: number, moments: number) => string
    caveat: string
    /** Shown only when the server collapsed touching candidates. */
    collapsedNote: string
    merged: (count: number, range: string) => string
    findSimilar: string
    findSimilarNamed: (rank: number) => string
    similarTitle: string
    backToResults: string
    referenceLabel: string
    playReference: string
    compareUsing: (range: string) => string
    sameFilm: string
    similarSearching: string
    similarSummary: (films: number, moments: number) => string
    similarFound: (count: number) => string
    similarCaveat: string
    similarEmpty: string
    similarCannot: string
    similarDisabled: string
    referenceGone: string
    referenceMark: string
    searching: string
    checkingPlayer: string
    playerUnsupported: string
    openNative: string
    fullscreen: string
    best: string
    rank: (rank: number) => string
    playFrom: (range: string) => string
    nowPlaying: string
    kind: (representation: string | undefined) => string
    thumbLoading: string
    thumbMissing: string
    timeline: (title: string) => string
    timelineUnknown: string
    moreShow: (count: number) => string
    moreHide: string
    partialItem: string
    fallbackTitle: string
    retry: string
    playNamed: (title: string, range: string, partial: boolean) => string
    notice: (code: NoticeCode) => string
    problem: (code: ProblemCode) => string
    /** Same situations as problem(), with Find similar as the subject. */
    similarProblem: (code: ProblemCode) => string
    play: (reason: PlayRefusal) => string
    opening: string
}

const zh: SegmentCopy = {
    nameSearch: '名称匹配',
    searchAction: '查找画面与对白',
    unsubmitted: '这句话还没提交。下面仍是上次的结果。',
    title: '相关片段',
    summary: (films, moments) => `${films} 部影片中的 ${moments} 个候选，按接近程度排序`,
    caveat: '候选可能有误，“最接近”不代表一定匹配。点任一片段，从原片该处继续播放。',
    collapsedNote: '同一部里时间相连的候选，只列名次最高的一段。',
    merged: (count, range) => `已合并相连的 ${count} 段 · ${range}`,
    findSimilar: '找相似',
    findSimilarNamed: rank => `找与第 ${rank} 名相似的片段`,
    similarTitle: '与这段相似的片段',
    backToResults: '返回搜索结果',
    referenceLabel: '参照',
    playReference: '播放参照',
    compareUsing: range => `按 ${range} 的画面与声音比较`,
    sameFilm: '同一部其他位置',
    similarSearching: '正在找相似片段…',
    similarSummary: (films, moments) => `${films} 部影片中的 ${moments} 个候选，按画面与声音的接近程度排序`,
    similarFound: count => `找到 ${count} 个相似片段`,
    similarCaveat: '可能有误。已排除参照段本身，以及与它重叠或相接的片段；同一部的其他位置也会列出。',
    similarEmpty: '没有找到其他相似片段。与参照段重叠或相接的部分不计入。',
    similarCannot: '这段没有可用的画面与声音，不能找相似。',
    similarDisabled: '这段没有可用的画面与声音',
    referenceGone: '参照段已经失效或现在看不到，已回到搜索结果。',
    referenceMark: '参照',
    searching: '正在查找画面与对白…',
    checkingPlayer: '正在确认这个浏览器能不能在页面里播放。',
    playerUnsupported: '这个浏览器不能在页面里直接播放。可以改用原来的播放器，从记下的时间继续。',
    openNative: '用原来的播放器打开',
    fullscreen: '全屏',
    best: '最接近',
    rank: rank => `第 ${rank} 名`,
    playFrom: range => `从 ${range} 播放`,
    nowPlaying: '正在播放',
    kind: representation => (representation === 'transcriptText' ? '对白' : '画面与声音'),
    thumbLoading: '正在取这一时刻的画面',
    thumbMissing: '没有这一时刻的画面',
    timeline: title => `《${title}》中的候选位置`,
    timelineUnknown: '还不知道整部有多长，所以这里只列出时间。',
    moreShow: count => `更多候选（${count}）`,
    moreHide: '收起更多候选',
    partialItem: '仅部分内容可搜索',
    fallbackTitle: '影片',
    retry: '重试',
    playNamed: (title, range, partial) => {
        const base = `从 ${range} 播放《${title}》`;
        if (partial) {
            return `${base}。仅部分内容可搜索`;
        }

        return base;
    },
    notice: code => {
        switch (code) {
            case 'partial-index':
                return '仅搜索已建立索引的范围，其他位置暂不可搜索。';
            case 'no-match':
                return '本次没有返回片段候选。';
            case 'no-match-partial':
                return '本次没有返回片段候选。仅搜索已建立索引的范围，其他位置暂不可搜索。';
            case 'nothing-searchable':
                return '启用的范围里还没有可搜索的片段。';
            case 'nothing-searchable-partial':
                return '启用的范围里还没有可搜索的片段。仅搜索已建立索引的范围，其他位置暂不可搜索。';
            case 'load-incomplete':
                return '部分结果未能加载。可以重试。';
            case 'results-hidden':
                return '这些结果现在看不到。';
            default:
                return '画面搜索没有完成。标题搜索不受影响。';
        }
    },
    problem: code => {
        switch (code) {
            case 'plugin-absent':
                return '画面搜索没有装上。标题搜索不受影响。';
            case 'contract':
                return '画面搜索的接口版本对不上。标题搜索不受影响。';
            case 'model-offline':
                return '画面搜索暂时连不上模型。标题搜索不受影响。';
            case 'timeout':
                return '查找超时了。标题搜索不受影响。';
            case 'busy':
                return '画面搜索正忙。标题搜索不受影响。';
            case 'incompatible':
                return '画面索引和当前模型不兼容，需要管理员处理。标题搜索不受影响。';
            case 'schema-newer':
                return '画面索引比当前插件更新，暂时不能搜索。标题搜索不受影响。';
            case 'host-incompatible':
                return '当前服务器版本不能使用画面搜索。标题搜索不受影响。';
            case 'cancelled':
                return '这次画面搜索已取消。';
            case 'parent-invalid':
                return '当前页面的筛选条件无法用于画面搜索。标题结果仍按原范围显示。';
            case 'query-too-long':
                return '这句话太长了，画面搜索没有开始。';
            case 'signed-out':
                return '登录状态已变化，画面搜索已清空。';
            case 'forbidden':
                return '当前账号不能使用画面搜索。标题搜索不受影响。';
            case 'rejected':
                return '画面搜索没有接受这次请求。标题搜索不受影响。';
            case 'transport':
                return '画面搜索没有完成。标题搜索不受影响。';
            default:
                return '画面搜索没有完成。标题搜索不受影响。';
        }
    },
    similarProblem: code => {
        switch (code) {
            case 'plugin-absent':
                return '找相似没有装上。标题搜索不受影响。';
            case 'contract':
                return '找相似的接口版本对不上。标题搜索不受影响。';
            case 'model-offline':
                return '找相似暂时连不上模型。标题搜索不受影响。';
            case 'timeout':
                return '找相似超时了。标题搜索不受影响。';
            case 'busy':
                return '找相似正忙。标题搜索不受影响。';
            case 'incompatible':
                return '画面索引和当前模型不兼容，需要管理员处理。标题搜索不受影响。';
            case 'schema-newer':
                return '画面索引比当前插件更新，暂时不能找相似。标题搜索不受影响。';
            case 'host-incompatible':
                return '当前服务器版本不能使用找相似。标题搜索不受影响。';
            case 'cancelled':
                return '这次找相似已取消。';
            case 'parent-invalid':
                return '当前页面的筛选条件无法用于找相似。标题结果仍按原范围显示。';
            case 'query-too-long':
                return '这句话太长了，找相似没有开始。';
            case 'signed-out':
                return '登录状态已变化，找相似已清空。';
            case 'forbidden':
                return '当前账号不能使用找相似。标题搜索不受影响。';
            case 'rejected':
                return '找相似没有接受这次请求。标题搜索不受影响。';
            case 'transport':
                return '找相似没有完成。标题搜索不受影响。';
            default:
                return '找相似没有完成。标题搜索不受影响。';
        }
    },
    play: reason => {
        switch (reason) {
            case 'interrupted':
                return '登录状态已变化，没有开始播放。';
            case 'stale':
                return '这段已经失效，没有开始播放。';
            case 'incompatible':
                return '这段和当前索引不兼容，没有开始播放。';
            case 'notFound':
                return '现在看不到这段，没有开始播放。';
            case 'mismatch':
                return '影片身份或时间对不上，没有开始播放。';
            case 'denied':
                return '当前账号不能播放这部影片。';
            case 'play-failed':
                return '播放没有开始。';
            case 'binding':
                return '这段的版本对不上，没有开始播放。';
            case 'transport':
                return '没能确认这段是否还能播放，没有开始播放。';
            default:
                return '播放没有开始。';
        }
    },
    opening: '正在确认这段还能不能播放…'
};

const en: SegmentCopy = {
    nameSearch: 'Title matches',
    searchAction: 'Search picture and dialogue',
    unsubmitted: 'This sentence is not submitted. The moments below are still the previous result.',
    title: 'Related moments',
    summary: (films, moments) => `${moments} candidates from ${films} ${films === 1 ? 'title' : 'titles'}, closest first`,
    caveat: 'Candidates may be wrong; “Closest” is not a guaranteed match. Choose any moment to continue the full video from there.',
    collapsedNote: 'Connected moments in one title are listed once, using the highest-ranked moment.',
    merged: (count, range) => `Merged ${count} connected moments · ${range}`,
    findSimilar: 'Find similar',
    findSimilarNamed: rank => `Find moments similar to No. ${rank}`,
    similarTitle: 'Moments similar to this one',
    backToResults: 'Back to search results',
    referenceLabel: 'Reference',
    playReference: 'Play reference',
    compareUsing: range => `Compared using the picture and sound of ${range}`,
    sameFilm: 'Other places in this title',
    similarSearching: 'Looking for similar moments…',
    similarSummary: (films, moments) => `${moments} candidates from ${films} ${films === 1 ? 'title' : 'titles'}, closest in picture and sound first`,
    similarFound: count => `Found ${count} similar ${count === 1 ? 'moment' : 'moments'}`,
    similarCaveat: 'These may be wrong. The reference moment, and moments that overlap or touch it, are left out. Other places in the same title are still listed.',
    similarEmpty: 'No other similar moments were found. Parts that overlap or touch the reference are not counted.',
    similarCannot: 'This moment has no usable picture and sound, so similar moments cannot be found.',
    similarDisabled: 'This moment has no usable picture and sound',
    referenceGone: 'The reference moment is no longer valid or visible, so these are the search results again.',
    referenceMark: 'Reference',
    searching: 'Looking for picture and dialogue…',
    checkingPlayer: 'Checking whether this browser can play on the page.',
    playerUnsupported: 'This browser cannot play on the page. The original player can continue from the noted time.',
    openNative: 'Open in the original player',
    fullscreen: 'Full screen',
    best: 'Closest',
    rank: rank => `No. ${rank}`,
    playFrom: range => `Play from ${range}`,
    nowPlaying: 'Now playing',
    kind: representation => (representation === 'transcriptText' ? 'Dialogue' : 'Picture and sound'),
    thumbLoading: 'Fetching the picture at this time',
    thumbMissing: 'No picture at this time',
    timeline: title => `Candidate positions in ${title}`,
    timelineUnknown: 'The full length is unknown, so only the times are listed.',
    moreShow: count => `More candidates (${count})`,
    moreHide: 'Hide more candidates',
    partialItem: 'Only part of this title is searchable',
    fallbackTitle: 'Video',
    retry: 'Try again',
    playNamed: (title, range, partial) => {
        const base = `Play ${title} from ${range}`;
        if (partial) {
            return `${base}. Only part of this title is searchable`;
        }

        return base;
    },
    notice: code => {
        switch (code) {
            case 'partial-index':
                return 'Search covers only the indexed range. Other positions cannot be searched.';
            case 'no-match':
                return 'No moment candidates were returned.';
            case 'no-match-partial':
                return 'No moment candidates were returned. Search covers only the indexed range. Other positions cannot be searched.';
            case 'nothing-searchable':
                return 'There is nothing searchable in the enabled range.';
            case 'nothing-searchable-partial':
                return 'There is nothing searchable in the enabled range. Search covers only the indexed range. Other positions cannot be searched.';
            case 'load-incomplete':
                return 'Some results could not be loaded. Try again.';
            case 'results-hidden':
                return 'These results are not available now.';
            default:
                return 'Picture search did not finish. Title search is unchanged.';
        }
    },
    problem: code => {
        switch (code) {
            case 'plugin-absent':
                return 'Picture search is not installed. Title search is unchanged.';
            case 'contract':
                return 'Picture search speaks a different interface version. Title search is unchanged.';
            case 'model-offline':
                return 'Picture search cannot reach the model right now. Title search is unchanged.';
            case 'timeout':
                return 'The search timed out. Title search is unchanged.';
            case 'busy':
                return 'Picture search is busy. Title search is unchanged.';
            case 'incompatible':
                return 'The picture index does not match the current model. An administrator needs to handle it. Title search is unchanged.';
            case 'schema-newer':
                return 'The picture index is newer than this plugin, so search is paused. Title search is unchanged.';
            case 'host-incompatible':
                return 'This server version cannot use picture search. Title search is unchanged.';
            case 'cancelled':
                return 'This picture search was cancelled.';
            case 'parent-invalid':
                return 'The current page filter cannot be used for picture search. Title results still use the original range.';
            case 'query-too-long':
                return 'That sentence is too long, so picture search did not start.';
            case 'signed-out':
                return 'The sign-in changed, so picture search was cleared.';
            case 'forbidden':
                return 'This account cannot use picture search. Title search is unchanged.';
            case 'rejected':
                return 'Picture search did not accept this request. Title search is unchanged.';
            case 'transport':
                return 'Picture search did not finish. Title search is unchanged.';
            default:
                return 'Picture search did not finish. Title search is unchanged.';
        }
    },
    similarProblem: code => {
        switch (code) {
            case 'plugin-absent':
                return 'Find similar is not installed. Title search is unchanged.';
            case 'contract':
                return 'Find similar speaks a different interface version. Title search is unchanged.';
            case 'model-offline':
                return 'Find similar cannot reach the model right now. Title search is unchanged.';
            case 'timeout':
                return 'Find similar timed out. Title search is unchanged.';
            case 'busy':
                return 'Find similar is busy. Title search is unchanged.';
            case 'incompatible':
                return 'The picture index does not match the current model. An administrator needs to handle it. Title search is unchanged.';
            case 'schema-newer':
                return 'The picture index is newer than this plugin, so find similar is paused. Title search is unchanged.';
            case 'host-incompatible':
                return 'This server version cannot find similar moments. Title search is unchanged.';
            case 'cancelled':
                return 'This similar search was cancelled.';
            case 'parent-invalid':
                return 'The current page filter cannot be used to find similar moments. Title results still use the original range.';
            case 'query-too-long':
                return 'That sentence is too long, so find similar did not start.';
            case 'signed-out':
                return 'The sign-in changed, so find similar was cleared.';
            case 'forbidden':
                return 'This account cannot find similar moments. Title search is unchanged.';
            case 'rejected':
                return 'Find similar did not accept this request. Title search is unchanged.';
            case 'transport':
                return 'Find similar did not finish. Title search is unchanged.';
            default:
                return 'Find similar did not finish. Title search is unchanged.';
        }
    },
    play: reason => {
        switch (reason) {
            case 'interrupted':
                return 'The sign-in changed, so playback did not start.';
            case 'stale':
                return 'This moment is no longer valid, so playback did not start.';
            case 'incompatible':
                return 'This moment does not match the current index, so playback did not start.';
            case 'notFound':
                return 'This moment is not available, so playback did not start.';
            case 'mismatch':
                return 'The title, media, or time did not match, so playback did not start.';
            case 'denied':
                return 'This account cannot play this title.';
            case 'play-failed':
                return 'Playback did not start.';
            case 'binding':
                return 'This moment’s version does not match, so playback did not start.';
            case 'transport':
                return 'The moment could not be confirmed, so playback did not start.';
            default:
                return 'Playback did not start.';
        }
    },
    opening: 'Checking that this moment can still be played…'
};

export function segmentCopy(locale: string | undefined): SegmentCopy {
    if ((locale ?? '').toLowerCase().startsWith('zh')) {
        return zh;
    }

    return en;
}
