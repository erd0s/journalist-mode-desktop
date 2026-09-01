// @vitest-environment jsdom

import {act} from 'react-dom/test-utils';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {LineEditor} from './LineEditor';

const timestamped = /^\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\) /;

class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
}

describe('mounted Doing editor input', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean})
            .IS_REACT_ACT_ENVIRONMENT = true;
        globalThis.ResizeObserver = ResizeObserverStub;
        window.requestAnimationFrame = callback => window.setTimeout(
            () => callback(performance.now()),
            0,
        );
        window.cancelAnimationFrame = handle => window.clearTimeout(handle);
        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = () => new DOMRect();

        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
    });

    it('timestamps keyboard typing after hidden completed history', async () => {
        const completed = '~~(2026-08-28 10:41) old task (2026-08-28 10:46)~~';
        const onChange = vi.fn();
        await act(async () => {
            root.render(
                <LineEditor
                    kind="doing"
                    lines={[completed]}
                    showCompleted={false}
                    onChange={onChange}
                />,
            );
        });

        const content = host.querySelector<HTMLElement>('.cm-content');
        const completedLine = host.querySelector<HTMLElement>('.cm-completed-hidden');
        expect(content).not.toBeNull();
        expect(completedLine?.textContent).toContain('old task');

        // jsdom does not implement native contenteditable insertion. Reproduce
        // the DOM mutation Chromium makes when the cursor is inside a hidden
        // first line: the typed character appears as a new line before it.
        content!.focus();
        content!.dispatchEvent(new KeyboardEvent('keydown', {key: 'n', bubbles: true}));
        content!.dispatchEvent(new InputEvent('beforeinput', {
            inputType: 'insertText',
            data: 'n',
            bubbles: true,
        }));
        const typedLine = document.createElement('div');
        typedLine.className = 'cm-line';
        typedLine.textContent = 'n';
        content!.insertBefore(typedLine, content!.firstChild);
        content!.dispatchEvent(new InputEvent('input', {
            inputType: 'insertText',
            data: 'n',
            bubbles: true,
        }));

        await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
        const lines = onChange.mock.lastCall![0];
        expect(lines[0]).toBe(completed);
        expect(lines[1]).toMatch(timestamped);
        expect(lines[1].endsWith('n')).toBe(true);
    });
});
