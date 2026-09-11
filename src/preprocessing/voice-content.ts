/**
 * Transcribe audio attachments on an inbound message, splice the transcript
 * into `text`, and strip the audio bytes so they never reach the session DB.
 * Called by the router once per engaging agent, in that agent's language.
 *
 * Two adapter shapes are supported:
 *   - `data` (base64)  — chat-SDK-bridge adapters pass bytes inline.
 *   - `localPath`      — the native WhatsApp/Baileys adapter saves media under
 *                        DATA_DIR and passes a relative path. We read it back,
 *                        transcribe, then delete it.
 *
 * Hard rule: audio bytes never persist outside the whisper-service. The on-disk
 * copy is removed after transcription and the attachment is dropped from the
 * content before it is written or fanned anywhere.
 *
 * Defensive by design — the raw string is returned unchanged when there are no
 * audio attachments or the JSON can't be parsed. The router must never drop a
 * message just because the content shape is unexpected.
 *
 * LOCAL ADDITION — not upstream NanoClaw. Re-apply after an update.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { log } from '../log.js';
import { formatVoicePrefix, transcribeAudio } from './whisper.js';

/** Fallback when a group declares no language of its own. */
export const DEFAULT_VOICE_LANGUAGE = 'he';

/** Per-agent language file, read from the group folder. */
const VOICE_LANGUAGE_FILE = 'voice-language';

interface AudioAttachmentEntry {
  type?: string;
  mimeType?: string;
  data?: string; // base64 (chat-SDK adapters)
  localPath?: string; // relative to DATA_DIR (WhatsApp/Baileys)
  size?: number;
  name?: string;
}

interface InboundContent {
  text?: string;
  attachments?: AudioAttachmentEntry[];
  [key: string]: unknown;
}

export interface TranscribeContext {
  platformId: string;
  agentGroupId: string;
}

/**
 * Read an agent's voice language from `groups/<folder>/voice-language`.
 * Stored as a plain file rather than a DB column so the feature touches no
 * upstream schema — see the workspace plan, Phase 8. Missing or unreadable
 * falls back to DEFAULT_VOICE_LANGUAGE.
 */
export function resolveVoiceLanguage(folder: string): string {
  if (!folder || folder.includes('/') || folder.includes('\\') || folder.includes('..')) {
    return DEFAULT_VOICE_LANGUAGE;
  }
  try {
    const raw = fs
      .readFileSync(path.join(GROUPS_DIR, folder, VOICE_LANGUAGE_FILE), 'utf-8')
      .trim()
      .toLowerCase();
    return /^[a-z]{2,3}$/.test(raw) ? raw : DEFAULT_VOICE_LANGUAGE;
  } catch {
    return DEFAULT_VOICE_LANGUAGE;
  }
}

export async function transcribeAndStripAudio(
  rawContent: string,
  language: string,
  context: TranscribeContext,
): Promise<string> {
  let content: InboundContent;
  try {
    content = JSON.parse(rawContent) as InboundContent;
  } catch {
    return rawContent;
  }
  if (!content || typeof content !== 'object') return rawContent;

  const attachments = Array.isArray(content.attachments) ? content.attachments : [];
  const audioIdxs: number[] = [];
  attachments.forEach((a, i) => {
    if (a && a.type === 'audio' && (typeof a.data === 'string' || typeof a.localPath === 'string')) {
      audioIdxs.push(i);
    }
  });
  if (audioIdxs.length === 0) return rawContent;

  const transcriptLines: string[] = [];
  const transcribed = new Set<number>();

  for (const i of audioIdxs) {
    const att = attachments[i];

    let buf: Buffer;
    let diskPath: string | null = null;
    if (typeof att.data === 'string') {
      buf = Buffer.from(att.data, 'base64');
    } else {
      // localPath is adapter-supplied — keep the resolved path inside DATA_DIR.
      const abs = path.resolve(DATA_DIR, att.localPath!);
      if (abs !== DATA_DIR && !abs.startsWith(DATA_DIR + path.sep)) {
        log.warn('voice transcription skipped — audio path escapes data dir', { localPath: att.localPath });
        continue;
      }
      if (!fs.existsSync(abs)) {
        log.warn('voice transcription skipped — audio file missing', { localPath: att.localPath });
        continue;
      }
      buf = fs.readFileSync(abs);
      diskPath = abs;
    }

    const { transcript, metadata } = await transcribeAudio(buf, att.mimeType ?? 'audio/ogg', language);
    transcriptLines.push(`${formatVoicePrefix(metadata.duration)} ${transcript}`.trim());
    transcribed.add(i);

    // "Audio bytes never persist": drop the on-disk copy once transcribed.
    if (diskPath) {
      try {
        fs.unlinkSync(diskPath);
      } catch {
        /* best-effort cleanup */
      }
    }

    log.info('voice_transcribed', {
      platformId: context.platformId,
      agentGroupId: context.agentGroupId,
      durationSeconds: metadata.duration,
      latencyMs: metadata.latencyMs,
      forcedLanguage: language,
      reportedLanguage: metadata.language,
      model: metadata.model,
      size: att.size,
    });
  }

  if (transcribed.size === 0) return rawContent;

  const existingText = typeof content.text === 'string' ? content.text : '';
  content.text = existingText ? `${transcriptLines.join('\n')}\n[caption] ${existingText}` : transcriptLines.join('\n');

  // Only drop what was actually transcribed — an attachment we skipped keeps
  // its bytes rather than vanishing silently.
  const remaining = attachments.filter((_, i) => !transcribed.has(i));
  if (remaining.length > 0) {
    content.attachments = remaining;
  } else {
    delete content.attachments;
  }

  return JSON.stringify(content);
}
