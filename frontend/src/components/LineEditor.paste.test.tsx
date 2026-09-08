// @vitest-environment jsdom
import {EditorView} from '@codemirror/view';
import {undo, redo} from '@codemirror/commands';
import {act} from 'react';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {LineEditor} from './LineEditor';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = class {observe() {} unobserve() {} disconnect() {}};
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    vi.setSystemTime(new Date(2026, 8, 8, 23, 59));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
});

async function mount(text = '', kind: 'todo' | 'doing' = 'todo') {
    const onChange = vi.fn();
    await act(async () => root.render(<LineEditor kind={kind} lines={text.split('\n')} onChange={onChange}/>));
    const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;
    return {view, onChange};
}
async function paste(view: EditorView, text: string) {
    const event = new Event('paste', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'clipboardData', {value: {getData: () => text}});
    await act(async () => { view.focus(); view.contentDOM.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
}

it('dates a single-line Todo paste through the mounted editor input path', async () => {
    const {view, onChange} = await mount();
    await paste(view, 'A pasted task');
    expect(view.state.doc.toString()).toBe('[2026-09-08] A pasted task');
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(onChange.mock.lastCall![1].userEvents).toBe('input.paste');
});

it('dates multiline tasks while preserving indentation and all existing exemptions', async () => {
    const {view} = await mount();
    await paste(view, 'first\n\tchild\n# Work\n\n---\n~~done~~\n[2020-01-02] dated\nlast\n');
    expect(view.state.doc.toString()).toBe('[2026-09-08] first\n\t[2026-09-08] child\n# Work\n\n---\n~~done~~\n[2020-01-02] dated\n[2026-09-08] last\n');
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
});

it.each(['# Heading', '---', '~~completed~~', '[2020-01-02] dated', '   '])('leaves an exempt single-line paste unchanged: %s', async text => {
    const {view} = await mount();
    await paste(view, text);
    expect(view.state.doc.toString()).toBe(text);
});

it('replaces the selected text and undoes the whole paste, including dates, in one step', async () => {
    const initial = '# Before\nreplace me\n# After';
    const {view} = await mount(initial);
    await act(async () => view.dispatch({selection: {anchor: 9, head: 19}}));
    await paste(view, 'one\ntwo');
    const expected = '# Before\n[2026-09-08] one\n[2026-09-08] two\n# After';
    expect(view.state.doc.toString()).toBe(expected);
    expect(view.state.selection.main.head).toBe(expected.indexOf('\n# After'));
    await act(async () => { undo(view); });
    expect(view.state.doc.toString()).toBe(initial);
    await act(async () => { redo(view); });
    expect(view.state.doc.toString()).toBe(expected);
});

it('preserves surrounding text when a multiline paste splits a dated task', async () => {
    const {view} = await mount('[2020-01-02] before after\nuntouched');
    await act(async () => view.dispatch({selection: {anchor: 20}}));
    await paste(view, 'one\ntwo');
    expect(view.state.doc.toString()).toBe('[2020-01-02] before one\n[2026-09-08] twoafter\nuntouched');
});

it('does not date the untouched line following a trailing paste newline', async () => {
    const {view} = await mount('untouched');
    await paste(view, 'one\n');
    expect(view.state.doc.toString()).toBe('[2026-09-08] one\nuntouched');
});

it('keeps multiline Doing paste unchanged', async () => {
    const {view} = await mount('', 'doing');
    await paste(view, 'one\ntwo');
    expect(view.state.doc.toString()).toBe('one\ntwo');
});

it('omits a pasted Done divider when the existing boundary survives, in the same undo step', async () => {
    const initial = '\n---\n~~existing done task~~';
    const {view} = await mount(initial);
    await paste(view, 'new task\n---\n~~pasted done task~~');
    const expected = '[2026-09-08] new task\n\n~~pasted done task~~\n---\n~~existing done task~~';
    expect(view.state.doc.toString()).toBe(expected);
    await act(async () => { undo(view); });
    expect(view.state.doc.toString()).toBe(initial);
    await act(async () => { redo(view); });
    expect(view.state.doc.toString()).toBe(expected);
});

it('keeps a pasted Done divider when replacing the old document including its boundary', async () => {
    const {view} = await mount('old task\n---\n~~old done task~~');
    await act(async () => view.dispatch({selection: {anchor: 0, head: view.state.doc.length}}));
    await paste(view, 'new task\n---\n~~new done task~~');
    expect(view.state.doc.toString()).toBe('[2026-09-08] new task\n---\n~~new done task~~');
});

it('leaves the original blank line when a duplicate divider alone is pasted', async () => {
    const initial = '\n---\n~~existing done task~~';
    const {view} = await mount(initial);
    await paste(view, '---');
    expect(view.state.doc.toString()).toBe(initial);
});

it('leaves a pre-existing undated line unchanged except for the intended insertion', async () => {
    const {view} = await mount('before after');
    await act(async () => view.dispatch({selection: {anchor: 7}}));
    await paste(view, 'pasted ');
    expect(view.state.doc.toString()).toBe('before pasted after');
});

it('dates new lines without rewriting the existing head when pasting into an undated task', async () => {
    const {view} = await mount('before after');
    await act(async () => view.dispatch({selection: {anchor: 7}}));
    await paste(view, 'one\ntwo ');
    expect(view.state.doc.toString()).toBe('before one\n[2026-09-08] two after');
});
