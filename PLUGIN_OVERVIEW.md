Use a separate local or hosted translator for both directions while keeping originals available in the same conversation.

## Features

- Toggle translation from the thread composer, including the new-thread composer.
- Choose a translator per thread or save a default.
- Use any OpenAI-compatible endpoint or a model from BB's catalog.
- Inspect original replies and the prompts actually sent to the main agent.

## Translation without coding tools

Claude Code, Codex and OpenCode 2.x use separate CLI calls with translation instructions and no model-facing tools. Other providers use hidden BB threads. Code blocks and composer mentions are protected; translators are instructed to preserve Markdown, paths and identifiers.

## Requirements

BB 0.48 or newer and Plugin SDK 0.6.94 or newer. Linux is the tested platform. CLI translators require the corresponding installed CLI, account and model access on the thread's machine. API translators require a reachable endpoint and, where applicable, an API key. Service usage limits and charges still apply.

Codex's minimal translator does not load user config.toml or custom providers from it. OpenCode requires version 2.x. Replies are translated after completion; reasoning and tool calls are not translated.
