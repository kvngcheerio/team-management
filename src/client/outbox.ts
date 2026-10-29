import { useSyncExternalStore } from "react";
import { api, ApiError } from "./api";

/**
 * Offline queue for the actions that happen at the pitch with bad signal (check-in, live scoring,
 * attendance). Requests are kept in localStorage and sent in order once the network is back.
 * Every queued endpoint must be safe to send twice (client-supplied ids, upserts or absolute
 * values), because a request can reach the server even when its response is lost.
 */
export interface OutboxRequest {
  method: "POST" | "PATCH";
  path: string;
  body?: unknown;
  /** Match day whose cached detail the server response replaces. */
  dayId: string;
  /** Shown in the pending list and in failure messages, e.g. "Goal for Set A". */
  label: string;
  /** Statuses that mean the change is already applied (e.g. 404 when removing a goal that's gone). */
  doneStatuses?: number[];
}

export interface OutboxItem extends OutboxRequest {
  id: string;
  createdAt: number;
  attempts: number;
}

export interface OutboxFailure {
  id: string;
  dayId: string;
  label: string;
  message: string;
}

interface OutboxState {
  items: OutboxItem[];
  failures: OutboxFailure[];
  /** The session expired: items wait until the user signs in again. */
  needsSignIn: boolean;
}

const KEY = "matchday:outbox:v1";
const MAX_ATTEMPTS = 3;
const empty: OutboxState = { items: [], failures: [], needsSignIn: false };

let state: OutboxState = load();
const listeners = new Set<() => void>();

function load(): OutboxState {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty, ...(JSON.parse(raw) as OutboxState) } : empty;
  } catch {
    return empty;
  }
}

function set(next: Partial<OutboxState>) {
  state = { ...state, ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage full or blocked: the queue still works for this page load */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useOutbox() {
  return useSyncExternalStore(subscribe, () => state);
}

export function isOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Send now, or queue when offline. Requests also queue behind anything already waiting, so they reach
 * the server in the order they were made (a goal never arrives before the match it belongs to).
 */
export async function sendOrQueue<T>(req: OutboxRequest): Promise<{ queued: true } | { queued: false; data: T }> {
  if (!isOffline() && state.items.length === 0) {
    try {
      return { queued: false, data: await api.req<T>(req.method, req.path, req.body) };
    } catch (err) {
      // Status 0 = the request never got a response; it may or may not have arrived, and replays are safe.
      if (!(err instanceof ApiError) || err.status !== 0) throw err;
    }
  }
  set({ items: [...state.items, { ...req, id: crypto.randomUUID(), createdAt: Date.now(), attempts: 0 }] });
  scheduleFlush(0);
  return { queued: true };
}

type SentHandler = (item: OutboxItem, data: unknown) => void;
let onSent: SentHandler = () => {};
let onDrained: () => void = () => {};
let flushing = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let backoff = 5_000;

function scheduleFlush(delay: number) {
  clearTimeout(timer);
  timer = setTimeout(() => void flush(), delay);
}

/** Send queued requests in order. Stops at the first one that can't get through and retries later. */
export async function flush() {
  if (flushing || isOffline() || state.items.length === 0) return;
  flushing = true;
  let sentAny = false;
  try {
    while (state.items.length) {
      const item = state.items[0]!;
      const drop = () => set({ items: state.items.filter((i) => i.id !== item.id) });
      try {
        const data = await api.req(item.method, item.path, item.body);
        drop();
        sentAny = true;
        onSent(item, data);
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 0 || status === 408 || status === 429 || status >= 500) {
          scheduleFlush(backoff);
          backoff = Math.min(backoff * 2, 60_000);
          return;
        }
        if (status === 401) {
          set({ needsSignIn: true });
          return;
        }
        if (item.doneStatuses?.includes(status)) {
          drop();
          sentAny = true;
          onSent(item, null);
          continue;
        }
        // 409 can be a version clash with another admin's change: try again before giving up.
        if (status === 409 && item.attempts + 1 < MAX_ATTEMPTS) {
          set({ items: state.items.map((i) => (i.id === item.id ? { ...i, attempts: i.attempts + 1 } : i)) });
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        drop();
        set({ failures: [...state.failures, { id: item.id, dayId: item.dayId, label: item.label, message: (err as Error).message }] });
        onSent(item, null);
      }
    }
    backoff = 5_000;
  } finally {
    flushing = false;
    if (sentAny) onDrained();
  }
}

export function dismissFailures() {
  set({ failures: [] });
}

/** Wire the queue to the app: apply server responses, and flush on reconnect, focus and start-up. */
export function startOutbox(handlers: { onSent: SentHandler; onDrained: () => void }) {
  onSent = handlers.onSent;
  onDrained = handlers.onDrained;
  const kick = () => {
    backoff = 5_000;
    void flush();
  };
  window.addEventListener("online", kick);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && kick());
  kick();
}

/** After signing in again, resume sending what was queued. */
export function resumeOutbox() {
  if (!state.needsSignIn) return;
  set({ needsSignIn: false });
  void flush();
}

/** Signing out drops queued changes and cached data so the next person on this phone can't send or see them. */
export function clearOutbox() {
  set({ ...empty });
}
