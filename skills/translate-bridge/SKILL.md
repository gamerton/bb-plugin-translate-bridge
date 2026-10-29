---
name: translate-bridge
description: "Translate Bridge plugin: per-thread translation so the person chats in their language while the main model works in English. Use when asked about the RU→EN toggle, the translator model, or `bb translate-bridge`."
---

# Translate Bridge

When translation is on for a thread, every message the person sends is held
("Перевожу на английский…" on the queued card), translated into the model
language by a separate translator model, and only then delivered. Assistant
replies are translated back and shown in the person's language; the original
is one click away ("Показать оригинал").

If you are the agent in such a thread: think and answer in English. Do not
translate your replies yourself and do not mention the translation.

## Commands

- `bb translate-bridge status [thread-id] [--json]` — on/off, translator, endpoint, languages.
- `bb translate-bridge on <thread-id>` / `off <thread-id>` — toggle a thread.
- `bb translate-bridge test <text...>` — translate a sample with the default translator.

## Translators

- **Local / API**: any OpenAI-compatible endpoint (setting `openAiBaseUrl`,
  default `http://127.0.0.1:8080/v1` for llama.cpp; Ollama is
  `http://127.0.0.1:11434/v1`). Optional `openAiApiKey` secret.
- **bb model / Claude Code**: a fresh `claude -p` process on the thread's
  environment host, with a translation-only system prompt, no built-in tools,
  MCP or skills, and no persisted session. Uses that host's Claude CLI login
  and settings; BB-only per-thread environment overrides are not inherited.
- **bb model / Codex**: ephemeral `codex exec` with a replacement translation
  prompt and disabled tools. Ignores user config and rules (retains normal CLI
  login); custom providers from config.toml are not applied.
- **bb model / OpenCode** (`acp-opencode`): requires OpenCode 2.x; a private
  standalone CLI run with a translation agent and no tools. Preserves the normal
  credentials DB; deletes its own fresh translation session after completion.
- **bb model / other providers**: each translation runs in a short-lived hidden
  worker thread (slower, but needs no extra setup).

A thread can override the default translator from the composer's chevron
next to the RU→EN toggle, at any point in the conversation.

## Settings

`bb plugin config translate-bridge set <key> <value>`: `userLanguage`
(default Russian), `modelLanguage` (English), `openAiBaseUrl`, `openAiApiKey`,
`newThreadsDefault`, `timeoutSeconds`.
