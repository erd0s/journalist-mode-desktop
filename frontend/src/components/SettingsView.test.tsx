// @vitest-environment jsdom

import {act} from 'react-dom/test-utils';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Settings} from '../api';
import {SettingsView} from './SettingsView';

describe('SettingsView debug mode', () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean})
            .IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
    });

    it('persists the opt-in and exposes the local log folder', async () => {
        const onSave = vi.fn(async () => undefined);
        const onOpenDebugFolder = vi.fn(async () => undefined);
        await act(async () => {
            root.render(
                <SettingsView
                    settings={{
                        storageRoot: '/journal',
                        editorFont: 'system',
                        debugMode: false,
                    } as Settings}
                    debugLogDirectory="/private/debug"
                    onBack={vi.fn()}
                    onBrowse={vi.fn(async () => '')}
                    onOpenDebugFolder={onOpenDebugFolder}
                    onSave={onSave}
                />,
            );
        });

        const debugMode = host.querySelector<HTMLInputElement>('[aria-label="Enable debug mode"]')!;
        await act(async () => debugMode.click());
        const save = [...host.querySelectorAll<HTMLButtonElement>('button')]
            .find(button => button.textContent === 'Save settings')!;
        await act(async () => save.click());

        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({debugMode: true}));
        expect(host.textContent).toContain('/private/debug');

        const showLogs = [...host.querySelectorAll<HTMLButtonElement>('button')]
            .find(button => button.textContent === 'Show logs')!;
        await act(async () => showLogs.click());
        expect(onOpenDebugFolder).toHaveBeenCalledOnce();
    });
});
