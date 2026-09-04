// @vitest-environment jsdom

import {afterEach, describe, expect, it, vi} from 'vitest';
import './welcomeTitleBand';

describe('welcome title band double-click guard', () => {
    const later = vi.fn();
    let mounted: HTMLElement | null = null;

    afterEach(() => {
        window.removeEventListener('dblclick', later, true);
        mounted?.remove();
        mounted = null;
        later.mockReset();
    });

    function mount(shellClass: string) {
        const shell = document.createElement('main');
        shell.className = shellClass;
        const band = document.createElement('div');
        band.className = 'window-drag-region';
        shell.appendChild(band);
        document.body.appendChild(shell);
        mounted = shell;
        return band;
    }

    it('stops a double-click on the welcome band before later capture listeners see it', () => {
        const band = mount('welcome-shell');
        window.addEventListener('dblclick', later, true);
        band.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true}));
        expect(later).not.toHaveBeenCalled();
    });

    it('lets double-clicks on other windows\' bands through', () => {
        const band = mount('workspace-shell');
        window.addEventListener('dblclick', later, true);
        band.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true}));
        expect(later).toHaveBeenCalledOnce();
    });
});
