import {useEffect, useRef} from 'react';

const groups = [
    {title: 'Workspace', shortcuts: [
        ['⌘B', 'Focus and reveal Todo; hide it when already focused'],
        ['⌘1 … ⌘9', 'Focus the Doing stream with that number'],
        ['⌘⌥← / ⌘⌥→', 'Focus the previous / next visible pane, wrapping'],
        ['⌃⌥Z', 'Zoom or unzoom the focused pane'],
        ['⌘T', 'Create and focus a new Doing stream'],
        ['⌘⇧H', 'Show or hide completed history in all Doing panes'],
        ['⌘⌥H', 'Show or hide history in the focused Doing pane'],
    ]},
    {title: 'Editing', shortcuts: [
        ['Return', 'Add a Todo line or a child to the active Doing chain'],
        ['⇧Return', 'Complete the selected Todo or deepest active Doing entry'],
        ['⇧Escape', 'Cancel the selected Todo or deepest active Doing entry'],
        ['⌘⇧C', 'Copy Todo text without date or completion markers'],
        ['Tab / ⇧Tab', 'Indent / unindent'],
        ['⌘Z / ⌘⇧Z', 'Undo / redo'],
        ['⌘X / ⌘C / ⌘V', 'Cut / copy / paste'],
        ['⌘A', 'Select all'],
    ]},
    {title: 'Windows and files', shortcuts: [
        ['⌘S', 'Save every pane in this window'],
        ['⌘O / ⌘N', 'Open the day picker'],
        ['↑ / ↓', 'Select a day in the day picker'],
        ['Return', 'Open the selected day; start Today if it does not exist'],
        ['Escape', 'Dismiss the day picker or this reference'],
        ['⌘` / ⌘⇧`', 'Cycle forward / backward through journal windows'],
        ['⌘,', 'Open Settings'],
        ['⌘W', 'Close this window, checking for unsaved changes'],
        ['⌘M', 'Minimize this window'],
        ['⌘H', 'Hide the app'],
        ['⌘Q', 'Quit the app'],
    ]},
];

export function ShortcutReference({onDismiss, returnFocus}: {
    onDismiss: () => void;
    returnFocus: HTMLElement | null;
}) {
    const sheet = useRef<HTMLElement>(null);
    const close = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        close.current?.focus();
        return () => returnFocus?.focus({preventScroll: true});
    }, []);

    useEffect(() => {
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                onDismiss();
            } else if (event.key === 'Tab') {
                const buttons = [...(sheet.current?.querySelectorAll<HTMLElement>('button, [href]') ?? [])];
                const index = buttons.indexOf(document.activeElement as HTMLElement);
                const next = (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
                event.preventDefault();
                buttons[next]?.focus();
            }
        };
        window.addEventListener('keydown', keydown, true);
        return () => window.removeEventListener('keydown', keydown, true);
    }, [onDismiss]);

    return <div className="shortcut-reference-backdrop" onMouseDown={event => {
        if (event.target === event.currentTarget) onDismiss();
    }}>
        <section className="shortcut-reference" role="dialog" aria-modal="true"
            aria-labelledby="shortcut-reference-title" ref={sheet}>
            <header>
                <div>
                    <h2 id="shortcut-reference-title">Keyboard shortcuts</h2>
                    <p>Hold either Command key to see hints in your workspace.</p>
                </div>
                <button type="button" className="icon-button" aria-label="Close keyboard shortcuts"
                    onClick={onDismiss} ref={close}>×</button>
            </header>
            <p className="shortcut-key">⌘ Command · ⌥ Option · ⌃ Control · ⇧ Shift</p>
            {groups.map(group => <section key={group.title}>
                <h3>{group.title}</h3>
                <dl>{group.shortcuts.map(([keys, action]) => <div key={keys}>
                    <dt><kbd>{keys}</kbd></dt><dd>{action}</dd>
                </div>)}</dl>
            </section>)}
        </section>
    </div>;
}
