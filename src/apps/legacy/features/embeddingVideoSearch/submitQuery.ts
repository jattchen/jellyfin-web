/** Enter confirms an IME candidate instead of submitting the search. */
export function enterCommitsSearch(event: { key: string; isComposing: boolean; keyCode?: number }): boolean {
    return event.key === 'Enter' && !event.isComposing && event.keyCode !== 229;
}

/** A draft keeps the previous description results until the user submits again. */
export function isUnsubmitted(draft: string, submitted: string): boolean {
    return submitted.trim().length > 0 && draft.trim() !== submitted.trim();
}
