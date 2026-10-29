import "@fontsource-variable/inter-tight";
import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { ApiError } from "./api";
import { router } from "./App";
import { ToastProvider } from "./components/ui";
import "./install";
import { persistQueryCache, restoreQueryCache } from "./offline-cache";
import { startOutbox } from "./outbox";
import type { MatchDayDetail } from "./types";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
      // Kept a day so the copy saved for offline use (offline-cache.ts) isn't dropped.
      gcTime: 24 * 3600_000,
    },
    // Run even when the browser says it's offline: queueable actions queue, others show the offline error
    // (the default would leave the button spinning until the network comes back).
    mutations: { networkMode: "always" },
  },
});

restoreQueryCache(queryClient);
persistQueryCache(queryClient);
startOutbox({
  onSent: (item, data) => {
    const detail = data as MatchDayDetail | null;
    if (detail?.day?.id === item.dayId) queryClient.setQueryData(["matchday", item.dayId], detail);
    else void queryClient.invalidateQueries({ queryKey: ["matchday", item.dayId] });
  },
  onDrained: () => {
    for (const key of ["dashboard", "matchdays", "standings", "admin-fines"]) void queryClient.invalidateQueries({ queryKey: [key] });
  },
});

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
