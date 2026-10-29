import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractTranslation,
  hashText,
  needsTranslation,
  protectCode,
  protectMentions,
  restore,
  restoreMentions,
  splitChunks,
  translateMarkdown,
} from "../lib/translation.ts";

const languages = { user: "Russian", model: "English" };

test("code fences are swapped out and restored verbatim", () => {
  const source = "Смотри:\n\n```ts\nconst x = 1; // не трогать\n```\n\nи ещё\n~~~\nraw\n~~~\n";
  const guarded = protectCode(source);
  assert.equal(guarded.slots.size, 2);
  assert.ok(!guarded.text.includes("не трогать"));
  assert.equal(restore(guarded.text, guarded.slots), source);
});

test("mentions survive translation and get new ranges", () => {
  const text = "Посмотри @server.ts и @app.tsx пожалуйста";
  const mentions = [
    { start: 9, end: 19, resource: "a" },
    { start: 22, end: 30, resource: "b" },
  ];
  assert.equal(text.slice(9, 19), "@server.ts");
  const guarded = protectMentions(text, mentions);
  assert.equal(guarded.text, "Посмотри ⟦M1⟧ и ⟦M2⟧ пожалуйста");
  const restored = restoreMentions("Please look at ⟦M1⟧ and ⟦M2⟧", text, guarded.mentions);
  assert.equal(restored.text, "Please look at @server.ts and @app.tsx");
  for (const mention of restored.mentions) {
    assert.equal(restored.text.slice(mention.start, mention.end), text.slice(
      mentions.find((m) => m.resource === mention.resource)!.start,
      mentions.find((m) => m.resource === mention.resource)!.end,
    ));
  }
});

test("a mention the translator dropped is appended", () => {
  const text = "Глянь @a.ts";
  const guarded = protectMentions(text, [{ start: 6, end: 11 }]);
  const restored = restoreMentions("Take a look", text, guarded.mentions);
  assert.equal(restored.text, "Take a look @a.ts");
  assert.equal(restored.text.slice(restored.mentions[0]!.start, restored.mentions[0]!.end), "@a.ts");
});

test("language detection skips text that needs no translation", () => {
  assert.equal(needsTranslation("Привет, мир", "to-model", languages), true);
  assert.equal(needsTranslation("fix the bug in `парсер`", "to-model", languages), false);
  assert.equal(needsTranslation("```\nкод\n```", "to-model", languages), false);
  assert.equal(needsTranslation("Done. All tests pass.", "to-user", languages), true);
  assert.equal(needsTranslation("Готово, всё работает: `npm test` ok", "to-user", languages), false);
  assert.equal(needsTranslation("12345 !!!", "to-user", languages), false);
  assert.equal(needsTranslation("Hallo Welt", "to-model", { user: "German", model: "English" }), true);
});

test("model replies are unwrapped", () => {
  assert.equal(extractTranslation("<think>hmm</think>\n<translation>\nHello\n</translation>"), "Hello");
  assert.equal(extractTranslation("Sure! <translation>Hi there</translation> hope it helps"), "Hi there");
  assert.equal(extractTranslation("Just text"), "Just text");
  assert.equal(extractTranslation("<translation>Unclosed"), "Unclosed");
});

test("long text splits on paragraphs and never loses characters", () => {
  const text = Array.from({ length: 30 }, (_, i) => `Абзац ${i} `.repeat(20)).join("\n\n");
  const chunks = splitChunks(text, 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
  assert.equal(chunks.join(""), text);
});

test("translateMarkdown keeps code out of the prompt and restores it", async () => {
  const source = "Вот исправление:\n\n```js\nconsole.log('привет')\n```\n\nПроверь его.";
  const prompts: string[] = [];
  const result = await translateMarkdown(source, "to-model", languages, async (_system, user) => {
    prompts.push(user);
    return "<translation>Here is the fix:\n\n⟦C1⟧\n\nCheck it.</translation>";
  });
  assert.equal(prompts.length, 1);
  assert.ok(!prompts[0]!.includes("console.log"));
  assert.equal(result, "Here is the fix:\n\n```js\nconsole.log('привет')\n```\n\nCheck it.");
});

test("translateMarkdown appends a code block the translator dropped", async () => {
  const source = "Код:\n\n```\nx\n```";
  const result = await translateMarkdown(source, "to-model", languages, async () => "<translation>Code:</translation>");
  assert.equal(result, "Code:\n\n```\nx\n```");
});

test("hash changes with the text", () => {
  assert.equal(hashText("a"), hashText("a"));
  assert.notEqual(hashText("a"), hashText("b"));
});

test("an echoed source is retried with a reminder", async () => {
  const replies = ["<translation>Привет, мир</translation>", "<translation>Hello, world</translation>"];
  const prompts: string[] = [];
  const result = await translateMarkdown("Привет, мир", "to-model", languages, async (_system, user) => {
    prompts.push(user);
    return replies.shift()!;
  });
  assert.equal(result, "Hello, world");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /not a English translation/u);
});

test("a message the translator keeps echoing is refused, a reply is kept", async () => {
  await assert.rejects(
    translateMarkdown("Привет, мир", "to-model", languages, async () => "<translation>Привет, мир</translation>"),
    /did not translate/u,
  );
  assert.equal(await translateMarkdown("OK", "to-user", languages, async () => "OK"), "OK");
});
