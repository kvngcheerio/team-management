import { dehydrate, hydrate, type DehydratedState, type QueryClient } from "@tanstack/react-query";

/** Last-seen API data kept in localStorage so pages open with something to show when there's no signal. */
const KEY = "matchday:query-cache:v1";
const MAX_AGE_MS = 7 * 24 * 3600_000;

export function restoreQueryCache(qc: QueryClient) {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as { savedAt: number; state: DehydratedState };
    if (Date.now() - saved.savedAt < MAX_AGE_MS) hydrate(qc, saved.state);
    else localStorage.removeItem(KEY);
  } catch {
    /* corrupt or blocked storage: start empty */
  }
}

export function persistQueryCache(qc: QueryClient) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    try {
      // Only signed-in data is worth keeping; a saved "signed out" answer would only get in the way.
      const signedIn = Boolean((qc.getQueryData(["me"]) as { user?: unknown } | undefined)?.user);
      const state = dehydrate(qc, { shouldDehydrateQuery: (q) => signedIn && q.state.status === "success" });
      localStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), state }));
    } catch {
      /* quota exceeded: keep the previous copy */
    }
  };
  qc.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" && event.type !== "removed") return;
    clearTimeout(timer);
    timer = setTimeout(save, 1000);
  });
  window.addEventListener("pagehide", save);
}

export function clearQueryCache() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
