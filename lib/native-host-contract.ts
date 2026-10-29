import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const nativeHostContract = defineRpcContract({
  complete: {
    input: z.object({
      engine: z.enum(["claude", "codex", "opencode"]).default("claude"),
      model: z.string().min(1).max(300),
      reasoningLevel: z.string().max(40),
      system: z.string().max(16_000),
      user: z.string().max(100_000),
      cwd: z.string().min(1).max(16_000),
      timeoutMs: z.number().int().min(1000).max(1_800_000),
    }).strict(),
    output: z.object({ text: z.string().max(2 * 1024 * 1024) }).strict(),
  },
});
