import type { ReactNode } from "react";

export function PublicCard({ title, kicker, children }: { title: string; kicker?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-6 flex items-center gap-3 text-white">
        <img src="/favicon.svg" alt="" className="size-11 rounded-xl ring-1 ring-white/25" />
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-pitch-200">{kicker ?? "Matchday"}</div>
          <h1 className="display text-4xl font-bold uppercase leading-none">{title}</h1>
        </div>
      </div>
      <div className="rounded-2xl bg-white p-5 shadow-xl sm:p-6">{children}</div>
    </div>
  );
}
