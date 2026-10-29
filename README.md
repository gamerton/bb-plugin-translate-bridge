# Translate Bridge for BB

Chat with coding agents in your language while the main agent reads and replies in English. A separate translator handles both directions, and every original stays one click away.

[Русская документация](README.ru.md)

## Install

Requires **BB 0.48 or newer** with **Plugin SDK 0.6.94 or newer**.

```sh
bb plugin install git:https://github.com/gamerton/bb-plugin-translate-bridge.git@v0.2.0
```

Or track compatible releases:

```sh
bb plugin install 'git:https://github.com/gamerton/bb-plugin-translate-bridge.git@^0.2.0'
```

BB installs runtime dependencies and builds the plugin. Git must be available; BB supplies its build tools. Linux is the tested platform. Other operating systems have not been verified.

## Use

1. Open a thread and use the translation button in the composer to enable **RU→EN**.
2. Open the arrow beside the button to choose a translator, test it, and save it for this thread or as the default.
3. Read translated replies in the timeline. Use **Показать оригинал** to inspect a reply's original or **Показать, что ушло модели** to inspect the translated prompt.

The language pair is configurable; Russian ↔ English is the default. **Ctrl+Alt+T** toggles translation, although Linux desktop shortcuts may intercept it.

## Translator options

| Option | How translation runs | Requirements |
| --- | --- | --- |
| Local / API | Direct OpenAI-compatible `/chat/completions` request | Reachable endpoint, model and optional API key |
| Claude Code | Fresh CLI process, translation system prompt, no built-in tools, MCP or skills | Authenticated `claude` CLI on the thread's machine |
| Codex | Ephemeral CLI process, replacement instructions and no tools, MCP or skills | Authenticated `codex` CLI on the thread's machine |
| OpenCode | Private standalone run with a translation agent and no tools | OpenCode **2.x** and a configured model/account on the thread's machine |
| Other BB providers | Short-lived hidden BB worker thread | A working provider in BB |

Claude Code, Codex and OpenCode translation calls do not create hidden BB agent threads. Their normal CLI login is used. OpenCode's fresh translation session is deleted after the call; a forced crash can leave it in local OpenCode history.

Codex deliberately ignores user `config.toml` and rules to avoid loading MCP, plugins and agent context. Custom providers declared there are therefore not applied. OpenCode uses normal global provider configuration, but runs from a generated temporary project. Claude Code uses the coding environment's directory and its own CLI settings. Variables that BB injects only into ordinary provider sessions are not automatically passed to these CLI calls.

The selected supported reasoning/effort is retained. Removing tools does not disable a model's internal reasoning. A small amount of CLI environment metadata may remain. A failed CLI translation never silently falls back to a full-context BB thread.

## What happens to messages

- Your message waits in the queue until translation succeeds, then the translated text is delivered to the main agent.
- Finished assistant replies are translated back and displayed over the original timeline text.
- Fenced code blocks and composer mention pills are protected with placeholders and restored afterward. The translator is instructed to preserve inline code, paths, commands, links and identifiers; those spans are not all mechanically removed from its input.
- Large messages are split into chunks. An echoed or wrong-language outgoing translation is retried once, then held with an error if it still fails.
- Use **Отправить сейчас** to deliberately send the original when translation fails.

## Settings and commands

Settings → Installed plugins → Translate Bridge, or:

```sh
bb plugin config translate-bridge set userLanguage Russian
bb plugin config translate-bridge set modelLanguage English
bb plugin config translate-bridge set openAiBaseUrl http://127.0.0.1:8080/v1
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `userLanguage` | `Russian` | Language you write and read |
| `modelLanguage` | `English` | Language delivered to the main agent |
| `openAiBaseUrl` | `http://127.0.0.1:8080/v1` | API endpoint, reachable from the BB server |
| `openAiApiKey` | unset | Optional secret API key; configure in BB settings |
| `newThreadsDefault` | `false` | Enable translation for new threads |
| `timeoutSeconds` | `240` | Timeout per translation request |

For loopback API endpoints, requests include `chat_template_kwargs.enable_thinking=false` for compatible local models.

```sh
bb translate-bridge status THREAD_ID
bb translate-bridge on THREAD_ID
bb translate-bridge off THREAD_ID
bb translate-bridge test 'Привет, проверь этот файл.'
bb plugin logs translate-bridge
```

Run a provider-based CLI test from a BB thread so its project and machine are known.

## Data and limitations

Messages are sent to the translator you select, in addition to the main agent. Translations and originals are stored in BB's plugin data; no credentials, conversation history or user settings are bundled with this repository.

Replies are translated after completion, not while streaming. Thought blocks, tool calls and plans are not translated. The timeline overlay relies on BB DOM attributes; if these change, original messages remain available. Local/API endpoint access happens on the BB server; CLI translators run on the original thread's environment host.

CLI/API account limits still apply. An HTTP 429 or `provider.quota` error requires available service quota or another translator.

## Development

Use Node.js 24, npm and a compatible BB CLI.

```sh
npm ci --ignore-scripts
npm run check
bb plugin build .
bb plugin install .
```

`npm run check` runs TypeScript checking and the test suite. The tests cover Markdown protection, language checks, CLI invocation, timeout/cancellation and temporary-file cleanup without making paid model requests.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md).
