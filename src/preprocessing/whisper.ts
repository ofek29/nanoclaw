/**
 * Thin HTTP client for the local whisper-service (a speaches / faster-whisper
 * container on 127.0.0.1:9000). Audio never leaves this machine and no
 * third-party transcription key is involved.
 *
 * Single forced-language round-trip — the caller decides the language. Language
 * auto-detect was removed deliberately: it misclassified short Hebrew clips as
 * Slovenian / Latin / French.
 *
 * Failure-mode contract: always resolve to a non-empty transcript (a
 * placeholder if needed) so the agent never sees a silently dropped voice note.
 *
 * LOCAL ADDITION — not upstream NanoClaw. Re-apply after an update.
 */
import { readEnvFile } from '../env.js';

const BASE_URL = process.env.WHISPER_BASE_URL ?? 'http://127.0.0.1:9000';
const MODEL = process.env.WHISPER_MODEL ?? 'Systran/faster-whisper-large-v3';
const TIMEOUT_MS = 60_000;

/**
 * Resolve the whisper API key. The host `.env` is read via readEnvFile() and
 * deliberately does NOT populate process.env, so secrets don't leak into
 * spawned containers. Resolved at call time so a key rotation is picked up on
 * the next voice message without restarting the host. process.env is the
 * fallback so tests can inject one.
 */
function resolveApiKey(): string {
  const fromProcess = process.env.WHISPER_API_KEY;
  if (typeof fromProcess === 'string' && fromProcess.length > 0) return fromProcess;
  try {
    return readEnvFile(['WHISPER_API_KEY']).WHISPER_API_KEY ?? '';
  } catch {
    return '';
  }
}

export interface TranscribeResult {
  transcript: string;
  metadata: {
    language: string;
    latencyMs: number;
    model: string;
    duration?: number;
  };
}

/** `[voice 1:07]` — prefixed to each transcript so the agent sees the length. */
export function formatVoicePrefix(durationSeconds: number | undefined): string {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return '[voice]';
  }
  const total = Math.round(durationSeconds);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `[voice ${m}:${s}]`;
}

/**
 * Transcribe `audio`, forcing `language` (ISO-639-1, lower-case). Always
 * resolves — unreachable / failed / empty all yield a placeholder transcript.
 */
export async function transcribeAudio(audio: Buffer, mimeType: string, language: string): Promise<TranscribeResult> {
  const apiKey = resolveApiKey();
  const start = Date.now();

  const form = new FormData();
  const blob = new Blob([new Uint8Array(audio)], { type: mimeType || 'audio/ogg' });
  form.append('file', blob, 'voice.ogg');
  form.append('model', MODEL);
  // verbose_json carries `duration`, which feeds the [voice M:SS] prefix
  // without the adapter having to surface it separately.
  form.append('response_format', 'verbose_json');
  // VAD trims dead air before decoding — cheap, and yields cleaner segments.
  form.append('vad_filter', 'true');
  form.append('language', language);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    return placeholder('— transcription unavailable', start, language);
  }
  clearTimeout(timer);

  if (!response.ok) return placeholder('— transcription failed', start, language);

  let body: { text?: string; language?: string; duration?: number };
  try {
    body = (await response.json()) as { text?: string; language?: string; duration?: number };
  } catch {
    return placeholder('— transcription failed', start, language);
  }

  const text = (body.text ?? '').trim();
  const metadata = {
    language: body.language ?? language,
    latencyMs: Date.now() - start,
    model: MODEL,
    duration: typeof body.duration === 'number' ? body.duration : undefined,
  };
  return text ? { transcript: text, metadata } : { transcript: '— silent', metadata };
}

function placeholder(text: string, start: number, language: string): TranscribeResult {
  return { transcript: text, metadata: { language, latencyMs: Date.now() - start, model: MODEL } };
}
