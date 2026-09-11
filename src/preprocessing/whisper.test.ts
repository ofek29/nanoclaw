/**
 * Tests for the carried voice-transcription patch: the whisper HTTP client and
 * its failure-mode contract. Local addition - see .claude/rules/carried-patches.md.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { transcribeAudio, formatVoicePrefix } from './whisper.js';

describe('formatVoicePrefix', () => {
  it('formats 14 seconds as "[voice 0:14]"', () => {
    expect(formatVoicePrefix(14)).toBe('[voice 0:14]');
  });
  it('formats 65 seconds as "[voice 1:05]"', () => {
    expect(formatVoicePrefix(65)).toBe('[voice 1:05]');
  });
  it('rounds non-integer seconds', () => {
    expect(formatVoicePrefix(14.7)).toBe('[voice 0:15]');
  });
  it('treats 0 / undefined / negative as unknown duration → "[voice]"', () => {
    expect(formatVoicePrefix(0)).toBe('[voice]');
    expect(formatVoicePrefix(undefined)).toBe('[voice]');
    expect(formatVoicePrefix(-3)).toBe('[voice]');
  });
});

describe('transcribeAudio', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.WHISPER_API_KEY = 'test-key';
    process.env.WHISPER_BASE_URL = 'http://127.0.0.1:9000';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.WHISPER_API_KEY;
    delete process.env.WHISPER_BASE_URL;
  });

  it('forces the supplied language and returns transcript + duration', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ text: 'שלום עולם', language: 'he', duration: 4.5 }), { status: 200 }),
      );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const result = await transcribeAudio(Buffer.from('x'), 'audio/ogg', 'he');

    expect(result.transcript).toBe('שלום עולם');
    expect(result.metadata.language).toBe('he');
    expect(result.metadata.duration).toBe(4.5);
    expect(result.metadata.model).toBe('Systran/faster-whisper-large-v3');
    expect(typeof result.metadata.latencyMs).toBe('number');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9000/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const form = init.body as FormData;
    expect(form.get('language')).toBe('he');
    expect(form.get('vad_filter')).toBe('true');
    expect(form.get('response_format')).toBe('verbose_json');
  });

  it('passes through whatever ISO code the caller supplies', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ text: 'hello', language: 'en', duration: 2.0 }), { status: 200 }),
      );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await transcribeAudio(Buffer.from('x'), 'audio/ogg', 'en');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.body as FormData).get('language')).toBe('en');
  });

  it('does NOT retry — one request even on weird-looking response', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ text: 'gibberish', language: 'sl', duration: 5.1 }), { status: 200 }),
      );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const result = await transcribeAudio(Buffer.from('x'), 'audio/ogg', 'he');
    expect(result.transcript).toBe('gibberish');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('returns "— transcription unavailable" on connection refused', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;
    const result = await transcribeAudio(Buffer.from('x'), 'audio/ogg', 'he');
    expect(result.transcript).toBe('— transcription unavailable');
    expect(result.metadata.duration).toBeUndefined();
  });

  it('returns "— silent" when transcript is empty', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ text: '', language: 'he', duration: 1.2 }), { status: 200 }),
      ) as unknown as typeof fetch;
    const result = await transcribeAudio(Buffer.from('x'), 'audio/ogg', 'he');
    expect(result.transcript).toBe('— silent');
    expect(result.metadata.duration).toBe(1.2);
  });

  it('returns "— silent" when transcript is whitespace', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ text: '   \n  ', language: 'he' }), { status: 200 }),
      ) as unknown as typeof fetch;
    const result = await transcribeAudio(Buffer.from('x'), 'audio/ogg', 'he');
    expect(result.transcript).toBe('— silent');
  });

  it('returns "— transcription failed" on 5xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const result = await transcribeAudio(Buffer.from('x'), 'audio/ogg', 'he');
    expect(result.transcript).toBe('— transcription failed');
  });

  it('returns "— transcription failed" on malformed JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })) as unknown as typeof fetch;
    const result = await transcribeAudio(Buffer.from('x'), 'audio/ogg', 'he');
    expect(result.transcript).toBe('— transcription failed');
  });
});
