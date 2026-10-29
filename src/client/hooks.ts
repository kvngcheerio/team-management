import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { sendOrQueue, type OutboxRequest } from "./outbox";
import { useToast } from "./components/ui";
import type { MatchDayDetail, Me } from "./types";

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me"), staleTime: 60_000 });
}

export function useIsAdmin() {
  return useMe().data?.user?.role === "admin";
}

export function useMatchDay(id: string | undefined) {
  return useQuery({ queryKey: ["matchday", id], queryFn: () => api.get<MatchDayDetail>(`/matchdays/${id}`), enabled: Boolean(id) });
}

/**
 * Mutation that returns a fresh match-day detail; the cache is updated in place so the screen
 * reflects server truth immediately.
 */
export function useDayMutation<V>(dayId: string, fn: (vars: V) => Promise<MatchDayDetail>, successMessage?: string | ((d: MatchDayDetail) => string)) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.setQueryData(["matchday", dayId], data);
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["matchdays"] });
      qc.invalidateQueries({ queryKey: ["standings"] });
      if (successMessage) toast(typeof successMessage === "function" ? successMessage(data) : successMessage);
    },
    onError: (err: Error) => toast(err.message, "error"),
  });
}

export const QUEUED_MESSAGE = "Saved on this phone — it will send when you're back online";

/**
 * A day mutation that can be made offline (see outbox.ts). `build` creates the request once, so ids in it
 * stay the same when it's replayed; `apply` shows the change on the cached day while it waits to send.
 */
export function useQueuedDayMutation<V>(
  dayId: string,
  build: (vars: V) => Omit<OutboxRequest, "dayId"> & { apply?: (d: MatchDayDetail) => MatchDayDetail },
  successMessage?: string | ((d: MatchDayDetail) => string),
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (vars: V) => {
      const { apply, ...req } = build(vars);
      const res = await sendOrQueue<MatchDayDetail>({ ...req, dayId });
      if (!res.queued) return res.data;
      if (apply) qc.setQueryData<MatchDayDetail>(["matchday", dayId], (d) => d && apply(d));
      return null;
    },
    onSuccess: (data) => {
      if (!data) return toast(QUEUED_MESSAGE);
      qc.setQueryData(["matchday", dayId], data);
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["matchdays"] });
      qc.invalidateQueries({ queryKey: ["standings"] });
      if (successMessage) toast(typeof successMessage === "function" ? successMessage(data) : successMessage);
    },
    onError: (err: Error) => toast(err.message, "error"),
  });
}
