import type { Api } from '@jellyfin/sdk';

import { guidKey } from './guid';
import { loadOfficialItem } from './items';
import { applyItemLoads } from './results';
import { listedHits, runSegmentSearch } from './searchRun';
import { createSdkTransport, isAbortError, type PluginTransport } from './transport';
import type { ItemCard, ItemLoad, ProblemCode, ReadySegmentView } from './types';

export interface SearchExecution {
    api: Api
    userId: string
    query: string
    parentId?: string
    clientQueryId: string
    signal: AbortSignal
    transport?: PluginTransport
    loadItem?: (itemId: string, signal: AbortSignal) => Promise<ItemLoad>
}

export type SearchExecutionResult =
    | { kind: 'aborted' }
    | { kind: 'problem'; problem: ProblemCode }
    | { kind: 'ready'; view: ReadySegmentView; cards: Map<string, ItemCard> };

async function loadCards(
    view: ReadySegmentView,
    signal: AbortSignal,
    loadItem: (itemId: string, signal: AbortSignal) => Promise<ItemLoad>
): Promise<{ loads: Map<string, ItemLoad>; cards: Map<string, ItemCard> }> {
    const loads = new Map<string, ItemLoad>();
    const cards = new Map<string, ItemCard>();
    const jobs = uniqueItemIds(listedHits(view)).map(async (itemId) => {
        const load = await loadItem(itemId, signal);
        const key = guidKey(itemId);
        if (!key) {
            return;
        }

        loads.set(key, load);
        if (load.status === 'ready') {
            cards.set(key, load.card);
        }
    });
    await Promise.all(jobs);
    return { loads, cards };
}

function uniqueItemIds(hits: ReturnType<typeof listedHits>): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
        const key = guidKey(hit.itemId);
        if (!key || seen.has(key)) {
            continue;
        }

        seen.add(key);
        ids.push(hit.itemId);
    }

    return ids;
}

export async function executeEmbeddingSearch(input: SearchExecution): Promise<SearchExecutionResult> {
    const transport = input.transport ?? createSdkTransport(input.api);
    const loadItem = input.loadItem ?? ((itemId, signal) => loadOfficialItem(input.api, input.userId, itemId, signal));
    try {
        const result = await runSegmentSearch(transport, {
            query: input.query,
            parentId: input.parentId,
            clientQueryId: input.clientQueryId,
            signal: input.signal
        });
        if (input.signal.aborted || result.kind === 'aborted') {
            return { kind: 'aborted' };
        }

        if (result.kind === 'problem') {
            return result;
        }

        const loaded = await loadCards(result.view, input.signal, loadItem);
        if (input.signal.aborted) {
            return { kind: 'aborted' };
        }

        return {
            kind: 'ready',
            view: applyItemLoads(result.view, loaded.loads),
            cards: loaded.cards
        };
    } catch (error) {
        if (isAbortError(error) || input.signal.aborted) {
            return { kind: 'aborted' };
        }

        return { kind: 'problem', problem: 'transport' };
    }
}
