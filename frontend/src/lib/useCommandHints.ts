import {useEffect, useState} from 'react';

export const commandHintDelay = 500;

export function useCommandHints(enabled: boolean): boolean {
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        const held = new Set<string>();
        let timer: number | undefined;
        let usedShortcut = false;
        const hide = () => {
            window.clearTimeout(timer);
            timer = undefined;
            setVisible(false);
        };
        const reset = () => {
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
        window.addEventListener('keydown', down, true);
        window.addEventListener('keyup', up, true);
        window.addEventListener('blur', reset);
        document.addEventListener('visibilitychange', reset);
        return () => {
            reset();
            window.removeEventListener('keydown', down, true);
            window.removeEventListener('keyup', up, true);
            window.removeEventListener('blur', reset);
            document.removeEventListener('visibilitychange', reset);
        };
    }, [enabled]);
    return enabled && visible;
}
