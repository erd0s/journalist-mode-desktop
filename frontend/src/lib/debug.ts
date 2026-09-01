import {DebugEvent, DebugFileSnapshot} from '../api';

const defaultFlushDelay = 150;
const defaultBatchSize = 10;

export type DebugEventDraft = {
    category: string;
    action: string;
    details?: Record<string, string>;
    files?: DebugFileSnapshot[];
};

type DebugContext = {
    window: string;
    files: DebugFileSnapshot[];
};

type DebugRecorderOptions = {
    write: (events: DebugEvent[]) => Promise<void>;
    context: () => DebugContext;
    onError: (reason: unknown) => void;
    flushDelay?: number;
    batchSize?: number;
};

// DebugRecorder captures every event immediately, then sends small ordered
// batches across the native bridge so the recorder does not make typing wait
// for a filesystem write.
export class DebugRecorder {
    private enabled = false;
    private disposed = false;
    private sequence = 0;
    private pending: DebugEvent[] = [];
    private timer: number | undefined;
    private writeChain: Promise<void> = Promise.resolve();
    private errorReported = false;
    private readonly flushDelay: number;
    private readonly batchSize: number;

    constructor(private readonly options: DebugRecorderOptions) {
        this.flushDelay = options.flushDelay ?? defaultFlushDelay;
        this.batchSize = options.batchSize ?? defaultBatchSize;
    }

    setEnabled(enabled: boolean) {
        if (this.enabled === enabled || this.disposed) {
            return;
        }
        this.enabled = enabled;
        this.errorReported = false;
        if (!enabled) {
            this.cancelTimer();
            this.pending = [];
            return;
        }
        this.sequence = 0;
        void this.record({category: 'session', action: 'recording_started'});
    }

    record(draft: DebugEventDraft, immediate = false): Promise<void> {
        if (!this.enabled || this.disposed) {
            return Promise.resolve();
        }
        const context = this.options.context();
        this.sequence += 1;
        this.pending.push({
            clientTimestamp: new Date().toISOString(),
            sequence: this.sequence,
            window: context.window,
            category: draft.category,
            action: draft.action,
            details: {...(draft.details ?? {})},
            files: (draft.files ?? context.files).map(file => ({...file})),
        } as DebugEvent);

        if (immediate || this.pending.length >= this.batchSize) {
            return this.flush();
        }
        if (this.timer === undefined) {
            this.timer = window.setTimeout(() => void this.flush(), this.flushDelay);
        }
        return Promise.resolve();
    }

    flush(): Promise<void> {
        this.cancelTimer();
        if (this.pending.length === 0) {
            return this.writeChain;
        }
        const batch = this.pending.splice(0);
        const operation = this.writeChain.then(() => this.options.write(batch));
        this.writeChain = operation.catch(reason => {
            if (!this.errorReported) {
                this.errorReported = true;
                this.options.onError(reason);
            }
        });
        return operation;
    }

    dispose() {
        if (this.disposed) {
            return;
        }
        if (this.enabled) {
            void this.flush();
        } else {
            this.cancelTimer();
        }
        this.disposed = true;
    }

    private cancelTimer() {
        if (this.timer !== undefined) {
            window.clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
}

export function targetDetails(target: EventTarget | null): Record<string, string> {
    if (!(target instanceof Element)) {
        return {target: 'unknown'};
    }
    const details: Record<string, string> = {
        target: target.tagName.toLowerCase(),
    };
    const role = target.getAttribute('role');
    const label = target.getAttribute('aria-label');
    if (role) {
        details.role = role;
    }
    if (label) {
        details.label = label;
    }
    if (target instanceof HTMLButtonElement) {
        details.button = compactText(target.textContent);
    }
    return details;
}

export function keyboardDetails(event: KeyboardEvent): Record<string, string> {
    const printable = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
    return {
        ...targetDetails(event.target),
        key: printable ? 'printable' : event.key,
        code: printable ? '' : event.code,
        repeat: String(event.repeat),
        composing: String(event.isComposing),
        modifiers: [
            event.metaKey ? 'meta' : '',
            event.ctrlKey ? 'control' : '',
            event.altKey ? 'alt' : '',
            event.shiftKey ? 'shift' : '',
        ].filter(Boolean).join(','),
    };
}

function compactText(value: string | null): string {
    return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}
