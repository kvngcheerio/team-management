import { createContext, useCallback, useContext, useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { Link } from "react-router";
import { ApiError } from "../api";
import { STATUS_LABEL } from "../format";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "gold";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-pitch-700 text-white hover:bg-pitch-800 active:bg-pitch-900",
  secondary: "bg-white text-pitch-800 border border-pitch-700/40 hover:border-pitch-700 hover:bg-pitch-50",
  ghost: "text-pitch-800 hover:bg-pitch-50",
  danger: "bg-white text-ember border border-ember/40 hover:bg-red-50",
  gold: "bg-ember text-white hover:brightness-95",
};

export function Button({
  variant = "primary",
  size = "md",
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-full font-medium transition select-none disabled:opacity-50 disabled:cursor-not-allowed",
        size === "sm" && "min-h-9 px-3.5 text-sm",
        size === "md" && "min-h-11 px-5 text-[15px]",
        size === "lg" && "min-h-14 px-7 text-[17px]",
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

export function Spinner({ className = "size-5" }: { className?: string }) {
  return <span role="status" aria-label="Loading" className={cx("inline-block animate-spin rounded-full border-2 border-current border-r-transparent", className)} />;
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx("rounded-[22px] bg-white border border-line", className)}>
      {children}
    </div>
  );
}

export function SectionTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-end justify-between gap-3 mb-3", className)}>
      <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em] text-ink">{children}</h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, kicker, action }: { title: ReactNode; kicker?: ReactNode; action?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        {kicker && <div className="mb-1 text-sm text-muted">{kicker}</div>}
        <h1 className="text-[38px] font-medium leading-[1.02] tracking-[-0.035em] text-ink sm:text-5xl">{title}</h1>
      </div>
      {action}
    </header>
  );
}

const BADGE: Record<string, string> = {
  green: "bg-pitch-100 text-pitch-800",
  gray: "bg-stone-100 text-stone-700",
  amber: "bg-amber-100 text-amber-900",
  red: "bg-red-100 text-red-800",
  blue: "bg-sky-100 text-sky-900",
  gold: "bg-gold-soft text-[#7a5a05]",
  dark: "bg-ink text-white",
};
export function Badge({ children, tone = "gray", className }: { children: ReactNode; tone?: keyof typeof BADGE; className?: string }) {
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap", BADGE[tone], className)}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const tone = ({ draft: "gray", checkin_open: "green", locked: "amber", in_progress: "blue", finalized: "dark", cancelled: "red" } as const)[status as "draft"] ?? "gray";
  return <Badge tone={tone}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export function GuestBadge() {
  return <Badge tone="amber">Guest</Badge>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-muted">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-muted">{hint}</span>}
      {error && <span className="mt-1 block text-sm font-medium text-red-700">{error}</span>}
    </label>
  );
}

const inputCls = "w-full min-h-12 rounded-2xl border border-line bg-white px-4 text-base text-ink placeholder:text-stone-400 focus:border-pitch-700 focus:outline-none focus:ring-2 focus:ring-pitch-100";
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputCls, props.className)} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputCls, "pr-8", props.className)} />;
}

export function ErrorBox({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof ApiError && Array.isArray(error.details) ? (error.details as { message?: string }[]) : [];
  return (
    <div role="alert" className={cx("rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800", className)}>
      <p className="font-semibold">{message}</p>
      {details.length > 0 && details[0]?.message && (
        <ul className="mt-1.5 list-disc pl-5">
          {details.map((d, i) => (
            <li key={i}>{d.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-[22px] border border-dashed border-line bg-chalk px-5 py-10 text-center">
      <div className="mx-auto mb-3 grid size-12 place-items-center rounded-full bg-white text-2xl ring-1 ring-line" aria-hidden>
        ⚽
      </div>
      <p className="text-xl font-medium tracking-tight text-ink">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-sm text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-muted">
      <Spinner /> <span>{label}</span>
    </div>
  );
}

export function SetChip({ name, color, className }: { name: string; color: string; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 font-semibold", className)}>
      <span className="size-3 shrink-0 rounded-full ring-1 ring-black/20" style={{ background: color }} aria-hidden />
      {name}
    </span>
  );
}

export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="font-semibold text-pitch-700 underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

interface Toast {
  id: number;
  message: string;
  tone: "success" | "error";
}
const ToastCtx = createContext<(message: string, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast["tone"] = "success") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              "pointer-events-auto max-w-md rounded-xl px-4 py-3 text-sm font-semibold shadow-lg",
              t.tone === "success" ? "bg-ink text-white" : "bg-ember text-white",
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  tone = "primary",
  onConfirm,
  onClose,
  loading,
  requireReason,
  reasonPlaceholder = "e.g. Score entered wrongly",
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  tone?: Variant;
  onConfirm: (reason: string) => void;
  onClose: () => void;
  loading?: boolean;
  requireReason?: boolean;
  reasonPlaceholder?: string;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <Card className="w-full max-w-md p-6">
        <h3 className="text-2xl font-medium tracking-tight">{title}</h3>
        {children && <div className="mt-2 text-sm text-muted">{children}</div>}
        {requireReason && (
          <div className="mt-4">
            <Field label="Reason (recorded in the audit log)">
              <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonPlaceholder} />
            </Field>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={tone} loading={loading} disabled={requireReason && reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>
            {confirmLabel}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export function Avatar({ name, url, size = 36, className }: { name: string; url?: string | null; size?: number; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  const style = { width: size, height: size, fontSize: Math.max(11, size * 0.38) };
  return url ? (
    <img src={url} alt="" width={size} height={size} loading="lazy" className={cx("shrink-0 rounded-full object-cover ring-1 ring-black/10", className)} style={style} />
  ) : (
    <span aria-hidden className={cx("grid shrink-0 place-items-center rounded-full bg-pitch-100 font-bold text-pitch-800", className)} style={style}>
      {initials || "?"}
    </span>
  );
}

export function CardIcon({ color, className }: { color: "yellow" | "red"; className?: string }) {
  return (
    <span
      role="img"
      aria-label={`${color} card`}
      className={cx("inline-block h-4 w-3 rounded-[2px] ring-1 ring-black/20", color === "yellow" ? "bg-yellow-400" : "bg-red-600", className)}
    />
  );
}

/**
 * Stat card in the reference style: label top-left, a big thin number bottom-left, an optional
 * small note bottom-right, and a faint watermark word behind.
 */
export function StatTile({ label, value, note, watermark, tone, className }: { label: string; value: ReactNode; note?: ReactNode; watermark?: string; tone?: string; className?: string }) {
  return (
    <div className={cx("relative flex min-h-[150px] flex-col justify-between overflow-hidden rounded-[22px] border border-line bg-chalk p-5", className)}>
      {watermark && <span className="watermark" aria-hidden>{watermark}</span>}
      <div className="relative text-[15px] text-ink">{label}</div>
      <div className="relative flex items-end justify-between gap-2">
        <span className={cx("stat text-[56px] sm:text-[64px]", tone ?? "text-ink")}>{value}</span>
        {note && <span className="mb-1 text-xs text-muted">{note}</span>}
      </div>
    </div>
  );
}

/** "Tude De Souza" style: leading names in grey, the last name in ink. */
export function SplitName({ name, className }: { name: string; className?: string }) {
  const parts = name.trim().split(/\s+/);
  const last = parts.length > 1 ? parts.pop()! : parts[0]!;
  const lead = parts.length > 0 && name.trim().includes(" ") ? parts.join(" ") + " " : "";
  return (
    <span className={className}>
      {lead && <span className="text-muted">{lead}</span>}
      <span className="text-ink">{last}</span>
    </span>
  );
}

/** Label-over-value pair for profile grids. */
export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-0.5 text-[22px] leading-tight tracking-[-0.02em] text-ink">{value}</div>
    </div>
  );
}

/** Pill segmented control (tabs / filters), as in the reference's pill dropdowns. */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex max-w-full gap-1 overflow-x-auto rounded-full border border-line bg-white p-1">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx("min-h-10 whitespace-nowrap rounded-full px-4 text-sm transition", value === o.value ? "bg-pitch-700 font-medium text-white" : "text-muted hover:text-ink")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
