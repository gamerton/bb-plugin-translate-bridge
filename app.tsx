// Translate Bridge — frontend entry.
//
// - a composer toggle (thread: this thread; new thread: threads you start)
//   with a translator picker that reuses bb's provider/model picker;
// - an app overlay that draws translations in place of chat messages;
// - a message action and palette commands to flip between translation and
//   original.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { ComposerTranslateAction } from "@/components/bridge/composer";
import { TranslationOverlay } from "@/components/bridge/overlay";
import { rpcHolder, viewStore } from "@/lib/client-store";

export default definePluginApp((app) => {
  app.composer.customize({
    id: "translate-toggle",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "translate", component: ComposerTranslateAction }],
  });

  app.slots.experimental_appOverlay({ id: "translations", component: TranslationOverlay });

  app.slots.messageAction({
    id: "toggle-original",
    title: "Перевод / оригинал",
    icon: "translate-bridge/languages",
    run: ({ message }) => viewStore.toggle(message.id),
  });

  app.commands.register({
    id: "toggle-thread",
    title: "Translate Bridge: включить или выключить перевод в этом треде",
    defaultShortcut: { key: "t", mod: true, alt: true },
    isAvailable: ({ threadId }) => threadId !== null,
    run: async ({ threadId }) => {
      const rpc = rpcHolder.current;
      if (threadId === null || rpc === null) return;
      const state = await rpc.call("state", { threadId });
      const next = await rpc.call("setEnabled", { threadId, enabled: !state.enabled });
      toast(next.enabled ? `Перевод включён · ${next.effectiveLabel}` : "Перевод выключен");
    },
  });

  app.commands.register({
    id: "toggle-originals",
    title: "Translate Bridge: показывать оригиналы сообщений вместо перевода",
    run: () => {
      viewStore.setShowAll(!viewStore.showAll);
      toast(viewStore.showAll ? "Показываю оригиналы" : "Показываю перевод");
    },
  });
});
