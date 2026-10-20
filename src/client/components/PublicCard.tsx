import type { ReactNode } from "react";

export function PublicCard({ title, kicker, children }: { title: string; kicker?: string; children: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-panel)] bg-white p-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.6)] sm:p-8">
      <div className="mb-6 flex items-center gap-3">
        <img src="/favicon.svg" alt="" className="size-10 rounded-full" />
        <div>
          <div className="text-sm text-muted">{kicker ?? "Team Alpha"}</div>
          <h1 className="text-[32px] font-medium leading-none tracking-[-0.035em]">{title}</h1>
        </div>
      </div>
      {children}
    </div>
  );
}
