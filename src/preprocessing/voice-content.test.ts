/**
 * Tests for the carried voice-transcription patch. Local addition — see the
 * workspace plan 2026-09-11-nanoclaw-rebuild-v2.3.md Phase 8.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transcribeAudio = vi.hoisted(() => vi.fn());
vi.mock('./whisper.js', async (orig) => ({
  ...(await orig<typeof import('./whisper.js')>()),
  transcribeAudio,
}));

let tmp: string;
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>();
  return {
    ...actual,
    get DATA_DIR() {
      return path.join(tmp, 'data');
    },
    get GROUPS_DIR() {
      return path.join(tmp, 'groups');
    },
  };
});

const { DEFAULT_VOICE_LANGUAGE, resolveVoiceLanguage, transcribeAndStripAudio } = await import('./voice-content.js');

const ctx = { platformId: 'wa:test', agentGroupId: 'ag-test' };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups', 'family'), { recursive: true });
  transcribeAudio.mockReset();
  transcribeAudio.mockResolvedValue({
    transcript: 'שלום',
    metadata: { language: 'he', latencyMs: 5, model: 'test', duration: 3 },
  });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('resolveVoiceLanguage', () => {
  it('reads the per-agent language file', () => {
    fs.writeFileSync(path.join(tmp, 'groups', 'family', 'voice-language'), 'en\n');
    expect(resolveVoiceLanguage('family')).toBe('en');
  });

  it('falls back when the file is absent', () => {
    expect(resolveVoiceLanguage('family')).toBe(DEFAULT_VOICE_LANGUAGE);
  });

  it('rejects junk contents', () => {
    fs.writeFileSync(path.join(tmp, 'groups', 'family', 'voice-language'), 'not-a-language-code');
    expect(resolveVoiceLanguage('family')).toBe(DEFAULT_VOICE_LANGUAGE);
  });

  it('refuses a traversing folder name', () => {
    expect(resolveVoiceLanguage('../../etc')).toBe(DEFAULT_VOICE_LANGUAGE);
  });
});

describe('transcribeAndStripAudio', () => {
  it('passes non-audio content through untouched', async () => {
    const raw = JSON.stringify({ text: 'hello' });
    expect(await transcribeAndStripAudio(raw, 'he', ctx)).toBe(raw);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('returns unparseable content untouched', async () => {
    expect(await transcribeAndStripAudio('not json', 'he', ctx)).toBe('not json');
  });

  it('transcribes inline base64 audio and strips the bytes', async () => {
    const raw = JSON.stringify({
      text: '',
      attachments: [{ type: 'audio', mimeType: 'audio/ogg', data: Buffer.from('fake').toString('base64') }],
    });
    const out = JSON.parse(await transcribeAndStripAudio(raw, 'he', ctx));
    expect(out.text).toBe('[voice 0:03] שלום');
    expect(out.attachments).toBeUndefined();
  });

  it('transcribes on-disk audio and deletes the file', async () => {
    const rel = 'attachments/voice.ogg';
    const abs = path.join(tmp, 'data', rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'fake-audio');

    const raw = JSON.stringify({ text: '', attachments: [{ type: 'audio', localPath: rel }] });
    const out = JSON.parse(await transcribeAndStripAudio(raw, 'he', ctx));

    expect(out.text).toBe('[voice 0:03] שלום');
    expect(out.attachments).toBeUndefined();
    expect(fs.existsSync(abs)).toBe(false);
  });

  it('refuses an audio path escaping the data dir', async () => {
    const raw = JSON.stringify({ text: '', attachments: [{ type: 'audio', localPath: '../../etc/passwd' }] });
    expect(await transcribeAndStripAudio(raw, 'he', ctx)).toBe(raw);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('keeps a caption alongside the transcript', async () => {
    const raw = JSON.stringify({
      text: 'look',
      attachments: [{ type: 'audio', data: Buffer.from('x').toString('base64') }],
    });
    const out = JSON.parse(await transcribeAndStripAudio(raw, 'he', ctx));
    expect(out.text).toBe('[voice 0:03] שלום\n[caption] look');
  });

  it('preserves non-audio attachments', async () => {
    const raw = JSON.stringify({
      text: '',
      attachments: [
        { type: 'audio', data: Buffer.from('x').toString('base64') },
        { type: 'image', data: 'aW1n' },
      ],
    });
    const out = JSON.parse(await transcribeAndStripAudio(raw, 'he', ctx));
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0].type).toBe('image');
  });

  it('forces the language it was given', async () => {
    const raw = JSON.stringify({ text: '', attachments: [{ type: 'audio', data: 'eA==' }] });
    await transcribeAndStripAudio(raw, 'en', ctx);
    expect(transcribeAudio).toHaveBeenCalledWith(expect.any(Buffer), 'audio/ogg', 'en');
  });
});
