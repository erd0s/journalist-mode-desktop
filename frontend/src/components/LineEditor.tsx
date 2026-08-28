import {defaultKeymap, history, historyKeymap, indentWithTab} from '@codemirror/commands';
import {Annotation, Compartment, EditorState, Prec, Transaction} from '@codemirror/state';
import {
    Decoration,
    DecorationSet,
    EditorView,
    keymap,
    ViewPlugin,
    ViewUpdate,
} from '@codemirror/view';
import {useEffect, useRef} from 'react';
import {
    appendDoingChild,
    contentToLines,
    copyTodoText,
    ensureDoingTimestamp,
    ensureTodoDate,
    finishDeepestDoing,
    finishTodo,
    insertTodoLine,
    isCompleted,
    linesToContent,
} from '../lib/journal';

type LineEditorProps = {
    kind: 'doing' | 'todo';
    lines: string[];
    showCompleted?: boolean;
    onChange: (lines: string[]) => void;
    onFocus?: () => void;
    onToggleCompleted?: () => void;
};

const externalDocumentUpdate = Annotation.define<boolean>();

export function LineEditor({
    kind,
    lines,
    showCompleted = true,
    onChange,
    onFocus,
    onToggleCompleted,
}: LineEditorProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView>();
    const onChangeRef = useRef(onChange);
    const onFocusRef = useRef(onFocus);
    const onToggleCompletedRef = useRef(onToggleCompleted);
    const completedVisibility = useRef(new Compartment());

    onChangeRef.current = onChange;
    onFocusRef.current = onFocus;
    onToggleCompletedRef.current = onToggleCompleted;

    useEffect(() => {
        if (!hostRef.current) {
            return;
        }

        const view = new EditorView({
            parent: hostRef.current,
            state: EditorState.create({
                doc: linesToContent(lines),
                extensions: [
                    history(),
                    EditorView.lineWrapping,
                    EditorView.contentAttributes.of({
                        'aria-label': `${kind === 'doing' ? 'Doing' : 'Todo'} file editor`,
                        autocapitalize: 'sentences',
                        spellcheck: 'true',
                    }),
                    EditorView.domEventHandlers({
                        focus: () => onFocusRef.current?.(),
                    }),
                    EditorView.inputHandler.of((editor, from, to, text) => {
                        if (!text || text.includes('\n') || from !== to) {
                            return false;
                        }

                        const line = editor.state.doc.lineAt(from);
                        if (line.text.trim()) {
                            return false;
                        }

                        const inserted = kind === 'doing'
                            ? ensureDoingTimestamp(text)
                            : ensureTodoDate(text);
                        if (inserted === text) {
                            return false;
                        }

                        editor.dispatch({
                            changes: {from, to, insert: inserted},
                            selection: {anchor: from + inserted.length},
                            scrollIntoView: true,
                            userEvent: 'input.type',
                        });
                        return true;
                    }),
                    Prec.high(keymap.of(journalKeymap(kind, onToggleCompletedRef))),
                    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
                    completedVisibility.current.of(
                        completedLineView(kind === 'doing' ? showCompleted : true),
                    ),
                    EditorView.updateListener.of((update: ViewUpdate) => {
                        const cameFromDisk = update.transactions.some(
                            transaction => transaction.annotation(externalDocumentUpdate),
                        );
                        if (update.docChanged && !cameFromDisk) {
                            onChangeRef.current(contentToLines(update.state.doc.toString()));
                        }
                    }),
                ],
            }),
        });

        viewRef.current = view;
        return () => {
            view.destroy();
            viewRef.current = undefined;
        };
        // The editor owns its document after mounting; prop synchronization is
        // handled below without destroying selection or undo history.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind]);

    useEffect(() => {
        const view = viewRef.current;
        const nextContent = linesToContent(lines);
        if (!view || view.state.doc.toString() === nextContent) {
            return;
        }

        view.dispatch({
            changes: {from: 0, to: view.state.doc.length, insert: nextContent},
            annotations: [
                Transaction.addToHistory.of(false),
                externalDocumentUpdate.of(true),
            ],
        });
    }, [lines]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) {
            return;
        }

        view.dispatch({
            effects: completedVisibility.current.reconfigure(
                completedLineView(kind === 'doing' ? showCompleted : true),
            ),
        });
    }, [kind, showCompleted]);

    return <div className={`file-editor ${kind}-editor`} ref={hostRef}/>;
}

function journalKeymap(
    kind: 'doing' | 'todo',
    onToggleCompletedRef: {current?: () => void},
) {
    const mutate = (
        view: EditorView,
        action: 'enter' | 'finish' | 'cancel',
    ): boolean => {
        const lines = contentToLines(view.state.doc.toString());
        const currentLine = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
        const result = action === 'enter'
            ? (kind === 'doing' ? appendDoingChild(lines) : insertTodoLine(lines, currentLine))
            : (kind === 'doing'
                ? finishDeepestDoing(lines, action === 'cancel')
                : finishTodo(lines, currentLine, action === 'cancel'));

        replaceDocument(view, result.lines, result.focusIndex);
        return true;
    };

    return [
        {key: 'Shift-Enter', run: (view: EditorView) => mutate(view, 'finish')},
        {key: 'Shift-Escape', run: (view: EditorView) => mutate(view, 'cancel')},
        {key: 'Enter', run: (view: EditorView) => mutate(view, 'enter')},
        {
            key: 'Mod-Shift-c',
            run: (view: EditorView) => {
                if (kind !== 'todo') {
                    return false;
                }
                const line = view.state.doc.lineAt(view.state.selection.main.head).text;
                void copyText(copyTodoText(line));
                return true;
            },
        },
        {
            key: 'Mod-Shift-h',
            run: () => {
                if (kind !== 'doing' || !onToggleCompletedRef.current) {
                    return false;
                }
                onToggleCompletedRef.current();
                return true;
            },
        },
    ];
}

function replaceDocument(view: EditorView, lines: string[], focusIndex: number): void {
    const content = linesToContent(lines);
    const anchor = focusIndex < 0 ? view.state.selection.main.head : lineEndOffset(lines, focusIndex);
    view.dispatch({
        changes: {from: 0, to: view.state.doc.length, insert: content},
        selection: {anchor: Math.min(anchor, content.length)},
        scrollIntoView: true,
        userEvent: 'input',
    });
}

function lineEndOffset(lines: string[], index: number): number {
    if (index < 0) {
        return 0;
    }
    let offset = 0;
    for (let current = 0; current < index; current += 1) {
        offset += (lines[current]?.length ?? 0) + 1;
    }
    return offset + (lines[index]?.length ?? 0);
}

function completedLineView(showCompleted: boolean) {
    return ViewPlugin.fromClass(class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = completedDecorations(view, showCompleted);
        }

        update(update: ViewUpdate) {
            if (update.docChanged || update.viewportChanged) {
                this.decorations = completedDecorations(update.view, showCompleted);
            }
        }
    }, {
        decorations: value => value.decorations,
    });
}

function completedDecorations(view: EditorView, showCompleted: boolean): DecorationSet {
    const ranges = [];
    for (let number = 1; number <= view.state.doc.lines; number += 1) {
        const line = view.state.doc.line(number);
        const metadataPattern = /\[\d{4}-\d{2}-\d{2}\]|\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)/g;
        for (const match of line.text.matchAll(metadataPattern)) {
            const from = line.from + (match.index ?? 0);
            ranges.push(
                Decoration.mark({class: 'cm-journal-date'}).range(from, from + match[0].length),
            );
        }

        if (!isCompleted(line.text)) {
            continue;
        }
        if (!showCompleted) {
            ranges.push(Decoration.line({class: 'cm-completed-hidden'}).range(line.from));
            continue;
        }

        const leadingWhitespace = line.text.length - line.text.trimStart().length;
        const trimmed = line.text.trim();
        const markdownFrom = line.from + leadingWhitespace;
        const markdownTo = markdownFrom + trimmed.length;
        ranges.push(
            Decoration.line({class: 'cm-completed-line'}).range(line.from),
            Decoration.replace({}).range(markdownFrom, markdownFrom + 2),
            Decoration.mark({class: 'cm-strikethrough-text'}).range(markdownFrom + 2, markdownTo - 2),
            Decoration.replace({}).range(markdownTo - 2, markdownTo),
        );
    }
    return Decoration.set(ranges, true);
}

async function copyText(text: string) {
    if (!text) {
        return;
    }
    if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
}
