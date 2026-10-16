import type { NoticeCode, PlayRefusal, ProblemCode } from './types';

export interface SegmentCopy {
    nameSearch: string
    searchAction: string
    unsubmitted: string
    title: string
    intro: string
    searching: string
    checkingPlayer: string
    playerIdle: string
    playerUnsupported: string
    openNative: string
    fullscreen: string
    previewHint: string
    previewLoading: string
    previewBusy: string
    previewMissing: string
    timelineUnknown: string
    weakShow: (count: number) => string
    weakHide: (count: number) => string
    partialItem: string
    fallbackTitle: string
    retry: string
    playNamed: (title: string, range: string, partial: boolean) => string
    notice: (code: NoticeCode) => string
    problem: (code: ProblemCode) => string
    play: (reason: PlayRefusal) => string
    opening: string
}

const zh: SegmentCopy = {
    nameSearch: '名称搜索',
    searchAction: '查找画面与对白',
    unsubmitted: '这句话还没提交。下面仍是上次的结果。',
    title: '相关片段候选',
    intro: '描述画面或对白的含义，提交后按整部影片查看。点一个时间会从原片的该处继续播放。只有已建立索引的片段可以搜索。候选可能有误。',
    searching: '正在查找画面与对白…',
    checkingPlayer: '正在确认这个浏览器能不能在页面里播放。',
    playerIdle: '选择一个时间后，会在这里从原片的该处继续播放。',
    playerUnsupported: '这个浏览器不能在页面里直接播放。可以改用原来的播放器，从记下的时间继续。',
    openNative: '用原来的播放器打开',
    fullscreen: '全屏',
    previewHint: '悬停、聚焦或点按一个时间，查看该处的文字。画面要等这一帧的预览，不会用海报代替。',
    previewLoading: '正在取这一时刻的画面。',
    previewBusy: '这一帧正忙，请稍后再试。',
    previewMissing: '没有这一时刻的画面。不会用海报代替。',
    timelineUnknown: '还不知道整部有多长，所以这里只列出时间。',
    weakShow: count => `可能相关（${count}）`,
    weakHide: count => `收起可能相关（${count}）`,
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
    nameSearch: 'Name search',
    searchAction: 'Search picture and dialogue',
    unsubmitted: 'This sentence is not submitted. The moments below are still the previous result.',
    title: 'Related moment candidates',
    intro: 'Describe a picture or dialogue, then submit to see hits by film. Choosing a time continues from that point in the full video. Only indexed moments can be searched. Candidates may be wrong.',
    searching: 'Looking for picture and dialogue…',
    checkingPlayer: 'Checking whether this browser can play on the page.',
    playerIdle: 'Choose a time to continue from that point in the full video.',
    playerUnsupported: 'This browser cannot play on the page. The original player can continue from the noted time.',
    openNative: 'Open in the original player',
    fullscreen: 'Full screen',
    previewHint: 'Hover, focus, or tap a time to read its words. The picture waits for that frame and is not the poster.',
    previewLoading: 'Fetching the picture at this time.',
    previewBusy: 'This frame is busy. Try again later.',
    previewMissing: 'No picture is available at this time. The poster is not used instead.',
    timelineUnknown: 'The full length is unknown, so only the times are listed.',
    weakShow: count => `Possibly related (${count})`,
    weakHide: count => `Hide possibly related (${count})`,
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
