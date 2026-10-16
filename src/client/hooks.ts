import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
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
