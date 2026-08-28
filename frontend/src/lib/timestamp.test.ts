import {describe, expect, it} from 'vitest';
import {clockEmojiForTimestamp} from './timestamp';

describe('clockEmojiForTimestamp', () => {
    it('rounds timestamps to the nearest clock-face half hour', () => {
        expect(clockEmojiForTimestamp('(2026-08-28 00:00)')).toBe('🕛');
        expect(clockEmojiForTimestamp('(2026-08-28 01:29)')).toBe('🕜');
        expect(clockEmojiForTimestamp('(2026-08-28 14:31)')).toBe('🕝');
        expect(clockEmojiForTimestamp('(2026-08-28 21:47)')).toBe('🕙');
        expect(clockEmojiForTimestamp('(2026-08-28 23:50)')).toBe('🕛');
    });

    it('keeps incomplete or invalid timestamps as raw text', () => {
        expect(clockEmojiForTimestamp('(2026-08-28 22:05')).toBeNull();
        expect(clockEmojiForTimestamp('(2026-08-28 24:00)')).toBeNull();
        expect(clockEmojiForTimestamp('(2026-08-28 22:60)')).toBeNull();
    });

    it('recognises a timestamp again when its closing parenthesis is restored', () => {
        const broken = '(2026-08-28 22:05';
        expect(clockEmojiForTimestamp(broken)).toBeNull();
        expect(clockEmojiForTimestamp(`${broken})`)).toBe('🕙');
    });
});
