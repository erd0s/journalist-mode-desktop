// @vitest-environment jsdom

import {describe, expect, it, vi} from 'vitest';
import {DebugEvent} from '../api';
import {DebugRecorder, keyboardDetails, targetDetails} from './debug';

describe('DebugRecorder', () => {
    it('preserves every event, sequence, and capture-time snapshot in ordered batches', async () => {
        const writes: unknown[][] = [];
        let content = 'first';
        const recorder = new DebugRecorder({
            write: async events => { writes.push(events); },
            context: () => ({
                window: 'day:2026-09-01',
                files: [{
                    path: '/journal/Doing/day.jm.md',
                    name: 'day.jm.md',
                    kind: 'doing',
                    streamIndex: 1,
                    content,
                    diskContent: '',
                    saveState: 'dirty',
                    completedVisible: false,
                    focused: true,
                    visible: true,
                }],
            }),
            onError: vi.fn(),
            flushDelay: 60_000,
        });

        recorder.setEnabled(true);
        await recorder.record({category: 'input', action: 'keydown'});
        content = 'second';
        await recorder.record({category: 'editor', action: 'transaction'});
        await recorder.flush();

        const events = writes.flat() as Array<{sequence: number; files: Array<{content: string}>}>;
        expect(events.map(event => event.sequence)).toEqual([1, 2, 3]);
        expect(events.map(event => event.files[0].content)).toEqual(['first', 'first', 'second']);
    });

    it('flushes a checkpoint immediately', async () => {
        const writes: DebugEvent[][] = [];
        const write = vi.fn(async (events: DebugEvent[]) => { writes.push(events); });
        const recorder = new DebugRecorder({
            write,
            context: () => ({window: 'day:test', files: []}),
            onError: vi.fn(),
            flushDelay: 60_000,
        });
        recorder.setEnabled(true);
        await recorder.record({category: 'checkpoint', action: 'user_checkpoint'}, true);

        expect(write).toHaveBeenCalledOnce();
        expect(writes[0]?.at(-1)?.category).toBe('checkpoint');
    });
});

describe('debug interaction metadata', () => {
    it('never copies input values and redacts printable keys', () => {
        const input = document.createElement('input');
        input.value = 'private journal text';
        input.setAttribute('aria-label', 'Journal folder');
        const event = new KeyboardEvent('keydown', {key: 's', code: 'KeyS'});
        Object.defineProperty(event, 'target', {value: input});

        expect(targetDetails(input)).not.toHaveProperty('value');
        expect(keyboardDetails(event)).toMatchObject({
            target: 'input',
            label: 'Journal folder',
            key: 'printable',
            code: '',
        });
    });
});
