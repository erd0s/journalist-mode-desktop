const clockFaces = [
    ['🕛', '🕧'],
    ['🕐', '🕜'],
    ['🕑', '🕝'],
    ['🕒', '🕞'],
    ['🕓', '🕟'],
    ['🕔', '🕠'],
    ['🕕', '🕡'],
    ['🕖', '🕢'],
    ['🕗', '🕣'],
    ['🕘', '🕤'],
    ['🕙', '🕥'],
    ['🕚', '🕦'],
] as const;

const timestampPattern = /^\(\d{4}-\d{2}-\d{2} (\d{2}):(\d{2})\)$/;

export function clockEmojiForTimestamp(timestamp: string): string | null {
    const match = timestampPattern.exec(timestamp);
    if (!match) {
        return null;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) {
        return null;
    }

    const halfHour = Math.floor((hours * 60 + minutes + 15) / 30) % 48;
    const hour = Math.floor(halfHour / 2) % 12;
    return clockFaces[hour][halfHour % 2];
}
