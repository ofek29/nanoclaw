---
paths:
  - "src/preprocessing/**"
  - "src/channels/whatsapp.ts"
  - "src/router.ts"
---

# Carried local patches

This install carries two patches that upstream does not have. Both are committed
on top of upstream's HEAD, so `/update-nanoclaw` replays them. When a replay
conflicts, this file is the intent to preserve.

`git log --oneline upstream/main..main` lists them.

## Voice transcription

`src/preprocessing/` plus a hook in `deliverToAgent`. Inbound voice notes are
transcribed by a local speaches/faster-whisper service on `127.0.0.1:9000`
(systemd unit `whisper-service.service`, a separate project) before the message
reaches the agent.

Invariants:

- **Force the language, never auto-detect.** Detection misclassifies short
  Hebrew clips as Slovenian/Latin/French. Each agent's language is a plain file
  at `groups/<folder>/voice-language`, defaulting to `he`.
- **Audio bytes stay out of every sink.** `deliverToAgent` has three content
  consumers — the session write, the cross-session fan, and the session-created
  hook. Transcribe once and pass the result to all three; fanning raw content
  copies audio into sibling sessions. The on-disk file the Baileys adapter
  writes is deleted after transcription.
- **Never throw.** Unreachable, failed and empty transcriptions all return a
  placeholder transcript, and unparseable content passes through untouched.

`WHISPER_API_KEY` lives in `.env` and is read via `readEnvFile()` at call time,
so a rotated key applies to the next voice note with no restart.

## Reply-engage

`isReplyToBot()` in `src/channels/whatsapp.ts`, folded into the mention
decision. With `engage_mode=mention` the agent answers only an `@` pill, which
is unnatural in a family group where people reply instead. A quoted reply to one
of the bot's own messages engages it too.

`audioMessage` belongs in the quoted-source list: a voice note carries no
caption and no `mentionedJid`, so replying is the only way to address the bot by
voice.

Both patches suit upstream. Sending them as PRs to the `channels` branch would
retire this file.
