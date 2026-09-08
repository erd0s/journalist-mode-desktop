// @vitest-environment jsdom
import {act} from 'react';
import {EditorView} from '@codemirror/view';
import {Events, Window as NativeWindow} from '@wailsio/runtime';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {appAPI, DayData} from '../api';
import {DayWorkspace} from './DayWorkspace';
import App from '../App';

vi.mock('@wailsio/runtime', async importOriginal => {
    const runtime = await importOriginal<typeof import('@wailsio/runtime')>();
    return {...runtime,
        Events: {...runtime.Events, On: vi.fn()},
        Window: {...runtime.Window, SetTitle: vi.fn(async () => undefined)},
    };
});

const day = {
    date: '2026-09-08',
    todo: {path: '/Todo/day', name: 'day.jmtodo.md', content: '[2026-09-08] unsaved task', exists: true, streamIndex: 0},
    doing: [1, 3, 9, 10].map(streamIndex => ({path: `/Doing/${streamIndex}`, name: `day_${streamIndex}.jm.md`,
        content: '(2026-09-08 10:00) Work', exists: true, streamIndex})),
} as DayData;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = class {observe() {} unobserve() {} disconnect() {}};
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(appAPI, 'isNative').mockReturnValue(false);
    vi.spyOn(appAPI, 'readJournalFiles').mockResolvedValue([day.todo, ...day.doing]);
    vi.useFakeTimers();
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
});
async function workspace(disabled = false) {
    await act(async () => root.render(<DayWorkspace day={day} debugMode saveRequest={0} discardRequest={0}
        newDoingRequest={0} workspaceActionRequest={{action: {type: 'focus-todo'}, revision: 0}}
        interactionDisabled={disabled} onError={vi.fn()} onSaveStateChange={vi.fn()} onSaveComplete={vi.fn()}/>));
}
async function key(type: string, init: KeyboardEventInit) {
    const event = new KeyboardEvent(type, {bubbles: true, cancelable: true, ...init});
    await act(async () => { document.activeElement!.dispatchEvent(event); });
    return event;
}
async function hold(code = 'MetaLeft') {
    await key('keydown', {key: 'Meta', code, metaKey: true});
    await act(async () => vi.advanceTimersByTime(500));
}
function hints() { return [...host.querySelectorAll('.pane-shortcut-hint')].map(node => node.textContent); }

it.each(['MetaLeft', 'MetaRight'])('reveals hints after a delay for %s with actual stream numbers, including gaps', async code => {
    await workspace();
    await key('keydown', {key: 'Meta', code, metaKey: true});
    await act(async () => vi.advanceTimersByTime(499));
    expect(hints()).toEqual([]);
    await act(async () => vi.advanceTimersByTime(1));
    expect(hints()).toEqual(['⌘B', '⌘1   ·   ⌃⌥Z  Zoom', '⌘3', '⌘9']);
    await key('keyup', {key: 'Meta', code});
    expect(hints()).toEqual([]);
});

it('does not flash on quick shortcuts or reveal while a used shortcut is still held', async () => {
    await workspace();
    await key('keydown', {key: 'Meta', code: 'MetaLeft', metaKey: true});
    await key('keydown', {key: '3', metaKey: true});
    await act(async () => vi.advanceTimersByTime(700));
    expect(hints()).toEqual([]);
    await key('keyup', {key: 'Meta', code: 'MetaLeft'});
    await hold();
    expect(hints()).toContain('⌘3   ·   ⌃⌥Z  Zoom');
});

it('retains hints when one of two held Command keys is released', async () => {
    await workspace();
    await hold();
    await key('keydown', {key: 'Meta', code: 'MetaRight', metaKey: true});
    await key('keyup', {key: 'Meta', code: 'MetaLeft', metaKey: true});
    expect(hints()).not.toEqual([]);
    await key('keyup', {key: 'Meta', code: 'MetaRight'});
    expect(hints()).toEqual([]);
});

it.each(['blur', 'visibilitychange'])('clears visible and pending hints on %s', async event => {
    await workspace();
    for (const delay of [100, 500]) {
        await key('keydown', {key: 'Meta', code: 'MetaLeft', metaKey: true});
        await act(async () => vi.advanceTimersByTime(delay));
        await act(async () => { (event === 'blur' ? window : document).dispatchEvent(new Event(event)); });
        await act(async () => vi.advanceTimersByTime(600));
        expect(hints()).toEqual([]);
    }
});

it('shows the unzoom hint in the visible zoomed pane and suppresses hints while a modal is open', async () => {
    await workspace();
    await key('keydown', {key: 'z', code: 'KeyZ', ctrlKey: true, altKey: true});
    await hold();
    const visible = [...host.querySelectorAll<HTMLElement>('.journal-pane')].filter(pane => !pane.hidden);
    expect(visible).toHaveLength(1);
    expect(visible[0].querySelector('.pane-shortcut-hint')!.textContent).toBe('⌃⌥Z  Unzoom');
    await workspace(true);
    expect(hints()).toEqual([]);
    await hold();
    expect(hints()).toEqual([]);
});

it.each([false, true])('isolates and dismisses the reference without changing workspace state (native=%s)', async native => {
    vi.spyOn(appAPI, 'isNative').mockReturnValue(native);
    const menuActions = new Map<string, Parameters<typeof Events.On>[1]>();
    vi.mocked(Events.On).mockImplementation((name, callback) => {
        menuActions.set(name, callback);
        return () => { menuActions.delete(name); };
    });
    vi.mocked(NativeWindow.SetTitle).mockResolvedValue(undefined);
    const createDoing = vi.spyOn(appAPI, 'createDoingStream');
    const saveFile = vi.spyOn(appAPI, 'saveFile');
    vi.spyOn(appAPI, 'getLaunchDate').mockResolvedValue(day.date);
    vi.spyOn(appAPI, 'openDay').mockResolvedValue(day);
    await act(async () => root.render(<App/>));
    const editor = host.querySelector<HTMLElement>('.cm-content')!;
    const view = EditorView.findFromDOM(editor.closest('.cm-editor')!)!;
    await act(async () => {
        editor.focus();
        view.dispatch({changes: {from: view.state.doc.length, insert: ' edited'},
            selection: {anchor: 5}, userEvent: 'input.type'});
    });
    await key('keydown', {key: 'z', code: 'KeyZ', ctrlKey: true, altKey: true});
    expect(host.querySelector('.pane-strip')!.classList.contains('is-zoomed')).toBe(true);
    expect(host.querySelectorAll('.save-state.dirty')).toHaveLength(1);
    const before = host.querySelector('.pane-strip')!.textContent;
    const opener = host.querySelector<HTMLButtonElement>('[aria-label="Keyboard shortcuts"]')!;
    for (const dismiss of ['escape', 'button', 'backdrop']) {
        await act(async () => opener.click());
        expect(host.querySelector('[role="dialog"]')!.textContent).toContain('⌃⌥Z');
        expect(host.querySelector('.workspace-shell')!.hasAttribute('inert')).toBe(true);
        const close = host.querySelector<HTMLButtonElement>('[aria-label="Close keyboard shortcuts"]')!;
        expect(document.activeElement).toBe(close);
        await key('keydown', {key: 'Tab'});
        expect(document.activeElement).toBe(close);
        await key('keydown', {key: '3', metaKey: true});
        if (native) {
            await act(async () => {
                for (const name of ['menu:new-doing', 'menu:save', 'menu:toggle-pane-zoom', 'menu:focus-pane', 'menu:open']) {
                    menuActions.get(name)!({name, data: 3});
                }
            });
            expect(createDoing).not.toHaveBeenCalled();
            expect(saveFile).not.toHaveBeenCalled();
            expect(host.querySelector('.day-picker-sheet')).toBeNull();
        }
        if (dismiss === 'escape') await key('keydown', {key: 'Escape'});
        else if (dismiss === 'button') await act(async () => close.click());
        else await act(async () => { host.querySelector('.shortcut-reference-backdrop')!.dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); });
        expect(host.querySelector('[role="dialog"]')).toBeNull();
        expect(host.querySelector('.cm-content')).toBe(editor);
        expect(host.querySelector('.pane-strip')!.textContent).toBe(before);
        expect(host.querySelector('.pane-strip')!.classList.contains('is-zoomed')).toBe(true);
        expect(host.querySelectorAll('.save-state.dirty')).toHaveLength(1);
        expect(view.state.selection.main.head).toBe(5);
        expect(document.activeElement).toBe(editor);
    }
});


it('clears hints when AppKit consumes a native menu shortcut before webview keydown', async () => {
    await workspace();
    await hold();
    expect(hints()).not.toEqual([]);
    await act(async () => window.dispatchEvent(new Event('journalist:native-command')));
    await act(async () => vi.advanceTimersByTime(700));
    expect(hints()).toEqual([]);
    await key('keyup', {key: 'Meta', code: 'MetaLeft'});
    await hold();
    expect(hints()).not.toEqual([]);
});


it('does not suppress the next hold after a mouse menu action or late native event', async () => {
    await workspace();
    await act(async () => window.dispatchEvent(new Event('journalist:native-command')));
    await hold();
    expect(hints()).not.toEqual([]);
});
