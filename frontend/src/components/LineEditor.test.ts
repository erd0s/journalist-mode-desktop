import {EditorState, Transaction} from '@codemirror/state';
import {describe, expect, it} from 'vitest';
import {doingInputGuard} from './LineEditor';

const timestamped = /^\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\) /;

function insert(
    doc: string,
    text: string,
    userEvent: 'input.type' | 'input.paste',
    from = 0,
    to = from,
    completedHidden = false,
): EditorState {
    const state = EditorState.create({doc, extensions: doingInputGuard(completedHidden)});
    return state.update({
        changes: {from, to, insert: text},
        annotations: Transaction.userEvent.of(userEvent),
    }).state;
}

describe('Doing editor input', () => {
    it.each([
        ['typing', 'input.type' as const, 'w'],
        ['pasting', 'input.paste' as const, 'write tests'],
    ])('timestamps %s into an empty file', (_label, userEvent, text) => {
        const next = insert('', text, userEvent);

        expect(next.doc.toString()).toMatch(timestamped);
        expect(next.doc.toString().endsWith(text)).toBe(true);
    });

    it('redirects typing away from hidden completed history', () => {
        const completed = '~~(2026-08-28 10:41) old task (2026-08-28 10:46)~~';
        const next = insert(completed, 'n', 'input.type', 10, 10, true);
        const lines = next.doc.toString().split('\n');

        expect(lines[0]).toBe(completed);
        expect(lines[1]).toMatch(timestamped);
        expect(lines[1].endsWith('n')).toBe(true);
    });

    it('redirects pasted text without modifying multiple hidden entries', () => {
        const completed = [
            '~~(2026-08-28 10:00) first (2026-08-28 10:10)~~',
            '\t~~(2026-08-28 10:01) second (2026-08-28 10:09)~~',
        ];
        const original = completed.join('\n');
        const next = insert(original, 'new task', 'input.paste', 8, 20, true);
        const lines = next.doc.toString().split('\n');

        expect(lines.slice(0, 2)).toEqual(completed);
        expect(lines[2]).toMatch(timestamped);
        expect(lines[2].endsWith('new task')).toBe(true);
    });

    it('allows editing completed entries while history is shown', () => {
        const completed = '~~(2026-08-28 10:41) old task (2026-08-28 10:46)~~';
        const next = insert(completed, ' updated', 'input.type', 30);

        expect(next.doc.toString()).toBe(`${completed.slice(0, 30)} updated${completed.slice(30)}`);
    });
});
