// @vitest-environment jsdom
import {act, useEffect} from 'react';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import App from './App';

const harness = vi.hoisted(() => ({
    events: new Map<string, (event: {data: unknown}) => void>(),
    approve: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    state: 'dirty',
    succeeded: true,
    discardRequests: [] as number[],
    setState: (_state: string) => {},
}));
vi.mock('@wailsio/runtime', () => ({
    Events: {On: (name: string, handler: (event: {data: unknown}) => void) => {
        harness.events.set(name, handler);
        return () => harness.events.delete(name);
    }},
    Window: {SetTitle: vi.fn(async () => undefined)},
}));
vi.mock('./api', () => ({appAPI: {
    isNative: () => true,
    isSettingsWindow: () => false,
    getSettings: async () => ({storageRoot: '/journal', editorFont: 'system', debugMode: false}),
    listDays: async () => [],
    getLaunchDate: async () => '2026-09-08',
    openDay: async () => ({date: '2026-09-08', todo: {}, doing: []}),
    approveQuit: harness.approve,
    cancelQuit: harness.cancel,
    closeWindow: harness.close,
}}));
vi.mock('./components/DayWorkspace', () => ({DayWorkspace: (props: any) => {
    harness.setState = props.onSaveStateChange;
    useEffect(() => props.onSaveStateChange(harness.state), []);
    useEffect(() => {
        if (props.saveRequest) props.onSaveComplete(props.saveRequest, harness.succeeded);
    }, [props.saveRequest]);
    useEffect(() => { harness.discardRequests.push(props.discardRequest); }, [props.discardRequest]);
    return <button disabled={props.interactionDisabled}>Journal editor</button>;
}}));

describe('application quit coordination', () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(async () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        harness.events.clear(); vi.clearAllMocks();
        harness.state = 'dirty'; harness.succeeded = true; harness.discardRequests = [];
        host = document.createElement('div'); document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => root.render(<App/>));
    });
    afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
    const event = async (name: string, data: unknown) => {
        await act(async () => harness.events.get(name)!({data}));
    };
    const click = async (text: string) => {
        const button = [...host.querySelectorAll('button')].find(item => item.textContent === text);
        expect(button).toBeDefined();
        await act(async () => button!.click());
    };

    it('retains discarded text and the window until every journal consents; cancel restores editing', async () => {
        await event('app:prepare-quit', {token: 1, update: true});
        expect(host.textContent).toContain('Save changes before updating?');
        await click('Discard Changes');
        await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
        expect(harness.approve).toHaveBeenCalledWith(1);
        expect(harness.close).not.toHaveBeenCalled();
        expect(harness.discardRequests).toEqual([0]);
        expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
        await event('app:cancel-quit', 1);
        expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false);
        await event('app:prepare-quit', {token: 1, update: true});
        expect(host.textContent).not.toContain('Save changes before updating?');
    });

    it('does not approve a failed save and allows returning to the editor', async () => {
        harness.succeeded = false;
        await event('app:prepare-quit', {token: 2, update: true});
        await click('Save and Continue');
        expect(host.textContent).toContain('Couldn’t save this window');
        expect(harness.approve).not.toHaveBeenCalled();
        await click('Keep Editing');
        expect(harness.cancel).toHaveBeenCalledWith(2);
    });

    it('waits for an in-flight save before approving without closing the journal', async () => {
        await act(async () => harness.setState('saving'));
        await event('app:prepare-quit', {token: 3, update: true});
        expect(harness.approve).not.toHaveBeenCalled();
        expect(host.textContent).toContain('Finishing the current save');
        await act(async () => harness.setState('saved'));
        expect(harness.approve).toHaveBeenCalledWith(3);
        expect(harness.close).not.toHaveBeenCalled();
    });

    it('uses the same save guard for ordinary Quit and blocks native editor commands while waiting', async () => {
        await event('app:prepare-quit', {token: 4, update: false});
        expect(host.textContent).toContain('Save changes before quitting?');
        await event('menu:save', null);
        expect(harness.approve).not.toHaveBeenCalled();
        await click('Save and Continue');
        expect(harness.approve).toHaveBeenCalledWith(4);
        await event('window:close-request', null);
        expect(harness.close).not.toHaveBeenCalled();
    });
});
