import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {appAPI, DayData, DebugFileSnapshot, JournalFile} from '../api';
import {DebugEventDraft, DebugRecorder, keyboardDetails, targetDetails} from '../lib/debug';
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
import {Icon} from './Icons';
import {EditorInteraction, LineEditor} from './LineEditor';

const diskPollInterval = 750;

export type {WorkspaceSaveState} from '../lib/workspace';

type DayWorkspaceProps = {
    day: DayData;
    debugMode: boolean;
    saveRequest: number;
    discardRequest: number;
    newDoingRequest: number;
    workspaceActionRequest: WorkspaceActionRequest;
    interactionDisabled: boolean;
    onError: (message: string) => void;
    onSaveStateChange: (state: WorkspaceSaveState) => void;
    onSaveComplete: (revision: number, succeeded: boolean) => void;
};

type DebugFileState = {
    content: string;
    diskContent: string;
    saveState: WorkspaceSaveState;
};

type DebugInteractionReporter = (
    path: string,
    category: string,
    action: string,
    details?: Record<string, string>,
) => void;

export function DayWorkspace({
    day,
    debugMode,
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
    const [checkpointState, setCheckpointState] = useState<'idle' | 'saving' | 'saved'>('idle');
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
    const debugFileStates = useRef<Record<string, DebugFileState>>({});
    const debugContextRef = useRef<() => {window: string; files: DebugFileSnapshot[]}>(
        () => ({window: `day:${day.date}`, files: []}),
    );
    const debugErrorRef = useRef(onError);
    const checkpointTimer = useRef<number>();
    debugErrorRef.current = onError;

    const recorderRef = useRef<DebugRecorder>();
    if (!recorderRef.current) {
        recorderRef.current = new DebugRecorder({
            write: appAPI.recordDebugEvents,
            context: () => debugContextRef.current(),
            onError: reason => debugErrorRef.current(
                `Debug recording failed: ${errorMessage(reason)}`,
            ),
        });
    }
    const recorder = recorderRef.current;

    debugContextRef.current = () => ({
        window: `day:${day.date}`,
        files: files.map(file => {
            const state = debugFileStates.current[file.path];
            const isTodo = file.path === day.todo.path;
            return {
                path: file.path,
                name: file.name,
                kind: isTodo ? 'todo' : 'doing',
                streamIndex: file.streamIndex,
                content: state?.content ?? file.content,
                diskContent: diskContents[file.path] ?? state?.diskContent ?? file.content,
                saveState: state?.saveState ?? saveStates.current[file.path] ?? 'saved',
                completedVisible: isTodo || Boolean(doingHistoryVisible[file.path]),
                focused: focusedPath === file.path,
                visible: isTodo
                    ? todoVisible && (!zoomedPath || zoomedPath === file.path)
                    : !zoomedPath || zoomedPath === file.path,
            } as DebugFileSnapshot;
        }),
    });

    const recordDebug = useCallback((draft: DebugEventDraft, immediate = false) => (
        recorder.record(draft, immediate)
    ), [recorder]);

    const reportDebugFileState = useCallback((path: string, state: DebugFileState) => {
        debugFileStates.current[path] = state;
    }, []);

    const reportDebugInteraction = useCallback((
        path: string,
        category: string,
        action: string,
        details: Record<string, string> = {},
    ) => {
        void recordDebug({
            category,
            action,
            details: {path, ...details},
        });
    }, [recordDebug]);

    const markDebugCheckpoint = async () => {
        setCheckpointState('saving');
        try {
            await recordDebug({
                category: 'checkpoint',
                action: 'user_checkpoint',
                details: {focusedPath},
            }, true);
            setCheckpointState('saved');
            if (checkpointTimer.current !== undefined) {
                window.clearTimeout(checkpointTimer.current);
            }
            checkpointTimer.current = window.setTimeout(
                () => setCheckpointState('idle'),
                1800,
            );
        } catch {
            setCheckpointState('idle');
        }
    };

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            if (checkpointTimer.current !== undefined) {
                window.clearTimeout(checkpointTimer.current);
            }
            recorder.dispose();
        };
    }, [recorder]);

    useEffect(() => {
        recorder.setEnabled(debugMode);
    }, [debugMode, recorder]);

    useEffect(() => {
        currentDate.current = day.date;
        debugFileStates.current = {};
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
        const active = new Set(paths);
        for (const path of Object.keys(debugFileStates.current)) {
            if (!active.has(path)) {
                delete debugFileStates.current[path];
            }
        }
    }, [paths]);

    useEffect(() => {
        void recordDebug({
            category: 'workspace',
            action: 'state_changed',
            details: {
                focusedPath,
                todoVisible: String(todoVisible),
                zoomedPath,
                doingHistoryVisible: JSON.stringify(doingHistoryVisible),
            },
        });
    }, [doingHistoryVisible, focusedPath, recordDebug, todoVisible, zoomedPath]);

    useEffect(() => {
        void recordDebug({
            category: 'disk',
            action: 'workspace_snapshot_updated',
            details: {paths: Object.keys(diskContents).join(',')},
        });
    }, [diskContents, recordDebug]);

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
        void recordDebug({
            category: 'save',
            action: 'save_all_requested',
            details: {revision: String(saveRequest), paths: paths.join(',')},
        });
    }, [paths, recordDebug, saveRequest]);

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
            } catch (reason) {
                void recordDebug({
                    category: 'disk',
                    action: 'poll_failed',
                    details: {error: errorMessage(reason)},
                });
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
    }, [paths, recordDebug]);

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
        void recordDebug({
            category: 'save',
            action: 'save_all_completed',
            details: {revision: String(revision), succeeded: String(batchSucceeded)},
        });
        onSaveComplete(revision, batchSucceeded);
    }, [onSaveComplete, paths, recordDebug]);

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
        let handled = false;
        switch (action.type) {
            case 'focus-todo':
                handled = toggleTodo();
                break;
            case 'focus-doing':
                handled = focusDoing(action.streamIndex);
                break;
            case 'move-focus':
                handled = moveFocus(action.delta);
                break;
            case 'toggle-zoom':
                handled = toggleZoom();
                break;
            case 'toggle-all-doing-history':
                handled = toggleAllDoingHistory();
                break;
            case 'toggle-focused-doing-history':
                handled = toggleFocusedDoingHistory();
                break;
        }
        void recordDebug({
            category: 'command',
            action: action.type,
            details: {
                handled: String(handled),
                arguments: JSON.stringify(action),
            },
        });
        return handled;
    }, [
        focusDoing,
        moveFocus,
        recordDebug,
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
        void recordDebug({
            category: 'command',
            action: 'new_doing_requested',
            details: {count: String(count)},
        });
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
                    void recordDebug({
                        category: 'file',
                        action: 'doing_stream_created',
                        details: {path: file.path, streamIndex: String(file.streamIndex)},
                    });
                } catch (reason) {
                    void recordDebug({
                        category: 'file',
                        action: 'doing_stream_create_failed',
                        details: {error: errorMessage(reason)},
                    });
                    onError(errorMessage(reason));
                }
            }
        });
    }, [day.date, newDoingRequest, onError, recordDebug]);

    return (
        <main
            className="workspace-shell"
            onKeyDownCapture={event => void recordDebug({
                category: 'input',
                action: 'keydown',
                details: keyboardDetails(event.nativeEvent),
            })}
            onPointerDownCapture={event => void recordDebug({
                category: 'input',
                action: 'pointerdown',
                details: {
                    ...targetDetails(event.target),
                    button: String(event.button),
                    pointerType: event.pointerType,
                },
            })}
            onClickCapture={event => void recordDebug({
                category: 'input',
                action: 'click',
                details: targetDetails(event.target),
            })}
            onFocusCapture={event => void recordDebug({
                category: 'input',
                action: 'focus',
                details: targetDetails(event.target),
            })}
        >
            <div className="window-drag-region" aria-hidden="true"/>
            {debugMode && (
                <button
                    type="button"
                    className={`debug-checkpoint-button ${checkpointState}`}
                    aria-label="Mark debug checkpoint"
                    title="Mark the current state in the debug log"
                    onClick={() => void markDebugCheckpoint()}
                    disabled={checkpointState === 'saving'}
                >
                    <Icon name={checkpointState === 'saved' ? 'check' : 'flag'} size={15}/>
                    <span>{checkpointState === 'saved' ? 'Marked' : 'Checkpoint'}</span>
                </button>
            )}
            <section className={`pane-strip${zoomedPath ? ' is-zoomed' : ''}`}>
                <TodoPane
                    file={day.todo}
                    saveRequest={saveRequest}
                    discardRequest={discardRequest}
                    diskContent={diskContents[day.todo.path] ?? day.todo.content}
                    onDiskContent={updateDiskContent}
                    onSaveState={updateSaveState}
                    onSaveComplete={reportSaveComplete}
                    onDebugFileState={reportDebugFileState}
                    onDebugInteraction={reportDebugInteraction}
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
                        onDebugFileState={reportDebugFileState}
                        onDebugInteraction={reportDebugInteraction}
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
    onDebugFileState: (path: string, state: DebugFileState) => void;
    onDebugInteraction: DebugInteractionReporter;
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
    onDebugFileState,
    onDebugInteraction,
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
        onDebugFileState,
        onDebugInteraction,
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
    onDebugFileState,
    onDebugInteraction,
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
        onDebugFileState,
        onDebugInteraction,
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
    onDebugFileState: (path: string, state: DebugFileState) => void,
    onDebugInteraction: DebugInteractionReporter,
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
    const onDebugFileStateRef = useRef(onDebugFileState);
    const onDebugInteractionRef = useRef(onDebugInteraction);
    const saveStateRef = useRef<SaveState>('saved');

    onSaveStateRef.current = onSaveState;
    onSaveCompleteRef.current = onSaveComplete;
    onDebugFileStateRef.current = onDebugFileState;
    onDebugInteractionRef.current = onDebugInteraction;

    const publishDebugState = () => {
        onDebugFileStateRef.current(file.path, {
            content: content.current,
            diskContent: observedDisk.current,
            saveState: saveStateRef.current,
        });
    };

    const updateSaveState = (state: SaveState) => {
        saveStateRef.current = state;
        setSaveState(state);
        onSaveStateRef.current(file.path, state);
        publishDebugState();
        onDebugInteractionRef.current(file.path, 'file', 'save_state_changed', {state});
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
        publishDebugState();
        onDebugInteractionRef.current(file.path, 'disk', 'content_observed', {
            length: String(diskContent.length),
            matchesBaseline: String(diskContent === baseline.current),
            matchesEditor: String(diskContent === content.current),
        });

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
            onDebugInteractionRef.current(file.path, 'save', 'requested', {
                force: String(force),
                dirty: String(dirty.current),
            });
            if (!dirty.current && !force) {
                updateSaveState('saved');
                return 'saved';
            }

            const saving = content.current;
            const expected = baseline.current;
            updateSaveState('saving');
            try {
                const result = await appAPI.saveFile(file.path, saving, expected, force);
                onDebugInteractionRef.current(file.path, 'save', 'result', {
                    force: String(force),
                    saved: String(result.saved),
                    conflict: String(result.conflict),
                    diskLength: String(result.content.length),
                });
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
            } catch (reason) {
                onDebugInteractionRef.current(file.path, 'save', 'failed', {
                    force: String(force),
                    error: errorMessage(reason),
                });
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

    const update = (nextLines: string[], interaction: EditorInteraction) => {
        setLines(nextLines);
        content.current = linesToContent(nextLines);
        dirty.current = true;
        updateSaveState(external.current === null ? 'dirty' : 'conflict');
        publishDebugState();
        onDebugInteractionRef.current(file.path, 'editor', 'transaction', {
            ...interaction,
            contentLength: String(content.current.length),
        });
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
        publishDebugState();
        onDebugInteractionRef.current(file.path, 'conflict', 'used_disk_version', {
            contentLength: String(nextContent.length),
        });
    };

    return {
        lines,
        update,
        saveState,
        useDiskVersion,
        overwriteDisk: () => {
            onDebugInteractionRef.current(file.path, 'conflict', 'overwrite_requested');
            void queueSave(true);
        },
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
