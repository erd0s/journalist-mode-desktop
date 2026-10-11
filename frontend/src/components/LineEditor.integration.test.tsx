// @vitest-environment jsdom

import {act} from 'react-dom/test-utils';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {LineEditor} from './LineEditor';
import {EditorView} from '@codemirror/view';

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

    it('crosses rendered clocks with one arrow key and retains click-Backspace editing', async () => {
        const timestamp = '(2026-09-30 12:00)';
        const text = `before ${timestamp} after`;
        const onChange = vi.fn();
        await act(async () => {
            root.render(<LineEditor kind="doing" lines={[text]} onChange={onChange}/>);
        });
        const content = host.querySelector<HTMLElement>('.cm-content')!;
        const view = EditorView.findFromDOM(content)!;
        const from = text.indexOf(timestamp);
        const to = from + timestamp.length;
        const key = (name: string) => content.dispatchEvent(new KeyboardEvent('keydown', {
            key: name, bubbles: true, cancelable: true,
        }));
        view.dispatch({selection: {anchor: to}});
        key('ArrowLeft');
        expect(view.state.selection.main.head).toBe(from);
        key('ArrowRight');
        expect(view.state.selection.main.head).toBe(to);
        expect(view.state.doc.toString()).toBe(text);
        expect(onChange).not.toHaveBeenCalled();

        host.querySelector<HTMLElement>('.cm-journal-clock')!.dispatchEvent(
            new MouseEvent('mousedown', {button: 0, bubbles: true, cancelable: true}),
        );
        key('Backspace');
        expect(view.state.doc.toString()).toBe(text.slice(0, to - 1) + text.slice(to));
        expect(host.querySelector('.cm-journal-clock')).toBeNull();
        expect(view.state.selection.main.head).toBe(to - 1);
        key('ArrowLeft');
        expect(view.state.selection.main.head).toBe(to - 2);

        view.dispatch({changes: {from: to - 1, insert: ')'}, selection: {anchor: to}});
        key('ArrowLeft');
        expect(view.state.selection.main.head).toBe(from);
        key('Delete');
        expect(view.state.doc.toString()).toBe(text.slice(0, from) + text.slice(from + 1));
        expect(host.querySelector('.cm-journal-clock')).toBeNull();
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
        const interaction = onChange.mock.lastCall![1];
        expect(lines[0]).toBe(completed);
        expect(lines[1]).toMatch(timestamped);
        expect(lines[1].endsWith('n')).toBe(true);
        expect(interaction.userEvents).toContain('input.type');
        expect(JSON.parse(interaction.changes)).toBeInstanceOf(Array);
        expect(JSON.parse(interaction.selectionAfter)).toHaveProperty('ranges');
    });
});
