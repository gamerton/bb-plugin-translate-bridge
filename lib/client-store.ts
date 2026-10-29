// Frontend-only state shared by the overlay, message actions and commands,
// which mount in different React roots (or none).
import { useSyncExternalStore } from "react";
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";

const ORIGINALS_KEY = "translate-bridge:show-originals";

let version = 0;
const listeners = new Set<() => void>();
const flipped = new Set<string>();
let showAll = readShowAll();

function readShowAll(): boolean {
  try {
    return globalThis.localStorage?.getItem(ORIGINALS_KEY) === "1";
  } catch {
    return false;
  }
}

function emit(): void {
  version++;
  for (const listener of listeners) listener();
}

export const viewStore = {
  /** Whether a row shows the original instead of the translation. */
  showsOriginal(rowId: string): boolean {
    return showAll !== flipped.has(rowId);
  },
  toggle(rowId: string): void {
    if (flipped.has(rowId)) flipped.delete(rowId);
    else flipped.add(rowId);
    emit();
  },
  get showAll(): boolean {
    return showAll;
  },
  setShowAll(value: boolean): void {
    showAll = value;
    flipped.clear();
    try {
      globalThis.localStorage?.setItem(ORIGINALS_KEY, value ? "1" : "0");
    } catch {
      // Private mode: keep the choice for this window only.
    }
    emit();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Re-render when any row flips or the global switch changes. */
export function useViewStoreVersion(): number {
  return useSyncExternalStore(viewStore.subscribe, () => version, () => version);
}

/**
 * Palette commands run outside React and cannot call hooks; the always
 * mounted overlay parks its RPC client here.
 */
export const rpcHolder: { current: PluginRpcClient<typeof rpcContract> | null } = { current: null };

export function languageCode(language: string): string {
  const known: Record<string, string> = {
    russian: "RU", english: "EN", ukrainian: "UK", german: "DE", french: "FR", spanish: "ES",
    italian: "IT", portuguese: "PT", chinese: "ZH", japanese: "JA", korean: "KO", polish: "PL",
    turkish: "TR", kazakh: "KK", belarusian: "BE",
  };
  const name = language.trim().toLowerCase();
  return known[name] ?? (name.slice(0, 2).toUpperCase() || "??");
}

/** "English" → "английский" for Russian UI sentences; unknown names stay as typed. */
export function languageRu(language: string): string {
  const known: Record<string, string> = {
    russian: "русский", english: "английский", ukrainian: "украинский", german: "немецкий", french: "французский",
    spanish: "испанский", italian: "итальянский", portuguese: "португальский", chinese: "китайский", japanese: "японский",
    korean: "корейский", polish: "польский", turkish: "турецкий", kazakh: "казахский", belarusian: "белорусский",
  };
  return known[language.trim().toLowerCase()] ?? language;
}
