# Changelog

## 0.2.0 — 2026-10-29

- Add translation-only Claude Code, Codex and OpenCode 2.x CLI sessions without model-facing tools.
- Run CLI translation on the source thread's environment host and retain normal CLI authentication.
- Add bounded output, cancellation, timeouts and temporary-file cleanup; remove fresh OpenCode translation sessions after use.
- Pass BB thread/project context to the translation test command.
- Add CLI adapter tests and update installation and translator documentation.

## 0.1.0

- Initial supplied Linux package: per-thread translation, OpenAI-compatible endpoints, hidden BB translator workers, original-message controls and Markdown protection.
