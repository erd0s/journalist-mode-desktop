import {defaultKeymap, history, historyKeymap, indentWithTab} from '@codemirror/commands';
import {Annotation, Compartment, EditorState, Prec, Transaction} from '@codemirror/state';
import {
    Decoration,
    DecorationSet,
    EditorView,
    keymap,
    ViewPlugin,
    ViewUpdate,
    WidgetType,
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
import {clockEmojiForTimestamp} from '../lib/timestamp';

type LineEditorProps = {
    kind: 'doing' | 'todo';
    lines: string[];
    showCompleted?: boolean;
    onChange: (lines: string[]) => void;
    onFocus?: () => void;
    focusRequest?: number;
};

const externalDocumentUpdate = Annotation.define<boolean>();

export function LineEditor({
    kind,
    lines,
    showCompleted = true,
    onChange,
    onFocus,
    focusRequest = 0,
}: LineEditorProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView>();
    const onChangeRef = useRef(onChange);
    const onFocusRef = useRef(onFocus);
    const completedVisibility = useRef(new Compartment());

    onChangeRef.current = onChange;
    onFocusRef.current = onFocus;

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
                    Prec.high(keymap.of(journalKeymap(kind))),
                    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
                    completedVisibility.current.of(
                        journalLineView(kind, kind === 'doing' ? showCompleted : true),
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
                journalLineView(kind, kind === 'doing' ? showCompleted : true),
            ),
        });
    }, [kind, showCompleted]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view || focusRequest <= 0) {
            return;
        }
        const frame = window.requestAnimationFrame(() => view.focus());
        return () => window.cancelAnimationFrame(frame);
    }, [focusRequest]);

    return <div className={`file-editor ${kind}-editor`} ref={hostRef}/>;
}

function journalKeymap(kind: 'doing' | 'todo') {
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

function journalLineView(kind: 'doing' | 'todo', showCompleted: boolean) {
    return ViewPlugin.fromClass(class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = journalDecorations(view, kind, showCompleted);
        }

        update(update: ViewUpdate) {
            if (update.docChanged || update.viewportChanged) {
                this.decorations = journalDecorations(update.view, kind, showCompleted);
            }
        }
    }, {
        decorations: value => value.decorations,
    });
}

class JournalClockWidget extends WidgetType {
    constructor(
        private readonly timestamp: string,
        private readonly positionAfter: number,
    ) {
        super();
    }

    eq(other: JournalClockWidget): boolean {
        return this.timestamp === other.timestamp && this.positionAfter === other.positionAfter;
    }

    toDOM(view: EditorView): HTMLElement {
        const clock = document.createElement('span');
        clock.className = 'cm-journal-clock';
        clock.textContent = clockEmojiForTimestamp(this.timestamp) ?? this.timestamp;
        clock.title = this.timestamp.slice(1, -1);
        clock.setAttribute('role', 'img');
        clock.setAttribute('aria-label', `Timestamp ${this.timestamp.slice(1, -1)}`);
        clock.addEventListener('mousedown', event => {
            if (event.button !== 0) {
                return;
            }
            event.preventDefault();
            view.dispatch({
                selection: {anchor: this.positionAfter},
                scrollIntoView: true,
            });
            view.focus();
        });
        return clock;
    }
}

export function journalDecorations(
    view: EditorView,
    kind: 'doing' | 'todo',
    showCompleted: boolean,
): DecorationSet {
    const ranges = [];
    for (let number = 1; number <= view.state.doc.lines; number += 1) {
        const line = view.state.doc.line(number);
        const metadataPattern = /\[\d{4}-\d{2}-\d{2}\]|\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)/g;
        for (const match of line.text.matchAll(metadataPattern)) {
            const from = line.from + (match.index ?? 0);
            const clock = clockEmojiForTimestamp(match[0]);
            if (!clock) {
                ranges.push(
                    Decoration.mark({class: 'cm-journal-date'}).range(
                        from,
                        from + match[0].length,
                    ),
                );
                continue;
            }
            const to = from + match[0].length;
            ranges.push(
                Decoration.replace({
                    widget: new JournalClockWidget(match[0], to),
                }).range(from, to),
            );
        }

        if (kind === 'todo') {
            const category = /^(\s*)#\s*(.*)$/.exec(line.text);
            if (category) {
                const markerFrom = line.from + category[1].length;
                const titleFrom = line.to - category[2].length;
                ranges.push(Decoration.replace({}).range(markerFrom, titleFrom));
                if (titleFrom < line.to) {
                    ranges.push(
                        Decoration.mark({class: 'cm-todo-category'}).range(titleFrom, line.to),
                    );
                }
            }
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
