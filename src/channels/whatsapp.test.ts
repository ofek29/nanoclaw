/**
 * Tests for the carried reply-engage patch: a reply quoting the bot engages
 * it without an @-mention. Local customization — see the workspace plan
 * 2026-09-11-nanoclaw-rebuild-v2.3.md Phase 5.
 */
import { describe, it, expect } from 'vitest';

import { isReplyToBot } from './whatsapp.js';

describe('isReplyToBot', () => {
  const BOT_PHONE = '15550001111@s.whatsapp.net';
  const BOT_LID = '123456789';

  it('engages on a text reply quoting the bot', () => {
    expect(isReplyToBot({ extendedTextMessage: { contextInfo: { participant: BOT_PHONE } } }, BOT_PHONE, BOT_LID)).toBe(
      true,
    );
  });

  it('engages on a voice-note reply quoting the bot', () => {
    expect(isReplyToBot({ audioMessage: { contextInfo: { participant: BOT_PHONE } } }, BOT_PHONE, BOT_LID)).toBe(true);
  });

  it('matches the bot LID identity', () => {
    expect(
      isReplyToBot({ extendedTextMessage: { contextInfo: { participant: `${BOT_LID}@lid` } } }, BOT_PHONE, BOT_LID),
    ).toBe(true);
  });

  it('tolerates a device suffix on the quoted participant', () => {
    expect(
      isReplyToBot(
        { extendedTextMessage: { contextInfo: { participant: '15550001111:12@s.whatsapp.net' } } },
        BOT_PHONE,
        BOT_LID,
      ),
    ).toBe(true);
  });

  it('ignores a reply quoting someone else', () => {
    expect(
      isReplyToBot(
        { extendedTextMessage: { contextInfo: { participant: '15559998888@s.whatsapp.net' } } },
        BOT_PHONE,
        BOT_LID,
      ),
    ).toBe(false);
  });

  it('ignores a message that quotes nothing', () => {
    expect(isReplyToBot({ extendedTextMessage: { contextInfo: {} } }, BOT_PHONE, BOT_LID)).toBe(false);
  });
});
