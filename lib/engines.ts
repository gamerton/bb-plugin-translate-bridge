// Translator engines. A translator is either an OpenAI-compatible endpoint
// (llama.cpp, Ollama, LM Studio, vLLM, OpenRouter, OpenAI…) or any bb agent
// provider and model, run in a short-lived hidden worker thread — the same
// catalog the main model picker shows.
import { z } from "zod";

export const translatorSchema = z.discriminatedUnion("engine", [
  z.object({
    engine: z.literal("openai"),
    /** Empty means the endpoint's default model (llama.cpp serves one). */
    model: z.string().max(300),
  }).strict(),
  z.object({
    engine: z.literal("bb"),
    providerId: z.string().min(1).max(120),
    model: z.string().min(1).max(300),
    reasoningLevel: z.string().max(40),
  }).strict(),
]);
export type Translator = z.infer<typeof translatorSchema>;

export interface OpenAiEndpoint {
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs: number;
}

function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${path}`;
}

function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function headers(endpoint: OpenAiEndpoint): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
  };
}

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function openAiComplete(
  endpoint: OpenAiEndpoint,
  model: string,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const body: Record<string, unknown> = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    stream: false,
  };
  if (model.trim() !== "") body.model = model.trim();
  // Local reasoning models (Qwen3 and friends) would otherwise spend the
  // budget thinking; hosted APIs reject unknown fields, so only send it to
  // a server on this machine.
  if (isLoopback(endpoint.baseUrl)) body.chat_template_kwargs = { enable_thinking: false };
  const response = await fetch(endpointUrl(endpoint.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: headers(endpoint),
    body: JSON.stringify(body),
    signal: withTimeout(endpoint.timeoutMs, signal),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Translator endpoint answered ${response.status}: ${raw.slice(0, 300)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Translator endpoint returned non-JSON: ${raw.slice(0, 200)}`);
  }
  const content = (parsed as { choices?: { message?: { content?: unknown } }[] })
    .choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Translator endpoint returned no message content");
  return content;
}

export async function openAiModels(endpoint: OpenAiEndpoint): Promise<string[]> {
  const response = await fetch(endpointUrl(endpoint.baseUrl, "/models"), {
    headers: headers(endpoint),
    signal: AbortSignal.timeout(Math.min(endpoint.timeoutMs, 10_000)),
  });
  if (!response.ok) throw new Error(`GET /models answered ${response.status}`);
  const body = (await response.json()) as { data?: { id?: unknown }[]; models?: { name?: unknown; model?: unknown }[] };
  const ids = new Set<string>();
  for (const entry of body.data ?? []) if (typeof entry.id === "string") ids.add(entry.id);
  for (const entry of body.models ?? []) {
    const id = typeof entry.model === "string" ? entry.model : entry.name;
    if (typeof id === "string") ids.add(id);
  }
  return [...ids].sort();
}

export function describeTranslator(translator: Translator): string {
  if (translator.engine === "openai") {
    return translator.model.trim() === "" ? "OpenAI-compatible (default model)" : translator.model;
  }
  return `${translator.providerId} · ${translator.model}`;
}
