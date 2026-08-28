export type JournalMutation = {
    lines: string[];
    focusIndex: number;
};

const doingTimestampPattern = /^\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)/;
const todoDatePattern = /^\[\d{4}-\d{2}-\d{2}\]\s*/;

export function contentToLines(content: string): string[] {
    return content === '' ? [''] : content.replace(/\r\n?/g, '\n').split('\n');
}

export function linesToContent(lines: string[]): string {
    if (lines.length === 1 && lines[0] === '') {
        return '';
    }
    return lines.join('\n');
}

export function doingTimestamp(now = new Date()): string {
    return `(${formatDate(now)} ${pad(now.getHours())}:${pad(now.getMinutes())})`;
}

export function todoDateStamp(now = new Date()): string {
    return `[${formatDate(now)}]`;
}

export function isCompleted(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.length > 4 && trimmed.startsWith('~~') && trimmed.endsWith('~~');
}

export function findLastIncomplete(lines: string[]): number {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (lines[index].trim() && !isCompleted(lines[index])) {
            return index;
        }
    }
    return -1;
}

export function ensureDoingTimestamp(text: string, now = new Date()): string {
    const trimmed = text.trim();
    if (!trimmed || doingTimestampPattern.test(trimmed)) {
        return text;
    }

    const indentation = text.match(/^\t*/)?.[0] ?? '';
    return `${indentation}${doingTimestamp(now)} ${text.slice(indentation.length)}`;
}

export function ensureDoingTimestampSpacing(text: string): string {
    return text.replace(/^(\t*\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\))(?=\S)/, '$1 ');
}

export function appendDoingChild(lines: string[], now = new Date()): JournalMutation {
    const lastIncomplete = findLastIncomplete(lines);
    const baseLines = lines.length === 1 && lines[0] === '' ? [] : [...lines];
    const indentation = lastIncomplete >= 0
        ? `${lines[lastIncomplete].match(/^\t*/)?.[0] ?? ''}\t`
        : '';

    baseLines.push(`${indentation}${doingTimestamp(now)} `);
    return {lines: baseLines, focusIndex: baseLines.length - 1};
}

export function finishDeepestDoing(
    lines: string[],
    cancelled: boolean,
    now = new Date(),
): JournalMutation {
    const targetIndex = findLastIncomplete(lines);
    if (targetIndex < 0) {
        return {lines, focusIndex: -1};
    }

    const next = [...lines];
    const line = next[targetIndex];
    const indentation = line.match(/^\t*/)?.[0] ?? '';
    let text = line.slice(indentation.length);

    text = text.replace(/~~/g, '\u0001STRIKETHROUGH\u0001');
    text = text.replace(/~/g, '');
    text = text.replace(/\u0001STRIKETHROUGH\u0001/g, '~~');
    if (text.startsWith('~~') && text.endsWith('~~')) {
        text = text.slice(2, -2);
    }

    const state = cancelled ? ' [cancelled]' : '';
    next[targetIndex] = `${indentation}~~${text}${state} ${doingTimestamp(now)}~~`;

    let focusIndex = -1;
    for (let index = targetIndex - 1; index >= 0; index -= 1) {
        if (next[index].trim() && !isCompleted(next[index])) {
            focusIndex = index;
            break;
        }
    }

    return {lines: next, focusIndex};
}

export function ensureTodoDate(text: string, now = new Date()): string {
    const trimmed = text.trim();
    if (
        !trimmed ||
        trimmed.startsWith('[') ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('~~') ||
        trimmed.startsWith('---')
    ) {
        return text;
    }

    const whitespace = text.match(/^\s*/)?.[0] ?? '';
    return `${whitespace}${todoDateStamp(now)} ${text.slice(whitespace.length)}`;
}

export function insertTodoLine(lines: string[], afterIndex: number): JournalMutation {
    const next = [...lines];
    next.splice(afterIndex + 1, 0, '');
    return {lines: next, focusIndex: afterIndex + 1};
}

export function finishTodo(
    lines: string[],
    targetIndex: number,
    cancelled: boolean,
    now = new Date(),
): JournalMutation {
    const line = lines[targetIndex] ?? '';
    if (!line.trim() || isCompleted(line) || line.trim().startsWith('#') || line.trim() === '---') {
        return {lines, focusIndex: targetIndex};
    }

    const categoryIndex = findTodoCategory(lines, targetIndex);
    const state = cancelled ? ' [cancelled]' : '';
    const completed = `~~${line}${state} ${todoDateStamp(now)}~~`;
    const next = [...lines];
    next.splice(targetIndex, 1);

    removeEmptyCategory(next, categoryIndex, targetIndex);

    let dividerIndex = next.findIndex(candidate => candidate.trim() === '---');
    if (dividerIndex < 0) {
        while (next.length > 0 && !next[next.length - 1].trim()) {
            next.pop();
        }
        if (next.length > 0) {
            next.push('');
        }
        next.push('---', '', completed);
    } else {
        while (next.length > dividerIndex + 1 && !next[next.length - 1].trim()) {
            next.pop();
        }
        if (next.length === dividerIndex + 1) {
            next.push('');
        }
        next.push(completed);
    }

    dividerIndex = next.findIndex(candidate => candidate.trim() === '---');
    const focusIndex = Math.max(0, Math.min(targetIndex, Math.max(0, dividerIndex - 1)));
    return {lines: next, focusIndex};
}

export function copyTodoText(line: string): string {
    let text = line.trim();
    if (isCompleted(text)) {
        text = text.slice(2, -2).trim();
    }
    text = text.replace(todoDatePattern, '');
    text = text.replace(/\s*\[\d{4}-\d{2}-\d{2}\]$/, '');
    return text.trim();
}

export function displayLineText(line: string): string {
    const indentation = line.match(/^\t*/)?.[0] ?? '';
    let text = line.slice(indentation.length);
    if (isCompleted(text)) {
        text = text.slice(2, -2);
    }
    return text;
}

export function lineIndentation(line: string): number {
    return line.match(/^\t*/)?.[0].length ?? 0;
}

function findTodoCategory(lines: string[], targetIndex: number): number {
    for (let index = targetIndex - 1; index >= 0; index -= 1) {
        const text = lines[index].trim();
        if (text === '---') {
            return -1;
        }
        if (text.startsWith('#')) {
            return index;
        }
    }
    return -1;
}

function removeEmptyCategory(lines: string[], categoryIndex: number, originalTargetIndex: number): void {
    if (categoryIndex < 0) {
        return;
    }

    const adjustedCategoryIndex = categoryIndex > originalTargetIndex ? categoryIndex - 1 : categoryIndex;
    let hasTasks = false;
    for (let index = adjustedCategoryIndex + 1; index < lines.length; index += 1) {
        const text = lines[index].trim();
        if (text.startsWith('#') || text === '---') {
            break;
        }
        if (text && !isCompleted(text)) {
            hasTasks = true;
            break;
        }
    }

    if (!hasTasks) {
        lines.splice(adjustedCategoryIndex, 1);
        while (adjustedCategoryIndex < lines.length && !lines[adjustedCategoryIndex].trim()) {
            lines.splice(adjustedCategoryIndex, 1);
        }
        if (adjustedCategoryIndex > 0 && adjustedCategoryIndex < lines.length) {
            lines.splice(adjustedCategoryIndex, 0, '');
        }
    }
}

function formatDate(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}
