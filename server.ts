// Translate Bridge — backend entry.
//
// Outgoing: the message.dispatch hook holds a person's message ("wait") while
// the translator turns it into the model language, rewrites the queued row in
// place, then asks core to re-decide it. The expensive model only ever reads
// the translation.
//
// Incoming: when an assistant message settles, it is translated back into the
// person's language and stored by timeline row id. The frontend overlay draws
// the translation in place of the original, with a toggle to see the original.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { nativeHostContract } from "./lib/native-host-contract";
import {
  describeTranslator,
  openAiComplete,
  openAiModels,
  translatorSchema,
  type OpenAiEndpoint,
  type Translator,
} from "./lib/engines";
import {
  hashText,
  needsTranslation,
  protectMentions,
  restoreMentions,
  translateMarkdown,
  type Direction,
  type Languages,
} from "./lib/translation";

export type { Translator } from "./lib/engines";

const rowStatusSchema = z.enum(["pending", "done", "error", "skipped"]);
const viewRowSchema = z.object({
  rowId: z.string(),
  role: z.enum(["user", "assistant"]),
  /** Text in the person's language; null until the translation is ready. */
  text: z.string().nullable(),
  status: rowStatusSchema,
  error: z.string().nullable(),
});
export type ViewRow = z.infer<typeof viewRowSchema>;

const stateSchema = z.object({
  threadId: z.string().nullable(),
  enabled: z.boolean(),
  newThreadsDefault: z.boolean(),
  /** This thread's own translator, or null when it follows the default. */
  threadTranslator: translatorSchema.nullable(),
  defaultTranslator: translatorSchema,
  effectiveTranslator: translatorSchema,
  effectiveLabel: z.string(),
  openAiBaseUrl: z.string(),
  languages: z.object({ user: z.string(), model: z.string() }),
});
export type BridgeState = z.infer<typeof stateSchema>;

const threadIdSchema = z.string().min(1).max(200);

export const rpcContract = defineRpcContract({
  state: {
    input: z.object({ threadId: threadIdSchema.nullable() }).strict(),
    output: stateSchema,
  },
  setEnabled: {
    input: z.object({ threadId: threadIdSchema, enabled: z.boolean() }).strict(),
    output: stateSchema,
  },
  setNewThreadsDefault: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: z.object({ newThreadsDefault: z.boolean() }),
  },
  setTranslator: {
    input: z.object({
      /** null sets the default for every thread without its own choice. */
      threadId: threadIdSchema.nullable(),
      /** null on a thread clears its own choice. */
      translator: translatorSchema.nullable(),
    }).strict(),
    output: stateSchema,
  },
  view: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ threadId: z.string(), enabled: z.boolean(), rows: z.array(viewRowSchema) }),
  },
  retranslate: {
    input: z.object({ threadId: threadIdSchema, rowId: z.string().min(1).max(500) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  openAiModels: {
    input: z.null(),
    output: z.object({ baseUrl: z.string(), models: z.array(z.string()), error: z.string().nullable() }),
  },
  test: {
    input: z.object({
      translator: translatorSchema,
      text: z.string().min(1).max(4000),
      direction: z.enum(["to-model", "to-user"]),
      threadId: threadIdSchema.nullable(),
      projectId: z.string().max(200).nullable(),
    }).strict(),
    output: z.object({ output: z.string(), ms: z.number() }),
  },
});

/** Realtime channels the frontend listens on. */
export const VIEW_CHANGED = "view-changed";
export const STATE_CHANGED = "state-changed";

const INSTRUCTIONS = (languages: Languages) =>
  [
    `Translate Bridge is on for this thread. The user writes in ${languages.user}; every user message reaches you machine-translated into ${languages.model}.`,
    `Think and answer in ${languages.model} only, even if some ${languages.user} slips through.`,
    `Your replies are translated into ${languages.user} for the user automatically: never translate them yourself and do not mention the translation.`,
  ].join(" ");

const NOTICE = (languages: Languages) =>
  `[Translate Bridge] From here on the user's messages are machine-translated from ${languages.user} into ${languages.model}. Think and reply in ${languages.model} only; your replies are translated into ${languages.user} for the user automatically. Do not mention the translation.`;

interface ThreadStateRow {
  thread_id: string;
  enabled: number;
  translator: string | null;
  enabled_at: number;
  notice_pending: number;
}

interface IncomingRow {
  row_id: string;
  thread_id: string;
  source_hash: string;
  translated: string | null;
  status: z.infer<typeof rowStatusSchema>;
  error: string | null;
  attempts: number;
}

type PromptBlock = Parameters<BbPluginApi["sdk"]["threads"]["queuedMessages"]["update"]>[0]["input"][number];
type QueuedMessage = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["queuedMessages"]["list"]>>[number];

const MAX_ATTEMPTS = 2;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function parseTranslator(raw: string | null | undefined): Translator | null {
  if (!raw) return null;
  try {
    const parsed = translatorSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    userLanguage: {
      type: "string",
      label: "Your language",
      description: "The language you write and read in.",
      default: "Russian",
    },
    modelLanguage: {
      type: "string",
      label: "Model language",
      description: "The language the main model thinks and answers in.",
      default: "English",
    },
    openAiBaseUrl: {
      type: "string",
      label: "OpenAI-compatible endpoint",
      description: "Base URL ending in /v1: llama.cpp, Ollama (http://127.0.0.1:11434/v1), LM Studio, vLLM, OpenRouter, OpenAI…",
      default: "http://127.0.0.1:8080/v1",
    },
    openAiApiKey: {
      type: "string",
      label: "Endpoint API key",
      description: "Leave empty for local servers.",
      secret: true,
    },
    newThreadsDefault: {
      type: "boolean",
      label: "Translate new threads",
      description: "Turn translation on for threads you start from now on.",
      default: false,
    },
    timeoutSeconds: {
      type: "number",
      label: "Translator timeout, seconds",
      experimental_schema: z.number().int().min(10).max(1800),
      default: 240,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE threads (
      thread_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      translator TEXT,
      enabled_at INTEGER NOT NULL,
      notice_pending INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE outgoing (
      queued_message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      original TEXT NOT NULL,
      translated TEXT NOT NULL,
      row_id TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX outgoing_thread ON outgoing (thread_id, row_id)`,
    `CREATE TABLE incoming (
      row_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      translated TEXT,
      status TEXT NOT NULL,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX incoming_thread ON incoming (thread_id)`,
  ]);

  const statements = {
    thread: db.prepare<[string], ThreadStateRow>(`SELECT * FROM threads WHERE thread_id = ?`),
    enabledThreads: db.prepare<[], { thread_id: string }>(`SELECT thread_id FROM threads WHERE enabled = 1`),
    upsertThread: db.prepare(
      `INSERT INTO threads (thread_id, enabled, translator, enabled_at, notice_pending, updated_at)
       VALUES (@thread_id, @enabled, @translator, @enabled_at, @notice_pending, @updated_at)
       ON CONFLICT (thread_id) DO UPDATE SET enabled = excluded.enabled, translator = excluded.translator,
         enabled_at = excluded.enabled_at, notice_pending = excluded.notice_pending, updated_at = excluded.updated_at`,
    ),
    clearNotice: db.prepare<[string]>(`UPDATE threads SET notice_pending = 0 WHERE thread_id = ?`),
    outgoingById: db.prepare<[string], { queued_message_id: string }>(
      `SELECT queued_message_id FROM outgoing WHERE queued_message_id = ?`,
    ),
    insertOutgoing: db.prepare(
      `INSERT OR REPLACE INTO outgoing (queued_message_id, thread_id, original, translated, row_id, created_at)
       VALUES (@queued_message_id, @thread_id, @original, @translated, NULL, @created_at)`,
    ),
    deleteOutgoing: db.prepare<[string]>(`DELETE FROM outgoing WHERE queued_message_id = ?`),
    unmappedOutgoing: db.prepare<[string], { queued_message_id: string; translated: string }>(
      `SELECT queued_message_id, translated FROM outgoing WHERE thread_id = ? AND row_id IS NULL ORDER BY created_at`,
    ),
    mappedRowIds: db.prepare<[string], { row_id: string }>(
      `SELECT row_id FROM outgoing WHERE thread_id = ? AND row_id IS NOT NULL`,
    ),
    mapOutgoing: db.prepare<[string, string]>(`UPDATE outgoing SET row_id = ? WHERE queued_message_id = ?`),
    userRows: db.prepare<[string], { row_id: string; original: string }>(
      `SELECT row_id, original FROM outgoing WHERE thread_id = ? AND row_id IS NOT NULL ORDER BY created_at DESC LIMIT 500`,
    ),
    incoming: db.prepare<[string], IncomingRow>(`SELECT * FROM incoming WHERE row_id = ?`),
    incomingForThread: db.prepare<[string], IncomingRow>(
      `SELECT * FROM incoming WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 500`,
    ),
    upsertIncoming: db.prepare(
      `INSERT INTO incoming (row_id, thread_id, source_hash, translated, status, error, attempts, updated_at)
       VALUES (@row_id, @thread_id, @source_hash, @translated, @status, @error, @attempts, @updated_at)
       ON CONFLICT (row_id) DO UPDATE SET source_hash = excluded.source_hash, translated = excluded.translated,
         status = excluded.status, error = excluded.error, attempts = excluded.attempts, updated_at = excluded.updated_at`,
    ),
    deleteIncoming: db.prepare<[string]>(`DELETE FROM incoming WHERE row_id = ?`),
    pendingIncoming: db.prepare<[], { row_id: string }>(`SELECT row_id FROM incoming WHERE status = 'pending'`),
    resetPendingIncoming: db.prepare(`UPDATE incoming SET status = 'error', error = 'Interrupted by a restart' WHERE status = 'pending'`),
    deleteThread: db.transaction((threadId: string) => {
      db.prepare(`DELETE FROM threads WHERE thread_id = ?`).run(threadId);
      db.prepare(`DELETE FROM outgoing WHERE thread_id = ?`).run(threadId);
      db.prepare(`DELETE FROM incoming WHERE thread_id = ?`).run(threadId);
    }),
  };

  // Translations interrupted by the last shutdown can be retried.
  statements.resetPendingIncoming.run();

  /** contributeInstructions is synchronous, so the enabled set lives here. */
  const enabledThreads = new Set(statements.enabledThreads.all().map((row) => row.thread_id));
  let current = await settings.get();
  settings.onChange((next) => {
    current = next;
    bb.realtime.publish(STATE_CHANGED, { threadId: null });
  });

  const languages = (): Languages => ({
    user: current.userLanguage.trim() || "Russian",
    model: current.modelLanguage.trim() || "English",
  });
  const endpoint = (): OpenAiEndpoint => ({
    baseUrl: current.openAiBaseUrl.trim() || "http://127.0.0.1:8080/v1",
    apiKey: typeof current.openAiApiKey === "string" && current.openAiApiKey !== "" ? current.openAiApiKey : undefined,
    timeoutMs: current.timeoutSeconds * 1000,
  });

  async function defaultTranslator(): Promise<Translator> {
    const stored = translatorSchema.safeParse(await bb.storage.kv.get("defaultTranslator"));
    return stored.success ? stored.data : { engine: "openai", model: "" };
  }

  function threadState(threadId: string): ThreadStateRow | undefined {
    return statements.thread.get(threadId);
  }

  function writeThread(threadId: string, patch: Partial<Omit<ThreadStateRow, "thread_id">>): ThreadStateRow {
    const previous = threadState(threadId);
    const next: ThreadStateRow = {
      thread_id: threadId,
      enabled: patch.enabled ?? previous?.enabled ?? 0,
      translator: patch.translator !== undefined ? patch.translator : previous?.translator ?? null,
      enabled_at: patch.enabled_at ?? previous?.enabled_at ?? Date.now(),
      notice_pending: patch.notice_pending ?? previous?.notice_pending ?? 1,
    };
    statements.upsertThread.run({ ...next, updated_at: Date.now() });
    if (next.enabled === 1) enabledThreads.add(threadId);
    else enabledThreads.delete(threadId);
    return next;
  }

  function setEnabled(threadId: string, enabled: boolean): void {
    const previous = threadState(threadId);
    if ((previous?.enabled === 1) === enabled) return;
    writeThread(threadId, enabled ? { enabled: 1, enabled_at: Date.now(), notice_pending: 1 } : { enabled: 0 });
    bb.realtime.publish(STATE_CHANGED, { threadId });
    bb.realtime.publish(VIEW_CHANGED, { threadId });
    if (enabled) scheduleSync(threadId, 200);
  }

  async function translatorFor(threadId: string | null): Promise<Translator> {
    const own = threadId === null ? null : parseTranslator(threadState(threadId)?.translator);
    return own ?? (await defaultTranslator());
  }

  async function stateFor(threadId: string | null): Promise<BridgeState> {
    const row = threadId === null ? undefined : threadState(threadId);
    const fallback = await defaultTranslator();
    const own = parseTranslator(row?.translator);
    const effective = own ?? fallback;
    return {
      threadId,
      enabled: row?.enabled === 1,
      newThreadsDefault: current.newThreadsDefault,
      threadTranslator: own,
      defaultTranslator: fallback,
      effectiveTranslator: effective,
      effectiveLabel: describeTranslator(effective),
      openAiBaseUrl: endpoint().baseUrl,
      languages: languages(),
    };
  }

  // ---------------------------------------------------------------------------
  // Translator calls

  /** Resolvers for hidden worker threads, settled by thread.idle/failed. */
  const workers = new Map<string, { resolve: (text: string | null) => void; reject: (error: Error) => void }>();

  interface CallContext {
    threadId: string | null;
    projectId: string | null;
  }

  const nativeHost = bb.hosts.experimental_client({ contract: nativeHostContract });
  const nativeCalls = new AbortController();

  async function nativeComplete(
    translator: Extract<Translator, { engine: "bb" }>,
    system: string,
    user: string,
    context: CallContext,
  ): Promise<string> {
    // Select the invoking thread's machine, never the server's own filesystem.
    // An unsent composer test can use the project's sole ready environment.
    let environment;
    if (context.threadId !== null) {
      const thread = await bb.sdk.threads.get({ threadId: context.threadId });
      if (thread.environmentId === null) throw new Error("The CLI translator needs a thread environment");
      environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    } else if (context.projectId !== null) {
      const environments = await bb.sdk.environments.list({ projectId: context.projectId, status: "ready", limit: 2 });
      if (environments.length !== 1) throw new Error("Open a thread to select the translator's machine");
      environment = environments[0];
    }
    if (!environment || environment.path === null) throw new Error("A CLI translator needs an open thread or a project environment with a directory");
    const timeoutMs = current.timeoutSeconds * 1000;
    const result = await nativeHost.call("complete", {
      engine: translator.providerId === "codex" ? "codex" : translator.providerId === "acp-opencode" ? "opencode" : "claude",
      model: translator.model, reasoningLevel: translator.reasoningLevel,
      system, user, cwd: environment.path, timeoutMs,
    }, {
      hostId: environment.hostId, signal: nativeCalls.signal,
      timeoutMs: Math.min(1_800_000, timeoutMs + 5000),
    });
    return result.text;
  }

  async function workerComplete(
    translator: Extract<Translator, { engine: "bb" }>,
    system: string,
    user: string,
    context: CallContext,
  ): Promise<string> {
    let projectId = context.projectId;
    let environmentId: string | null = null;
    if (context.threadId !== null) {
      const thread = await bb.sdk.threads.get({ threadId: context.threadId });
      projectId = thread.projectId;
      environmentId = thread.environmentId;
    }
    if (projectId === null) throw new Error("A bb provider translator needs a project; open a thread first");
    const worker = await bb.sdk.threads.spawn({
      projectId,
      environment: environmentId === null ? { type: "project-default" } : { type: "reuse", environmentId },
      providerId: translator.providerId,
      model: translator.model,
      ...(translator.reasoningLevel === "" ? {} : { reasoningLevel: translator.reasoningLevel }),
      permissionMode: "auto",
      visibility: "hidden",
      title: "Translate Bridge worker",
      pluginMetadata: { worker: true },
      prompt: `${system}\n\nDo not use any tools. Reply with the <translation> block right away.\n\n${user}`,
    });
    const timeoutMs = current.timeoutSeconds * 1000;
    try {
      const output = await new Promise<string | null>((resolve, reject) => {
        workers.set(worker.id, { resolve, reject });
        const timer = setTimeout(() => reject(new Error(`The translator thread did not answer in ${current.timeoutSeconds}s`)), timeoutMs);
        // thread.idle can race the registration above; poll as a fallback.
        const poll = setInterval(() => {
          void bb.sdk.threads.get({ threadId: worker.id }).then(async (thread) => {
            if (thread.status === "error") reject(new Error("The translator thread failed"));
            if (thread.status !== "idle") return;
            const { output } = await bb.sdk.threads.output({ threadId: worker.id });
            if (output !== null) resolve(output);
          }, () => {});
        }, 4000);
        const done = () => {
          clearTimeout(timer);
          clearInterval(poll);
        };
        workers.set(worker.id, {
          resolve: (text) => { done(); resolve(text); },
          reject: (error) => { done(); reject(error); },
        });
      });
      if (output === null || output.trim() === "") throw new Error("The translator thread returned no text");
      return output;
    } finally {
      workers.delete(worker.id);
      await bb.sdk.threads.archive({ threadId: worker.id }).catch(() => {});
      await bb.sdk.threads.stop({ threadId: worker.id }).catch(() => {});
    }
  }

  function caller(translator: Translator, context: CallContext) {
    return (system: string, user: string): Promise<string> =>
      translator.engine === "openai"
        ? openAiComplete(endpoint(), translator.model, system, user)
        : ["claude-code", "codex", "acp-opencode"].includes(translator.providerId)
          ? nativeComplete(translator, system, user, context)
          : workerComplete(translator, system, user, context);
  }

  async function translate(text: string, direction: Direction, translator: Translator, context: CallContext): Promise<string> {
    // Hidden worker threads are slow to start, so give them bigger chunks.
    const maxChunk = translator.engine === "bb" ? 20_000 : 6000;
    return translateMarkdown(text, direction, languages(), caller(translator, context), { maxChunk });
  }

  // A small job queue: local servers usually handle one request at a time,
  // and outgoing messages jump the line because a person is waiting.
  const jobs: (() => Promise<void>)[] = [];
  let runningJobs = 0;
  const MAX_JOBS = 2;
  function enqueue(job: () => Promise<void>, urgent = false): void {
    if (urgent) jobs.unshift(job);
    else jobs.push(job);
    pump();
  }
  function pump(): void {
    while (runningJobs < MAX_JOBS && jobs.length > 0) {
      const job = jobs.shift()!;
      runningJobs++;
      void job()
        .catch((cause) => bb.log.error(`job failed: ${errorMessage(cause)}`))
        .finally(() => {
          runningJobs--;
          pump();
        });
    }
  }

  // ---------------------------------------------------------------------------
  // Outgoing: person → model

  const translating = new Set<string>();
  const failures = new Map<string, string>();

  function isOurRowWait(message: QueuedMessage): boolean {
    return message.waitingOn?.kind === "plugin" && message.waitingOn.pluginId === bb.pluginId;
  }

  async function translateBlocks(
    blocks: readonly PromptBlock[],
    translator: Translator,
    context: CallContext,
    notice: boolean,
  ): Promise<{ input: PromptBlock[]; original: string; translated: string }> {
    const input: PromptBlock[] = [];
    const originals: string[] = [];
    const translations: string[] = [];
    for (const block of blocks) {
      if (block.type !== "text" || block.visibility === "agent-only" || !needsTranslation(block.text, "to-model", languages())) {
        input.push(block);
        if (block.type === "text" && block.visibility !== "agent-only") {
          originals.push(block.text);
          translations.push(block.text);
        }
        continue;
      }
      // A leading slash command must stay first and untouched.
      const command = /^\s*\/[\w:.-]+(?=\s|$)/u.exec(block.text)?.[0] ?? "";
      const mentions = block.mentions.filter((m) => m.start >= command.length);
      const keptMentions = block.mentions.filter((m) => m.start < command.length);
      const body = block.text.slice(command.length);
      const shifted = mentions.map((m) => ({ ...m, start: m.start - command.length, end: m.end - command.length }));
      const guarded = protectMentions(body, shifted);
      const translatedBody = await translate(guarded.text, "to-model", translator, context);
      const restored = restoreMentions(translatedBody, body, guarded.mentions);
      const separator = command !== "" && restored.text !== "" && !/^\s/u.test(restored.text) ? " " : "";
      const text = command + separator + restored.text;
      const offset = command.length + separator.length;
      input.push({
        ...block,
        text,
        mentions: [
          ...keptMentions,
          ...restored.mentions.map((m) => ({ ...m, start: m.start + offset, end: m.end + offset })),
        ],
      });
      originals.push(block.text);
      translations.push(text);
    }
    if (notice) input.push({ type: "text", text: NOTICE(languages()), mentions: [], visibility: "agent-only" });
    return { input, original: originals.join("\n\n"), translated: translations.join("\n\n") };
  }

  function translateQueued(threadId: string, queuedMessageId: string): void {
    if (translating.has(queuedMessageId)) return;
    translating.add(queuedMessageId);
    enqueue(async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
          const row = rows.find((candidate) => candidate.id === queuedMessageId);
          if (row === undefined || !isOurRowWait(row)) return;
          const state = threadState(threadId);
          if (state?.enabled !== 1) return;
          const translator = await translatorFor(threadId);
          const thread = await bb.sdk.threads.get({ threadId });
          const result = await translateBlocks(
            row.content,
            translator,
            { threadId, projectId: thread.projectId },
            state?.notice_pending === 1,
          );
          // Core rewrites a waiting row on every re-attempt, so its updatedAt
          // is stale after a slow translation. Hold the row (no dispatch
          // attempts, as while a person edits it), re-read it, and write the
          // translation only if the content is still what was translated.
          await bb.sdk.threads.queuedMessages.experimental_holdForEdit({ threadId, queuedMessageId });
          const held = (await bb.sdk.threads.queuedMessages.list({ threadId })).find((candidate) => candidate.id === queuedMessageId);
          if (held === undefined) return;
          if (JSON.stringify(held.content) !== JSON.stringify(row.content)) {
            await bb.sdk.threads.queuedMessages.experimental_releaseEditHold({ threadId, queuedMessageId }).catch(() => {});
            continue;
          }
          // Recorded first: the update releases the hold and core re-asks the
          // hook at once, which must already see this row as translated.
          statements.insertOutgoing.run({
            queued_message_id: queuedMessageId,
            thread_id: threadId,
            original: result.original,
            translated: result.translated,
            created_at: Date.now(),
          });
          try {
            await bb.sdk.threads.queuedMessages.update({
              threadId,
              queuedMessageId,
              expectedUpdatedAt: held.updatedAt,
              input: result.input,
            });
          } catch (cause) {
            statements.deleteOutgoing.run(queuedMessageId);
            await bb.sdk.threads.queuedMessages.experimental_releaseEditHold({ threadId, queuedMessageId }).catch(() => {});
            bb.log.warn(`queued row ${queuedMessageId} changed during translation: ${errorMessage(cause)}`);
            continue;
          }
          if (state?.notice_pending === 1) statements.clearNotice.run(threadId);
          failures.delete(queuedMessageId);
          return;
        }
        throw new Error("The message kept changing while it was being translated");
      } catch (cause) {
        failures.set(queuedMessageId, errorMessage(cause));
        bb.log.warn(`outgoing translation failed: ${errorMessage(cause)}`);
      } finally {
        translating.delete(queuedMessageId);
        await bb.experimental_hooks.recheck("message.dispatch");
      }
    }, true);
  }

  function shouldTranslateThread(threadId: string, isFirstMessage: boolean): boolean {
    const state = threadState(threadId);
    if (state !== undefined) return state.enabled === 1;
    if (isFirstMessage && current.newThreadsDefault) {
      setEnabled(threadId, true);
      return true;
    }
    return false;
  }

  bb.experimental_hooks.on("message.dispatch", (ctx) => {
    if (ctx.thread.originPluginId === bb.pluginId || ctx.originPluginId === bb.pluginId) return { action: "proceed" };
    if (ctx.initiator !== "user") return { action: "proceed" };
    const isFirst = ctx.thread.status === "pending" && ctx.thread.originPluginId === null && ctx.parentThreadId === null;
    if (!shouldTranslateThread(ctx.thread.id, isFirst)) return { action: "proceed" };
    if (ctx.queuedMessages.length > 0 && ctx.queuedMessages.every((m) => statements.outgoingById.get(m.id) !== undefined)) {
      return { action: "proceed" };
    }
    if (!needsTranslation(ctx.input.text, "to-model", languages())) return { action: "proceed" };
    const failed = ctx.queuedMessages.map((m) => failures.get(m.id)).find((reason) => reason !== undefined);
    if (failed !== undefined) {
      return {
        action: "wait",
        reason: `Перевод не удался: ${failed.slice(0, 200)}. «Отправить сейчас» отправит оригинал, или смените переводчик.`,
      };
    }
    // Rows already queued and not yet translated (for example, queued before
    // the plugin started) are picked up here; new ones by message.queued.
    for (const message of ctx.queuedMessages) {
      if (statements.outgoingById.get(message.id) === undefined && isOurRowWait(message)) {
        translateQueued(ctx.thread.id, message.id);
      }
    }
    return { action: "wait", reason: `Перевожу на ${languages().model.toLowerCase() === "english" ? "английский" : languages().model}…` };
  });

  bb.events.on("message.queued", ({ entry }) => {
    if (!isOurRowWait(entry)) return;
    if (statements.outgoingById.get(entry.id) !== undefined) return;
    if (failures.has(entry.id)) return;
    translateQueued(entry.threadId, entry.id);
  });

  bb.events.on("message.cancelled", ({ entry }) => {
    failures.delete(entry.id);
  });

  // ---------------------------------------------------------------------------
  // Incoming: model → person

  const syncs = new Map<string, { timer: ReturnType<typeof setTimeout> | null; running: boolean; again: boolean }>();

  function scheduleSync(threadId: string, delayMs: number): void {
    if (threadState(threadId) === undefined) return;
    let entry = syncs.get(threadId);
    if (entry === undefined) {
      entry = { timer: null, running: false, again: false };
      syncs.set(threadId, entry);
    }
    if (entry.running) {
      entry.again = true;
      return;
    }
    if (entry.timer !== null) return;
    const scheduled = entry;
    scheduled.timer = setTimeout(() => {
      scheduled.timer = null;
      scheduled.running = true;
      void syncThread(threadId)
        .catch((cause) => bb.log.warn(`sync ${threadId} failed: ${errorMessage(cause)}`))
        .finally(() => {
          scheduled.running = false;
          if (scheduled.again) {
            scheduled.again = false;
            scheduleSync(threadId, 1500);
          }
        });
    }, delayMs);
  }

  async function syncThread(threadId: string): Promise<void> {
    const state = threadState(threadId);
    if (state === undefined) return;
    const [thread, timeline] = await Promise.all([
      bb.sdk.threads.get({ threadId }),
      bb.sdk.threads.timeline({ threadId }),
    ]);
    let changed = false;

    // Pair the person's rows with the translations sent in their place.
    const mapped = new Set(statements.mappedRowIds.all(threadId).map((row) => row.row_id));
    const unmapped = statements.unmappedOutgoing.all(threadId);
    for (const row of timeline.rows) {
      if (unmapped.length === 0) break;
      if (row.kind !== "conversation" || row.role !== "user" || mapped.has(row.id)) continue;
      const text = normalize(row.text);
      const index = unmapped.findIndex((candidate) => {
        const sent = normalize(candidate.translated);
        return sent !== "" && (text === sent || text.includes(sent));
      });
      if (index === -1) continue;
      statements.mapOutgoing.run(row.id, unmapped[index]!.queued_message_id);
      unmapped.splice(index, 1);
      changed = true;
    }

    if (state.enabled === 1) {
      const running = thread.status === "active" || thread.status === "starting";
      const translator = await translatorFor(threadId);
      timeline.rows.forEach((row, index) => {
        if (row.kind !== "conversation" || row.role !== "assistant") return;
        if (row.createdAt < state.enabled_at) return;
        // The last row of a running turn may still be streaming.
        if (running && index === timeline.rows.length - 1) return;
        const sourceHash = hashText(row.text);
        const existing = statements.incoming.get(row.id);
        if (existing?.source_hash === sourceHash) {
          if (existing.status !== "error" || existing.attempts >= MAX_ATTEMPTS) return;
        }
        if (existing?.status === "pending") return;
        if (!needsTranslation(row.text, "to-user", languages())) {
          statements.upsertIncoming.run({
            row_id: row.id, thread_id: threadId, source_hash: sourceHash, translated: null,
            status: "skipped", error: null, attempts: 0, updated_at: Date.now(),
          });
          changed = true;
          return;
        }
        const attempts = existing?.source_hash === sourceHash ? existing.attempts : 0;
        statements.upsertIncoming.run({
          row_id: row.id, thread_id: threadId, source_hash: sourceHash, translated: null,
          status: "pending", error: null, attempts, updated_at: Date.now(),
        });
        changed = true;
        const source = row.text;
        enqueue(async () => {
          try {
            const translated = await translate(source, "to-user", translator, { threadId, projectId: thread.projectId });
            statements.upsertIncoming.run({
              row_id: row.id, thread_id: threadId, source_hash: sourceHash, translated,
              status: "done", error: null, attempts: attempts + 1, updated_at: Date.now(),
            });
          } catch (cause) {
            statements.upsertIncoming.run({
              row_id: row.id, thread_id: threadId, source_hash: sourceHash, translated: null,
              status: "error", error: errorMessage(cause).slice(0, 500), attempts: attempts + 1, updated_at: Date.now(),
            });
          }
          bb.realtime.publish(VIEW_CHANGED, { threadId });
        });
      });
    }
    if (changed) bb.realtime.publish(VIEW_CHANGED, { threadId });
  }

  bb.events.on("experimental_thread.events", ({ thread }) => {
    if (enabledThreads.has(thread.id) || statements.unmappedOutgoing.all(thread.id).length > 0) scheduleSync(thread.id, 1500);
  });
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    workers.get(thread.id)?.resolve(lastAssistantText);
    scheduleSync(thread.id, 300);
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    workers.get(thread.id)?.reject(new Error(error ?? "The translator thread failed"));
    scheduleSync(thread.id, 300);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    statements.deleteThread(thread.id);
    enabledThreads.delete(thread.id);
  });

  // ---------------------------------------------------------------------------
  // Agent instructions

  bb.agents.contributeInstructions(({ threadId }) =>
    threadId !== null && threadId !== undefined && enabledThreads.has(threadId) ? INSTRUCTIONS(languages()) : null,
  );

  // ---------------------------------------------------------------------------
  // Startup reconciliation: rows held across a restart, unfinished syncs.

  /**
   * Translate every row this plugin is holding that has no translation yet,
   * including rows whose last attempt failed (after a translator change).
   */
  async function retryHeld(): Promise<void> {
    failures.clear();
    const held = await bb.sdk.threads.queue.list({ waitHolder: `plugin:${bb.pluginId}` });
    for (const row of held) {
      if (statements.outgoingById.get(row.id) === undefined) translateQueued(row.threadId, row.id);
    }
    await bb.experimental_hooks.recheck("message.dispatch");
  }

  bb.background.service("reconcile", {
    async start(signal) {
      try {
        await retryHeld();
        for (const threadId of enabledThreads) scheduleSync(threadId, 1000);
      } catch (cause) {
        bb.log.warn(`reconcile failed: ${errorMessage(cause)}`);
      }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  // ---------------------------------------------------------------------------
  // RPC

  bb.rpc.register(rpcContract, {
    state: ({ threadId }) => stateFor(threadId),
    setEnabled: async ({ threadId, enabled }) => {
      setEnabled(threadId, enabled);
      // Held rows either start translating or, when turned off, go as typed.
      await retryHeld();
      return stateFor(threadId);
    },
    setNewThreadsDefault: async ({ enabled }) => {
      const next = await settings.experimental_set({ newThreadsDefault: enabled });
      return { newThreadsDefault: next.newThreadsDefault };
    },
    setTranslator: async ({ threadId, translator }) => {
      if (threadId === null) {
        if (translator === null) await bb.storage.kv.delete("defaultTranslator");
        else await bb.storage.kv.set("defaultTranslator", translator);
      } else {
        writeThread(threadId, { translator: translator === null ? null : JSON.stringify(translator) });
      }
      bb.realtime.publish(STATE_CHANGED, { threadId });
      await retryHeld();
      return stateFor(threadId);
    },
    view: ({ threadId }) => {
      const rows: ViewRow[] = [];
      for (const row of statements.userRows.all(threadId)) {
        rows.push({ rowId: row.row_id, role: "user", text: row.original, status: "done", error: null });
      }
      for (const row of statements.incomingForThread.all(threadId)) {
        rows.push({ rowId: row.row_id, role: "assistant", text: row.translated, status: row.status, error: row.error });
      }
      return { threadId, enabled: enabledThreads.has(threadId), rows };
    },
    retranslate: ({ threadId, rowId }) => {
      statements.deleteIncoming.run(rowId);
      bb.realtime.publish(VIEW_CHANGED, { threadId });
      scheduleSync(threadId, 100);
      return { ok: true as const };
    },
    openAiModels: async () => {
      const target = endpoint();
      try {
        return { baseUrl: target.baseUrl, models: await openAiModels(target), error: null };
      } catch (cause) {
        return { baseUrl: target.baseUrl, models: [], error: errorMessage(cause) };
      }
    },
    test: async ({ translator, text, direction, threadId, projectId }) => {
      const started = Date.now();
      const output = await translate(text, direction, translator, { threadId, projectId });
      return { output, ms: Date.now() - started };
    },
  });

  // ---------------------------------------------------------------------------
  // CLI

  const usage = [
    "Usage:",
    "  bb translate-bridge status [thread-id] [--json]",
    "  bb translate-bridge on <thread-id>",
    "  bb translate-bridge off <thread-id>",
    "  bb translate-bridge test <text...>     (translates to the model language with the default translator)",
  ].join("\n");
  bb.cli.register({
    name: "translate-bridge",
    summary: "Translate a thread's chat through a cheap model so the main model works in English",
    commands: [
      { name: "status", summary: "Show translation state and translator", usage: "bb translate-bridge status [thread-id] [--json]" },
      { name: "on", summary: "Turn translation on for a thread", usage: "bb translate-bridge on <thread-id>" },
      { name: "off", summary: "Turn translation off for a thread", usage: "bb translate-bridge off <thread-id>" },
      { name: "test", summary: "Translate a sample text with the default translator", usage: "bb translate-bridge test <text...>" },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "status": {
          const state = await stateFor(args[0] ?? null);
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify(state)
              : [
                  state.threadId === null ? "No thread given." : `Thread ${state.threadId}: translation ${state.enabled ? "on" : "off"}`,
                  `Translator: ${state.effectiveLabel}${state.threadTranslator === null ? " (default)" : " (this thread)"}`,
                  `Endpoint: ${state.openAiBaseUrl}`,
                  `Languages: ${state.languages.user} ⇄ ${state.languages.model}`,
                  `New threads: ${state.newThreadsDefault ? "translated" : "not translated"}`,
                ].join("\n"),
          };
        }
        case "on":
        case "off": {
          const threadId = args[0];
          if (threadId === undefined) break;
          setEnabled(threadId, command === "on");
          return { exitCode: 0, stdout: `Translation ${command} for ${threadId}` };
        }
        case "test": {
          const text = args.join(" ").trim();
          if (text === "") break;
          const started = Date.now();
          const output = await translate(text, "to-model", await defaultTranslator(), { threadId: ctx.threadId ?? null, projectId: ctx.projectId ?? null });
          return { exitCode: 0, stdout: json ? JSON.stringify({ output, ms: Date.now() - started }) : `${output}\n(${Date.now() - started} ms)` };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.onDispose(() => {
    nativeCalls.abort();
    for (const entry of syncs.values()) if (entry.timer !== null) clearTimeout(entry.timer);
    for (const worker of workers.values()) worker.reject(new Error("Translate Bridge stopped"));
  });
}
