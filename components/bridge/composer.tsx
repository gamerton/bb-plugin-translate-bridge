// The composer toggle and the translator picker dialog.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useComposer,
  useRealtime,
  useRpc,
  type ExperimentalProviderModelPickerValue,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { BridgeState, rpcContract, Translator } from "../../server";
import { languageCode, languageRu, useViewStoreVersion, viewStore } from "../../lib/client-store";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { cn } from "../../lib/utils";

const STATE_CHANGED = "state-changed";

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useBridgeState(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<BridgeState | null>(null);
  const refetch = useCallback(() => {
    rpc.call("state", { threadId }).then(setState, () => {});
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);
  useRealtime(STATE_CHANGED, (payload) => {
    const changed = (payload as { threadId?: unknown } | null)?.threadId;
    if (changed === null || changed === threadId) refetch();
  });
  return { rpc, state, setState, refetch };
}

function pairLabel(state: BridgeState): string {
  return `${languageCode(state.languages.user)}→${languageCode(state.languages.model)}`;
}

const iconButton =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Composer action: on/off for this thread (or for new threads) plus the picker. */
export function ComposerTranslateAction() {
  const composer = useComposer();
  const scope = composer.scope;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const projectId = scope.kind === "new-thread" ? scope.projectId : null;
  const { rpc, state, setState, refetch } = useBridgeState(threadId);
  const [open, setOpen] = useState(false);
  if (state === null || scope.kind === "queued-message") return null;
  const enabled = threadId === null ? state.newThreadsDefault : state.enabled;

  const toggle = async () => {
    try {
      if (threadId === null) {
        await rpc.call("setNewThreadsDefault", { enabled: !enabled });
        refetch();
      } else {
        setState(await rpc.call("setEnabled", { threadId, enabled: !enabled }));
      }
    } catch (cause) {
      toast.error("Не удалось переключить перевод", { description: message(cause) });
    }
  };

  const title = threadId === null
    ? `${enabled ? "Новые треды переводятся" : "Новые треды не переводятся"} (${pairLabel(state)}). Переводчик: ${state.effectiveLabel}`
    : `${enabled ? "Перевод включён" : "Перевод выключен"}: вы пишете на языке «${languageRu(state.languages.user)}», модель работает на языке «${languageRu(state.languages.model)}». Переводчик: ${state.effectiveLabel}`;

  return (
    <div className="flex items-center">
      <button
        type="button"
        className={cn(iconButton, enabled && "bg-state-active text-foreground")}
        aria-pressed={enabled}
        aria-label={title}
        title={title}
        onClick={() => void toggle()}
      >
        <Icon name="translate-bridge/languages" className="size-4" />
        {enabled ? <span className="tabular-nums">{pairLabel(state)}</span> : null}
      </button>
      <button
        type="button"
        className={cn(iconButton, "w-5 px-0")}
        aria-label="Выбрать модель-переводчик"
        title="Выбрать модель-переводчик"
        onClick={() => setOpen(true)}
      >
        <Icon name="ChevronDown" className="size-3" />
      </button>
      {open ? (
        <TranslatorDialog
          open={open}
          onOpenChange={setOpen}
          state={state}
          threadId={threadId}
          projectId={projectId}
          composer={composer}
          onSaved={setState}
        />
      ) : null}
    </div>
  );
}

function seedPicker(translator: Translator, composer: PluginComposerApi | null): ExperimentalProviderModelPickerValue {
  if (translator.engine === "bb") {
    return {
      providerId: translator.providerId,
      model: translator.model,
      reasoningLevel: translator.reasoningLevel as ExperimentalProviderModelPickerValue["reasoningLevel"],
    };
  }
  const selection = composer?.selection;
  return {
    providerId: selection?.providerId ?? "claude-code",
    model: selection?.model ?? "",
    reasoningLevel: selection?.reasoningLevel ?? ("low" as ExperimentalProviderModelPickerValue["reasoningLevel"]),
  };
}

const SAMPLE = "Привет! Посмотри, пожалуйста, почему `parseConfig()` падает на пустом файле, и предложи исправление.";

export function TranslatorDialog({
  open,
  onOpenChange,
  state,
  threadId,
  projectId,
  composer,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: BridgeState;
  threadId: string | null;
  projectId: string | null;
  composer: PluginComposerApi | null;
  onSaved: (state: BridgeState) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  useViewStoreVersion();
  const initial = state.effectiveTranslator;
  const [target, setTarget] = useState<"thread" | "default">(threadId !== null ? "thread" : "default");
  const [engine, setEngine] = useState<Translator["engine"]>(initial.engine);
  const [picker, setPicker] = useState(() => seedPicker(initial, composer));
  const [openAiModel, setOpenAiModel] = useState(initial.engine === "openai" ? initial.model : "");
  const [models, setModels] = useState<{ models: string[]; error: string | null } | null>(null);
  const [sample, setSample] = useState(SAMPLE);
  const [result, setResult] = useState<{ output: string; ms: number } | { error: string } | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);

  useEffect(() => {
    if (engine !== "openai" || models !== null) return;
    rpc.call("openAiModels").then(setModels, (cause) => setModels({ models: [], error: message(cause) }));
  }, [engine, models, rpc]);

  const translator = useMemo<Translator>(() =>
    engine === "openai"
      ? { engine: "openai", model: openAiModel.trim() }
      : { engine: "bb", providerId: picker.providerId, model: picker.model, reasoningLevel: picker.reasoningLevel ?? "" },
  [engine, openAiModel, picker]);
  const valid = translator.engine === "openai" || translator.model !== "";

  const save = async (clear = false) => {
    setBusy("save");
    try {
      const next = await rpc.call("setTranslator", {
        threadId: target === "thread" ? threadId : null,
        translator: clear ? null : translator,
      });
      onSaved(target === "thread" || threadId === null ? next : await rpc.call("state", { threadId }));
      toast.success(clear ? "Тред снова использует переводчик по умолчанию" : "Переводчик сохранён");
      onOpenChange(false);
    } catch (cause) {
      toast.error("Не удалось сохранить переводчик", { description: message(cause) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setResult(null);
    try {
      setResult(await rpc.call("test", { translator, text: sample, direction: "to-model", threadId, projectId }));
    } catch (cause) {
      setResult({ error: message(cause) });
    } finally {
      setBusy(null);
    }
  };

  const segment = (value: Translator["engine"], label: string) => (
    <button
      type="button"
      aria-pressed={engine === value}
      onClick={() => setEngine(value)}
      className={cn(
        "flex-1 cursor-pointer rounded-md px-3 py-1.5 text-sm transition-colors",
        engine === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Модель-переводчик</DialogTitle>
          <DialogDescription>
            Переводит ваши сообщения на {languageRu(state.languages.model)}, а ответы — обратно на {languageRu(state.languages.user)}. Основная модель
            работает только с переводом. Сменить переводчик можно в любой момент диалога.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {threadId !== null ? (
            <div className="flex gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Где применить">
              <button
                type="button"
                aria-pressed={target === "thread"}
                onClick={() => setTarget("thread")}
                className={cn("flex-1 cursor-pointer rounded-md px-3 py-1.5 text-sm", target === "thread" ? "bg-background shadow-sm" : "text-muted-foreground")}
              >
                Этот тред
              </button>
              <button
                type="button"
                aria-pressed={target === "default"}
                onClick={() => setTarget("default")}
                className={cn("flex-1 cursor-pointer rounded-md px-3 py-1.5 text-sm", target === "default" ? "bg-background shadow-sm" : "text-muted-foreground")}
              >
                По умолчанию
              </button>
            </div>
          ) : null}

          <div className="flex gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Источник модели">
            {segment("openai", "Локальный / API")}
            {segment("bb", "Модель bb")}
          </div>

          {engine === "bb" ? (
            <div className="space-y-2">
              <ProviderModelPicker value={picker} onChange={setPicker} />
              <p className="text-xs text-muted-foreground">
                Тот же каталог, что и у основной модели. Каждый перевод идёт через короткий скрытый тред — подходит любая модель
                bb, но это медленнее прямого API.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                OpenAI-совместимый сервер: <code>{state.openAiBaseUrl}</code>. Адрес и
                ключ меняются в настройках плагина.
              </p>
              {models === null ? (
                <p className="text-xs text-muted-foreground">Загружаю список моделей…</p>
              ) : models.error !== null ? (
                <p className="text-xs text-destructive">Сервер не ответил: {models.error}</p>
              ) : null}
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  aria-pressed={openAiModel === ""}
                  onClick={() => setOpenAiModel("")}
                  className={cn("cursor-pointer rounded-full border px-2.5 py-1 text-xs", openAiModel === "" ? "border-foreground text-foreground" : "border-border text-muted-foreground")}
                >
                  Модель сервера по умолчанию
                </button>
                {models?.models.map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={openAiModel === id}
                    onClick={() => setOpenAiModel(id)}
                    className={cn("max-w-full cursor-pointer truncate rounded-full border px-2.5 py-1 text-xs", openAiModel === id ? "border-foreground text-foreground" : "border-border text-muted-foreground")}
                  >
                    {id}
                  </button>
                ))}
              </div>
              <Input value={openAiModel} onChange={(event) => setOpenAiModel(event.target.value)} placeholder="или имя модели вручную" aria-label="Модель" />
            </div>
          )}

          <div className="space-y-2 rounded-lg border border-border p-3">
            <div className="text-xs font-medium">Проверка</div>
            <Input value={sample} onChange={(event) => setSample(event.target.value)} aria-label="Текст для проверки" />
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy !== null || !valid || sample.trim() === ""} onClick={() => void test()}>
                {busy === "test" ? <Icon name="Spinner" className="size-3 animate-spin" /> : <Icon name="Play" className="size-3" />}
                Перевести
              </Button>
              {result !== null && "ms" in result ? <span className="text-xs text-muted-foreground">{(result.ms / 1000).toFixed(1)} с</span> : null}
            </div>
            {result !== null ? (
              "error" in result ? (
                <p className="text-xs text-destructive">{result.error}</p>
              ) : (
                <p className="whitespace-pre-wrap text-sm">{result.output}</p>
              )
            ) : null}
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={viewStore.showAll} onCheckedChange={(checked) => viewStore.setShowAll(checked === true)} />
            Показывать в чате оригиналы вместо перевода
          </label>
        </div>

        <DialogFooter className="gap-2">
          {threadId !== null && target === "thread" && state.threadTranslator !== null ? (
            <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => void save(true)}>
              Как по умолчанию
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button type="button" disabled={busy !== null || !valid} onClick={() => void save()}>
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
