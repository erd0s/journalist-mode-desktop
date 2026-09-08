import {useEffect, useState} from 'react';
import {Events} from '@wailsio/runtime';
import {appAPI} from '../api';

export const commandHintDelay = 500;

export function useCommandHints(enabled: boolean, debugMode = false): boolean {
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        const held = new Set<string>();
        let timer: number | undefined;
        let usedShortcut = false;
        const trace = (action: string, details: Record<string, string> = {}) => {
            if (!debugMode) return;
            void appAPI.recordDebugEvents([{clientTimestamp: new Date().toISOString(), sequence: 0,
                window: '', category: 'keyboard-hints', action, details, files: []}]).catch(() => undefined);
        };
        const hide = () => {
            trace('hide');
            window.clearTimeout(timer);
            timer = undefined;
            setVisible(false);
        };
        const reset = () => {
            trace('reset');
            hide();
            held.clear();
            usedShortcut = false;
        };
        reset();
        if (!enabled) {
            return;
        }
        const down = (event: KeyboardEvent) => {
            if (event.key !== 'Meta') {
                if (event.metaKey) {
                    usedShortcut = true;
                    hide();
                }
                return;
            }
            const wasHeld = held.size > 0;
            held.add(event.code || 'Meta');
            if (!wasHeld && !event.repeat && !usedShortcut) {
                timer = window.setTimeout(() => setVisible(true), commandHintDelay);
            }
        };
        const up = (event: KeyboardEvent) => {
            if (event.key === 'Meta') {
                held.delete(event.code || 'Meta');
            }
            if (!event.metaKey || held.size === 0) {
                reset();
            }
        };
        // AppKit can consume menu accelerators before the webview receives a
        // keydown. Treat the native command as use of the held modifier too.
        const commandUsed = () => {
            trace('command_used');
            usedShortcut = held.size > 0;
            hide();
        };
        let lastSequence = 0;
        const native = appAPI.isNative();
        const stopNative = native ? Events.On('keyboard:command-state', event => {
            const state = event.data as {held: boolean; used: boolean; sequence: number};
            trace('native_state', {state: JSON.stringify(state), lastSequence: String(lastSequence)});
            if (state.sequence <= lastSequence) return;
            lastSequence = state.sequence;
            if (!state.held) {
                reset();
                return;
            }
            const wasHeld = held.size > 0;
            held.add('native');
            if (state.used) {
                usedShortcut = true;
                hide();
            } else if (!wasHeld && !usedShortcut) {
                timer = window.setTimeout(() => { trace('show'); setVisible(true); }, commandHintDelay);
            }
        }) : undefined;
        window.addEventListener('journalist:native-command', commandUsed);
        window.addEventListener('copy', commandUsed);
        window.addEventListener('cut', commandUsed);
        window.addEventListener('paste', commandUsed);
        if (!native) {
            window.addEventListener('keydown', down, true);
            window.addEventListener('keyup', up, true);
        }
        window.addEventListener('blur', reset);
        document.addEventListener('visibilitychange', reset);
        return () => {
            reset();
            stopNative?.();
            window.removeEventListener('journalist:native-command', commandUsed);
            window.removeEventListener('copy', commandUsed);
            window.removeEventListener('cut', commandUsed);
            window.removeEventListener('paste', commandUsed);
            window.removeEventListener('keydown', down, true);
            window.removeEventListener('keyup', up, true);
            window.removeEventListener('blur', reset);
            document.removeEventListener('visibilitychange', reset);
        };
    }, [enabled, debugMode]);
    return enabled && visible;
}
