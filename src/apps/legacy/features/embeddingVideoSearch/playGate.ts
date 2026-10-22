import { playConfirmedSegment, type PlayInput } from './playback';
import type { PlayResult } from './types';

export interface PlayGate {
    generation: number
    scope: string
}

export interface PlayTicket {
    generation: number
    scope: string
}

export function retirePlayGate(gate: PlayGate, scope: string): PlayGate {
    if (gate.scope === scope) {
        return gate;
    }

    return {
        generation: gate.generation + 1,
        scope
    };
}

export function issuePlayTicket(gate: PlayGate, scope: string): { gate: PlayGate; ticket: PlayTicket } {
    const next = {
        generation: gate.generation + 1,
        scope
    };
    return {
        gate: next,
        ticket: {
            generation: next.generation,
            scope
        }
    };
}

export function ticketStillCurrent(ticket: PlayTicket, gate: PlayGate, sessionMatches: boolean): boolean {
    return sessionMatches && ticket.generation === gate.generation && ticket.scope === gate.scope;
}

export async function runScopedPlay(
    input: Omit<PlayInput, 'stillCurrent'> & {
        ticket: PlayTicket
        readGate: () => PlayGate
        sessionMatches: () => boolean
    }
): Promise<PlayResult> {
    return playConfirmedSegment({
        clicked: input.clicked,
        signal: input.signal,
        fetchSegment: input.fetchSegment,
        fetchItem: input.fetchItem,
        play: input.play,
        stillCurrent: () => ticketStillCurrent(input.ticket, input.readGate(), input.sessionMatches())
    });
}
