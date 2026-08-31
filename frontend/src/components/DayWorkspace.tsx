import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {appAPI, DayData, JournalFile} from '../api';
import {contentToLines, linesToContent} from '../lib/journal';
import {
    aggregateSaveState,
    adjacentPanePath,
    createSaveBatch,
    nextAllDoingHistoryVisibility,
    recordSaveBatchResult,
    SaveBatch,
    WorkspaceAction,
    WorkspaceActionRequest,
    WorkspaceSaveState,
    workspaceActionForShortcut,
} from '../lib/workspace';
import {LineEditor} from './LineEditor';

const diskPollInterval = 750;

export type {WorkspaceSaveState} from '../lib/workspace';

type DayWorkspaceProps = {
    day: DayData;
    saveRequest: number;
    discardRequest: number;
    newDoingRequest: number;
    workspaceActionRequest: WorkspaceActionRequest;
    interactionDisabled: boolean;
    onError: (message: string) => void;
    onSaveStateChange: (state: WorkspaceSaveState) => void;
    onSaveComplete: (revision: number, succeeded: boolean) => void;
};

export function DayWorkspace({
    day,
    saveRequest,
    discardRequest,
    newDoingRequest,
    workspaceActionRequest,
    interactionDisabled,
    onError,
    onSaveStateChange,
    onSaveComplete,
}: DayWorkspaceProps) {
    const [doingFiles, setDoingFiles] = useState<JournalFile[]>(day.doing);
    const files = useMemo(() => [day.todo, ...doingFiles], [day.todo, doingFiles]);
    const paths = useMemo(() => files.map(file => file.path), [files]);
    const [focusedPath, setFocusedPath] = useState(doingFiles[0]?.path ?? day.todo.path);
    const [todoVisible, setTodoVisible] = useState(true);
    const [zoomedPath, setZoomedPath] = useState('');
    const [doingHistoryVisible, setDoingHistoryVisible] = useState<Record<string, boolean>>({});
    const [editorFocus, setEditorFocus] = useState({path: '', revision: 0});
    const [diskContents, setDiskContents] = useState<Record<string, string>>(
        () => contentsByPath(files),
    );
    const saveStates = useRef<Record<string, WorkspaceSaveState>>(
        Object.fromEntries(files.map(file => [file.path, 'saved'])),
    );
    const handledNewDoingRequest = useRef(newDoingRequest);
    const handledWorkspaceAction = useRef(workspaceActionRequest.revision);
    const createChain = useRef<Promise<void>>(Promise.resolve());
    const saveBatches = useRef(new Map<number, SaveBatch>());
    const preparedSaveRequest = useRef(saveRequest);
    const mounted = useRef(true);
    const currentDate = useRef(day.date);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    useEffect(() => {
        currentDate.current = day.date;
        setDoingFiles(day.doing);
        setFocusedPath(day.doing[0]?.path ?? day.todo.path);
        setTodoVisible(true);
        setZoomedPath('');
        setDoingHistoryVisible({});
        setEditorFocus({path: '', revision: 0});
        saveStates.current = Object.fromEntries(
            [day.todo, ...day.doing].map(file => [file.path, 'saved']),
        );
        saveBatches.current.clear();
        preparedSaveRequest.current = saveRequest;
        handledNewDoingRequest.current = newDoingRequest;
        handledWorkspaceAction.current = workspaceActionRequest.revision;
        createChain.current = Promise.resolve();
    }, [day.date]);

    useEffect(() => {
        if (focusedPath === day.todo.path || doingFiles.some(file => file.path === focusedPath)) {
            return;
        }
        setFocusedPath(doingFiles[0]?.path ?? (todoVisible ? day.todo.path : ''));
    }, [day.todo.path, doingFiles, focusedPath, todoVisible]);

    useEffect(() => {
        setDiskContents(contentsByPath(files));
    }, [files]);

    useEffect(() => {
        const next: Record<string, WorkspaceSaveState> = {};
        for (const path of paths) {
            next[path] = saveStates.current[path] ?? 'saved';
        }
        saveStates.current = next;
        const states = paths.map(path => next[path]);
        onSaveStateChange(aggregateSaveState(states));
    }, [onSaveStateChange, paths]);

    useEffect(() => {
        if (preparedSaveRequest.current === saveRequest) {
            return;
        }
        // Freeze the participants as soon as a Save All begins. A Doing stream
        // created while saves are in flight already exists safely on disk and
        // must not make this batch wait for a completion it never requested.
        preparedSaveRequest.current = saveRequest;
        saveBatches.current.set(saveRequest, createSaveBatch(paths));
    }, [saveRequest]);

    useEffect(() => {
        let stopped = false;
        let reading = false;

        const readDisk = async () => {
            if (reading) {
                return;
            }
            reading = true;
            try {
                const snapshots = await appAPI.readJournalFiles(paths);
                if (!stopped) {
                    setDiskContents(current => mergeSnapshots(current, snapshots));
                }
            } catch {
                // A transient read failure should not disrupt typing. The next
                // poll retries; explicit saves still surface their own errors.
            } finally {
                reading = false;
            }
        };

        void readDisk();
        const interval = window.setInterval(readDisk, diskPollInterval);
        return () => {
            stopped = true;
            window.clearInterval(interval);
        };
    }, [paths]);

    const updateDiskContent = useCallback((path: string, nextContent: string) => {
        setDiskContents(current => current[path] === nextContent
            ? current
            : {...current, [path]: nextContent});
    }, []);

    const updateSaveState = useCallback((path: string, state: WorkspaceSaveState) => {
        if (saveStates.current[path] === state) {
            return;
        }
        const next = {...saveStates.current, [path]: state};
        saveStates.current = next;
        onSaveStateChange(aggregateSaveState(
            paths.map(currentPath => next[currentPath] ?? 'saved'),
        ));
    }, [onSaveStateChange, paths]);

    const reportSaveComplete = useCallback((
        path: string,
        revision: number,
        succeeded: boolean,
    ) => {
        let batch = saveBatches.current.get(revision);
        if (!batch) {
            batch = createSaveBatch(paths);
            saveBatches.current.set(revision, batch);
        }
        const batchSucceeded = recordSaveBatchResult(batch, path, succeeded);
        if (batchSucceeded === null) {
            return;
        }
        saveBatches.current.delete(revision);
        onSaveComplete(revision, batchSucceeded);
    }, [onSaveComplete, paths]);

    const focusPath = useCallback((path: string): boolean => {
        if (path === day.todo.path) {
            setTodoVisible(true);
        } else if (!doingFiles.some(file => file.path === path)) {
            return false;
        }
        setFocusedPath(path);
        setZoomedPath(current => current ? path : current);
        setEditorFocus(current => ({path, revision: current.revision + 1}));
        return true;
    }, [day.todo.path, doingFiles]);

    const focusDoing = useCallback((streamIndex: number): boolean => {
        const path = doingFiles.find(file => file.streamIndex === streamIndex)?.path;
        return path ? focusPath(path) : false;
    }, [doingFiles, focusPath]);

    const visiblePaths = useMemo(
        () => [...(todoVisible ? [day.todo.path] : []), ...doingFiles.map(file => file.path)],
        [day.todo.path, doingFiles, todoVisible],
    );

    const moveFocus = useCallback((delta: -1 | 1): boolean => {
        const path = adjacentPanePath(visiblePaths, focusedPath, delta);
        return path ? focusPath(path) : false;
    }, [focusPath, focusedPath, visiblePaths]);

    const toggleZoom = useCallback((): boolean => {
        if (zoomedPath) {
            setZoomedPath('');
            return true;
        }
        const path = visiblePaths.includes(focusedPath) ? focusedPath : visiblePaths[0];
        if (!path) {
            return false;
        }
        setZoomedPath(path);
        if (path !== focusedPath) {
            setFocusedPath(path);
            setEditorFocus(current => ({path, revision: current.revision + 1}));
        }
        return true;
    }, [focusedPath, visiblePaths, zoomedPath]);

    const toggleTodo = useCallback((): boolean => {
        if (!todoVisible) {
            setTodoVisible(true);
            setFocusedPath(day.todo.path);
            setZoomedPath(current => current ? day.todo.path : current);
            setEditorFocus(current => ({path: day.todo.path, revision: current.revision + 1}));
            return true;
        }

        if (focusedPath !== day.todo.path) {
            return focusPath(day.todo.path);
        }

        setTodoVisible(false);
        if (zoomedPath === day.todo.path) {
            setZoomedPath('');
        }
        const path = doingFiles[0]?.path ?? '';
        setFocusedPath(path);
        if (path) {
            setEditorFocus(current => ({path, revision: current.revision + 1}));
        }
        return true;
    }, [day.todo.path, doingFiles, focusPath, focusedPath, todoVisible, zoomedPath]);

    const toggleAllDoingHistory = useCallback((): boolean => {
        if (doingFiles.length === 0) {
            return false;
        }
        setDoingHistoryVisible(current => {
            const visible = doingFiles.map(file => Boolean(current[file.path]));
            const show = nextAllDoingHistoryVisibility(visible);
            const next = {...current};
            for (const file of doingFiles) {
                next[file.path] = show;
            }
            return next;
        });
        return true;
    }, [doingFiles]);

    const toggleFocusedDoingHistory = useCallback((): boolean => {
        if (!doingFiles.some(file => file.path === focusedPath)) {
            return false;
        }
        setDoingHistoryVisible(current => ({
            ...current,
            [focusedPath]: !current[focusedPath],
        }));
        return true;
    }, [doingFiles, focusedPath]);

    const handleWorkspaceAction = useCallback((action: WorkspaceAction): boolean => {
        switch (action.type) {
            case 'focus-todo':
                return toggleTodo();
            case 'focus-doing':
                return focusDoing(action.streamIndex);
            case 'move-focus':
                return moveFocus(action.delta);
            case 'toggle-zoom':
                return toggleZoom();
            case 'toggle-all-doing-history':
                return toggleAllDoingHistory();
            case 'toggle-focused-doing-history':
                return toggleFocusedDoingHistory();
        }
    }, [
        focusDoing,
        moveFocus,
        toggleAllDoingHistory,
        toggleFocusedDoingHistory,
        toggleTodo,
        toggleZoom,
    ]);

    useEffect(() => {
        const shortcut = (event: KeyboardEvent) => {
            // The native application menu owns these accelerators in Wails;
            // this listener keeps the browser preview and tests functional.
            if (interactionDisabled || appAPI.isNative()) {
                return;
            }
            const action = workspaceActionForShortcut(event);
            if (!action) {
                return;
            }
            if (handleWorkspaceAction(action)) {
                event.preventDefault();
                event.stopPropagation();
            }
        };
        window.addEventListener('keydown', shortcut, true);
        return () => window.removeEventListener('keydown', shortcut, true);
    }, [handleWorkspaceAction, interactionDisabled]);

    useEffect(() => {
        if (handledWorkspaceAction.current === workspaceActionRequest.revision) {
            return;
        }
        handledWorkspaceAction.current = workspaceActionRequest.revision;
        handleWorkspaceAction(workspaceActionRequest.action);
    }, [handleWorkspaceAction, workspaceActionRequest]);

    useEffect(() => {
        const count = newDoingRequest - handledNewDoingRequest.current;
        if (count <= 0) {
            return;
        }
        handledNewDoingRequest.current = newDoingRequest;
        createChain.current = createChain.current.then(async () => {
            for (let pending = 0; pending < count; pending += 1) {
                try {
                    const requestedDate = day.date;
                    const file = await appAPI.createDoingStream(requestedDate);
                    if (!mounted.current || currentDate.current !== requestedDate) {
                        return;
                    }
                    setDoingFiles(current => current.some(item => item.path === file.path)
                        ? current
                        : [...current, file].sort((left, right) => left.streamIndex - right.streamIndex));
                    setDiskContents(current => ({...current, [file.path]: file.content}));
                    setFocusedPath(file.path);
                    setZoomedPath(current => current ? file.path : current);
                    setEditorFocus(current => ({path: file.path, revision: current.revision + 1}));
                } catch (reason) {
                    onError(errorMessage(reason));
                }
            }
        });
    }, [day.date, newDoingRequest, onError]);

    return (
        <main className="workspace-shell">
            <div className="window-drag-region" aria-hidden="true"/>
            <section className={`pane-strip${zoomedPath ? ' is-zoomed' : ''}`}>
                <TodoPane
                    file={day.todo}
                    saveRequest={saveRequest}
                    discardRequest={discardRequest}
                    diskContent={diskContents[day.todo.path] ?? day.todo.content}
                    onDiskContent={updateDiskContent}
                    onSaveState={updateSaveState}
                    onSaveComplete={reportSaveComplete}
                    focusRequest={editorFocus.path === day.todo.path ? editorFocus.revision : 0}
                    hidden={!todoVisible || Boolean(zoomedPath && zoomedPath !== day.todo.path)}
                    onFocus={() => setFocusedPath(day.todo.path)}
                />
                {doingFiles.length > 0 ? doingFiles.map(file => (
                    <DoingPane
                        file={file}
                        key={file.path}
                        saveRequest={saveRequest}
                        discardRequest={discardRequest}
                        diskContent={diskContents[file.path] ?? file.content}
                        onDiskContent={updateDiskContent}
                        onSaveState={updateSaveState}
                        onSaveComplete={reportSaveComplete}
                        showCompleted={Boolean(doingHistoryVisible[file.path])}
                        onFocus={() => setFocusedPath(file.path)}
                        focusRequest={editorFocus.path === file.path ? editorFocus.revision : 0}
                        hidden={Boolean(zoomedPath && zoomedPath !== file.path)}
                    />
                )) : (
                    <div className="missing-stream" hidden={Boolean(zoomedPath)}>
                        <h2>No Doing streams</h2>
                        <p>This day has no Doing file yet.</p>
                    </div>
                )}
            </section>
        </main>
    );
}

type DiskAwarePaneProps = {
    file: JournalFile;
    saveRequest: number;
    discardRequest: number;
    diskContent: string;
    onDiskContent: (path: string, content: string) => void;
    onSaveState: (path: string, state: WorkspaceSaveState) => void;
    onSaveComplete: (path: string, revision: number, succeeded: boolean) => void;
    focusRequest: number;
    hidden: boolean;
    onFocus: () => void;
};

function TodoPane({
    file,
    saveRequest,
    discardRequest,
    diskContent,
    onDiskContent,
    onSaveState,
    onSaveComplete,
    focusRequest,
    hidden,
    onFocus,
}: DiskAwarePaneProps) {
    const journal = useJournalFile(
        file,
        saveRequest,
        discardRequest,
        diskContent,
        onDiskContent,
        onSaveState,
        onSaveComplete,
    );

    return (
        <article className="journal-pane todo-pane" hidden={hidden}>
            <FileBar
                filename={file.name}
                saveState={journal.saveState}
                onUseDisk={journal.useDiskVersion}
                onOverwrite={journal.overwriteDisk}
            />
            <LineEditor
                kind="todo"
                lines={journal.lines}
                onChange={journal.update}
                onFocus={onFocus}
                focusRequest={focusRequest}
            />
        </article>
    );
}

type DoingPaneProps = DiskAwarePaneProps & {
    showCompleted: boolean;
    onFocus: () => void;
};

function DoingPane({
    file,
    saveRequest,
    discardRequest,
    diskContent,
    onDiskContent,
    onSaveState,
    onSaveComplete,
    showCompleted,
    onFocus,
    focusRequest,
    hidden,
}: DoingPaneProps) {
    const journal = useJournalFile(
        file,
        saveRequest,
        discardRequest,
        diskContent,
        onDiskContent,
        onSaveState,
        onSaveComplete,
    );

    return (
        <article className="journal-pane doing-pane" hidden={hidden}>
            <FileBar
                filename={file.name}
                saveState={journal.saveState}
                onUseDisk={journal.useDiskVersion}
                onOverwrite={journal.overwriteDisk}
            />
            <LineEditor
                kind="doing"
                lines={journal.lines}
                showCompleted={showCompleted}
                onChange={journal.update}
                onFocus={onFocus}
                focusRequest={focusRequest}
            />
        </article>
    );
}

type FileBarProps = {
    filename: string;
    saveState: SaveState;
    onUseDisk: () => void;
    onOverwrite: () => void;
};

function FileBar({filename, saveState, onUseDisk, onOverwrite}: FileBarProps) {
    const label = saveStateLabel(saveState);
    return (
        <div className="file-header">
            <header className="file-bar">
                <span className="filename">{filename}</span>
                <span
                    className={`save-state ${saveState}`}
                    title={label}
                    aria-label={label}
                />
            </header>
            {saveState === 'conflict' && (
                <div className="file-conflict" role="alert">
                    <span>Changed outside the app</span>
                    <span className="conflict-actions">
                        <button type="button" onClick={onUseDisk}>Use disk</button>
                        <button type="button" onClick={onOverwrite}>Overwrite</button>
                    </span>
                </div>
            )}
        </div>
    );
}

type SaveState = WorkspaceSaveState;

function useJournalFile(
    file: JournalFile,
    saveRequest: number,
    discardRequest: number,
    diskContent: string,
    onDiskContent: (path: string, content: string) => void,
    onSaveState: (path: string, state: WorkspaceSaveState) => void,
    onSaveComplete: (path: string, revision: number, succeeded: boolean) => void,
) {
    const [lines, setLines] = useState(() => contentToLines(file.content));
    const [saveState, setSaveState] = useState<SaveState>('saved');
    const content = useRef(file.content);
    const baseline = useRef(file.content);
    const observedDisk = useRef(file.content);
    const external = useRef<string | null>(null);
    const dirty = useRef(false);
    const handledSaveRequest = useRef(saveRequest);
    const handledDiscardRequest = useRef(discardRequest);
    const saveChain = useRef<Promise<void>>(Promise.resolve());
    const onSaveStateRef = useRef(onSaveState);
    const onSaveCompleteRef = useRef(onSaveComplete);

    onSaveStateRef.current = onSaveState;
    onSaveCompleteRef.current = onSaveComplete;

    const updateSaveState = (state: SaveState) => {
        setSaveState(state);
        onSaveStateRef.current(file.path, state);
    };

    useEffect(() => {
        setLines(contentToLines(file.content));
        content.current = file.content;
        baseline.current = file.content;
        observedDisk.current = file.content;
        external.current = null;
        dirty.current = false;
        handledSaveRequest.current = saveRequest;
        handledDiscardRequest.current = discardRequest;
        saveChain.current = Promise.resolve();
        updateSaveState('saved');
    }, [file.path, file.content]);

    useEffect(() => {
        if (diskContent === observedDisk.current) {
            return;
        }
        observedDisk.current = diskContent;

        if (diskContent === baseline.current) {
            external.current = null;
            updateSaveState(dirty.current ? 'dirty' : 'saved');
            return;
        }

        if (!dirty.current) {
            content.current = diskContent;
            baseline.current = diskContent;
            external.current = null;
            setLines(contentToLines(diskContent));
            updateSaveState('saved');
            return;
        }

        if (diskContent === content.current) {
            baseline.current = diskContent;
            external.current = null;
            dirty.current = false;
            updateSaveState('saved');
            return;
        }

        external.current = diskContent;
        updateSaveState('conflict');
    }, [diskContent]);

    const queueSave = (force: boolean): Promise<SaveState> => {
        const operation = saveChain.current.then(async (): Promise<SaveState> => {
            if (!dirty.current && !force) {
                updateSaveState('saved');
                return 'saved';
            }

            const saving = content.current;
            const expected = baseline.current;
            updateSaveState('saving');
            try {
                const result = await appAPI.saveFile(file.path, saving, expected, force);
                if (result.conflict) {
                    observedDisk.current = result.content;
                    onDiskContent(file.path, result.content);
                    if (result.content === content.current) {
                        baseline.current = result.content;
                        external.current = null;
                        dirty.current = false;
                        updateSaveState('saved');
                        return 'saved';
                    }
                    external.current = result.content;
                    updateSaveState('conflict');
                    return 'conflict';
                }

                baseline.current = saving;
                if (!force && external.current !== null && external.current !== saving) {
                    updateSaveState('conflict');
                    return 'conflict';
                }
                external.current = null;
                observedDisk.current = saving;
                onDiskContent(file.path, saving);
                if (content.current === saving) {
                    dirty.current = false;
                    updateSaveState('saved');
                    return 'saved';
                }
                dirty.current = true;
                updateSaveState('dirty');
                return 'dirty';
            } catch {
                const state = external.current === null ? 'error' : 'conflict';
                updateSaveState(state);
                return state;
            }
        });
        saveChain.current = operation.then(() => undefined);
        return operation;
    };

    useEffect(() => {
        if (handledSaveRequest.current === saveRequest) {
            return;
        }
        handledSaveRequest.current = saveRequest;
        void queueSave(false).then(state => {
            onSaveCompleteRef.current(file.path, saveRequest, state === 'saved');
        });
    }, [file.path, saveRequest]);

    useEffect(() => {
        if (handledDiscardRequest.current === discardRequest) {
            return;
        }
        handledDiscardRequest.current = discardRequest;
        const nextContent = observedDisk.current;
        content.current = nextContent;
        baseline.current = nextContent;
        external.current = null;
        dirty.current = false;
        setLines(contentToLines(nextContent));
        updateSaveState('saved');
    }, [discardRequest, file.path]);

    const update = (nextLines: string[]) => {
        setLines(nextLines);
        content.current = linesToContent(nextLines);
        dirty.current = true;
        updateSaveState(external.current === null ? 'dirty' : 'conflict');
    };

    const useDiskVersion = () => {
        if (external.current === null) {
            return;
        }
        const nextContent = external.current;
        content.current = nextContent;
        baseline.current = nextContent;
        observedDisk.current = nextContent;
        external.current = null;
        dirty.current = false;
        setLines(contentToLines(nextContent));
        updateSaveState('saved');
    };

    return {
        lines,
        update,
        saveState,
        useDiskVersion,
        overwriteDisk: () => void queueSave(true),
    };
}

function contentsByPath(files: JournalFile[]): Record<string, string> {
    return Object.fromEntries(files.map(file => [file.path, file.content]));
}

function mergeSnapshots(
    current: Record<string, string>,
    snapshots: JournalFile[],
): Record<string, string> {
    let changed = false;
    const next = {...current};
    for (const file of snapshots) {
        if (next[file.path] !== file.content) {
            next[file.path] = file.content;
            changed = true;
        }
    }
    return changed ? next : current;
}

function saveStateLabel(state: SaveState): string {
    switch (state) {
    case 'saved':
        return 'Saved';
    case 'dirty':
        return 'Unsaved changes';
    case 'saving':
        return 'Saving';
    case 'conflict':
        return 'Changed outside the app';
    default:
        return 'Save failed';
    }
}

function errorMessage(reason: unknown): string {
    if (reason instanceof Error) {
        return reason.message;
    }
    return typeof reason === 'string'
        ? reason
        : 'Could not create another Doing stream.';
}
