// Draws translations in place of the original messages in every timeline on
// screen. bb has no slot that replaces a message body, so this finds message
// rows by bb's `data-timeline-row-id` attribute, mounts a portal host next to
// the original body and hides the original while the translation shows.
// Everything degrades to bb's own rendering: if the DOM shape changes, the
// original English stays visible and nothing breaks.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Markdown,
  experimental_Icon as Icon,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, ViewRow } from "../../server";
import { rpcHolder, useViewStoreVersion, viewStore } from "../../lib/client-store";

const VIEW_CHANGED = "view-changed";
const HOST_ATTRIBUTE = "data-tb-host";
const HIDDEN_ATTRIBUTE = "data-tb-hidden";
const STYLE_ID = "translate-bridge-style";

interface Mounted {
  key: string;
  rowId: string;
  threadId: string;
  row: ViewRow;
  host: HTMLElement;
  target: HTMLElement;
}

function threadIdOf(rowId: string): string | null {
  const index = rowId.indexOf(":");
  if (index <= 0) return null;
  const threadId = rowId.slice(0, index);
  return threadId.startsWith("thr_") ? threadId : null;
}

function firstOwnChild(element: Element | null): HTMLElement | null {
  if (element === null) return null;
  for (const child of element.children) {
    if (!(child instanceof HTMLElement) || child.hasAttribute(HOST_ATTRIBUTE)) continue;
    return child;
  }
  return null;
}

/**
 * The element holding the message text: the prose block of an assistant
 * message, or the bubble of a person's message.
 */
function findTarget(column: HTMLElement, role: ViewRow["role"]): HTMLElement | null {
  if (role === "assistant") return firstOwnChild(column);
  return firstOwnChild(firstOwnChild(column));
}

function insideHost(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(`[${HOST_ATTRIBUTE}]`) != null;
}

function sameMounted(a: readonly Mounted[], b: readonly Mounted[]): boolean {
  return a.length === b.length && a.every((entry, index) => {
    const other = b[index]!;
    return entry.key === other.key && entry.host === other.host && entry.target === other.target && entry.row === other.row;
  });
}

export function TranslationOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  rpcHolder.current = rpc;
  const [views, setViews] = useState<ReadonlyMap<string, ReadonlyMap<string, ViewRow>>>(() => new Map());
  const [mounted, setMounted] = useState<readonly Mounted[]>([]);
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const requested = useRef(new Set<string>());
  const hosts = useRef(new Map<string, HTMLElement>());
  const frame = useRef<number | null>(null);

  const fetchView = useCallback((threadId: string) => {
    rpc.call("view", { threadId }).then(
      (result) => {
        setViews((previous) => {
          const next = new Map(previous);
          next.set(threadId, new Map(result.rows.map((row) => [row.rowId, row])));
          return next;
        });
      },
      () => {},
    );
  }, [rpc]);

  const scan = useCallback(() => {
    frame.current = null;
    const found: Mounted[] = [];
    const occurrences = new Map<string, number>();
    for (const element of document.querySelectorAll<HTMLElement>("[data-timeline-row-id]")) {
      const rowId = element.dataset.timelineRowId;
      if (!rowId) continue;
      const threadId = threadIdOf(rowId);
      if (threadId === null) continue;
      if (!requested.current.has(threadId)) {
        requested.current.add(threadId);
        fetchView(threadId);
      }
      const row = viewsRef.current.get(threadId)?.get(rowId);
      if (row === undefined || row.status === "skipped") continue;
      const column = element.querySelector<HTMLElement>("[data-message-column]");
      if (column === null) continue;
      const target = findTarget(column, row.role);
      if (target === null) continue;
      // The same thread can be open in two panes.
      const occurrence = occurrences.get(rowId) ?? 0;
      occurrences.set(rowId, occurrence + 1);
      const key = `${rowId}#${occurrence}`;
      let host = hosts.current.get(key);
      if (host === undefined || !host.isConnected || host.nextElementSibling !== target) {
        host?.remove();
        host = document.createElement("div");
        host.setAttribute(HOST_ATTRIBUTE, "");
        host.dataset.tbRole = row.role;
        target.before(host);
        hosts.current.set(key, host);
      }
      found.push({ key, rowId, threadId, row, host, target });
    }
    const live = new Set(found.map((entry) => entry.key));
    for (const [key, host] of hosts.current) {
      if (live.has(key)) continue;
      host.remove();
      hosts.current.delete(key);
    }
    setMounted((previous) => (sameMounted(previous, found) ? previous : found));
  }, [fetchView]);

  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(scan);
  }, [scan]);

  useEffect(() => {
    if (document.getElementById(STYLE_ID) === null) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `[${HIDDEN_ATTRIBUTE}]{display:none!important}[${HOST_ATTRIBUTE}][data-tb-role="user"]{display:flex;flex-direction:column;align-items:flex-end;max-width:100%}`;
      document.head.append(style);
    }
    const observer = new MutationObserver((records) => {
      if (records.every((record) => insideHost(record.target))) return;
      schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();
    return () => {
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      for (const host of hosts.current.values()) host.remove();
      hosts.current.clear();
      document.getElementById(STYLE_ID)?.remove();
      for (const element of document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}]`)) element.removeAttribute(HIDDEN_ATTRIBUTE);
      if (rpcHolder.current === rpc) rpcHolder.current = null;
    };
  }, [schedule, rpc]);

  useEffect(schedule, [views, schedule]);

  useRealtime(VIEW_CHANGED, (payload) => {
    const threadId = (payload as { threadId?: unknown } | null)?.threadId;
    if (typeof threadId === "string" && requested.current.has(threadId)) fetchView(threadId);
  });
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection !== "connected") return;
    for (const threadId of requested.current) fetchView(threadId);
  }, [connection, fetchView]);

  return (
    <>
      {mounted.map((entry) => (
        <RowPortal
          key={entry.key}
          entry={entry}
          onRetry={() => void rpc.call("retranslate", { threadId: entry.threadId, rowId: entry.rowId }).catch(() => {})}
        />
      ))}
    </>
  );
}

function RowPortal({ entry, onRetry }: { entry: Mounted; onRetry: () => void }) {
  useViewStoreVersion();
  const { row, target } = entry;
  const ready = row.status === "done" && row.text !== null;
  const showTranslation = ready && !viewStore.showsOriginal(entry.rowId);

  useLayoutEffect(() => {
    if (showTranslation) target.setAttribute(HIDDEN_ATTRIBUTE, "");
    else target.removeAttribute(HIDDEN_ATTRIBUTE);
    return () => target.removeAttribute(HIDDEN_ATTRIBUTE);
  }, [target, showTranslation]);

  return createPortal(
    <RowView row={row} showTranslation={showTranslation} bubbleClassName={target.className} onToggle={() => viewStore.toggle(entry.rowId)} onRetry={onRetry} />,
    entry.host,
  );
}

const linkClass = "inline-flex cursor-pointer items-center gap-1 rounded px-1 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground";

function RowView({
  row,
  showTranslation,
  bubbleClassName,
  onToggle,
  onRetry,
}: {
  row: ViewRow;
  showTranslation: boolean;
  bubbleClassName: string;
  onToggle: () => void;
  onRetry: () => void;
}) {
  const isUser = row.role === "user";
  const align = isUser ? "justify-end" : "justify-start";
  if (row.status === "pending") {
    return (
      <div className={`mb-1 flex ${align}`}>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" role="status">
          <Icon name="Spinner" className="size-3 animate-spin" />
          Перевожу…
        </span>
      </div>
    );
  }
  if (row.status === "error" || row.text === null) {
    return (
      <div className={`mb-1 flex ${align}`}>
        <button type="button" className={linkClass} title={row.error ?? undefined} onClick={onRetry}>
          <Icon name="AlertTriangle" className="size-3" />
          Перевод не удался — повторить
        </button>
      </div>
    );
  }
  if (!showTranslation) {
    return (
      <div className={`mb-1 flex ${align}`}>
        <button type="button" className={linkClass} onClick={onToggle} title={isUser ? "Это текст, который получила модель" : "Это исходный ответ модели"}>
          <Icon name="translate-bridge/languages" className="size-3" />
          {isUser ? "Отправлено модели · показать ваш текст" : "Оригинал · показать перевод"}
        </button>
      </div>
    );
  }
  return (
    <>
      {isUser ? (
        <div className={bubbleClassName}>
          <div className="whitespace-pre-wrap break-words">{row.text}</div>
        </div>
      ) : (
        <div className={bubbleClassName}>
          <Markdown content={row.text} />
        </div>
      )}
      <div className={`mt-0.5 flex ${align}`}>
        <button type="button" className={linkClass} onClick={onToggle} title={isUser ? "Показать текст, который получила модель" : "Показать исходный ответ модели"}>
          <Icon name="translate-bridge/languages" className="size-3" />
          {isUser ? "Показать, что ушло модели" : "Показать оригинал"}
        </button>
      </div>
    </>
  );
}
