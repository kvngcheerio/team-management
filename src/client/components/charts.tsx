import { useEffect, useRef, useState } from "react";
import { formatDate } from "../format";
import { cx } from "./ui";

/*
 * Charts follow the dataviz method: fixed categorical order (win → played → absent), a palette
 * validated with validate_palette.js (#16794B / #BF8A3E / #C83F1D on white — tan is <3:1, so a
 * labelled legend is always shown and the match history list below is the table view),
 * thin marks, 4px rounded data-ends, and a hover tooltip on every mark.
 */

export interface FormPoint {
  key: string;
  date: string;
  state: "win" | "played" | "absent";
  points: number;
  goals: number;
  assists: number;
}

const STATE = {
  win: { label: "Daily win", color: "var(--color-series-win)" },
  played: { label: "Played", color: "var(--color-series-played)" },
  absent: { label: "Absent", color: "var(--color-series-absent)" },
} as const;

/** Width of the chart's container, so marks spread across the panel. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

function Tooltip({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-xl bg-ink px-3 py-2 text-xs text-white shadow-lg"
      style={{ left: x, top: y - 10 }}
    >
      {children}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ background: i.color }} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** One dot per match day, oldest → newest, laid out on a 3-row strip by state (like the reference dot plot). */
export function FormStrip({ points, title = "Form" }: { points: FormPoint[]; title?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const { ref, width: box } = useWidth();
  const rows: FormPoint["state"][] = ["win", "played", "absent"];
  // Spread dots across the panel; scroll only when there are many match days.
  const col = Math.max(18, Math.min(48, (box - 12) / Math.max(points.length, 1)));
  const rowH = 30;
  const width = Math.max(points.length * col + 12, box);
  const height = rows.length * rowH + 8;
  const cx0 = (i: number) => 6 + col * (i + 0.5);
  const cy0 = (s: FormPoint["state"]) => 14 + rows.indexOf(s) * rowH;
  return (
    <figure className="space-y-3">
      <figcaption className="text-[15px] text-ink">{title}</figcaption>
      <div ref={ref} className="relative overflow-x-auto">
        <svg width={width} height={height} role="img" aria-label={`${title}: ${points.filter((p) => p.state === "win").length} daily wins in ${points.length} match days`} className="block">
          {rows.map((r) => (
            <line key={r} x1={0} x2={width} y1={cy0(r)} y2={cy0(r)} stroke="var(--color-line)" strokeWidth={1} />
          ))}
          {points.map((p, i) => (
            <g key={p.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0}>
              {/* Hit target bigger than the mark. */}
              <rect x={cx0(i) - col / 2} y={0} width={col} height={height} fill="transparent" />
              <circle cx={cx0(i)} cy={cy0(p.state)} r={hover === i ? 7 : 5.5} fill={STATE[p.state].color} stroke="white" strokeWidth={2} />
            </g>
          ))}
        </svg>
        {hover !== null && points[hover] && (
          <Tooltip x={cx0(hover)} y={cy0(points[hover].state)}>
            <div className="font-medium">{formatDate(points[hover].date)}</div>
            <div>
              {STATE[points[hover].state].label} · {points[hover].points} pts · {points[hover].goals}G {points[hover].assists}A
            </div>
          </Tooltip>
        )}
      </div>
      <Legend items={rows.map((r) => STATE[r])} />
    </figure>
  );
}

/** Goal involvements (goals + assists) per match day. Single series: the title names it, no legend. */
export function InvolvementBars({ points, title = "Goal involvements per match day" }: { points: FormPoint[]; title?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const { ref, width: box } = useWidth();
  const values = points.map((p) => p.goals + p.assists);
  const max = Math.max(3, ...values);
  const gap = 4;
  const barW = Math.max(8, Math.min(28, (box - 28) / Math.max(points.length, 1) - gap));
  const h = 160;
  const width = Math.max(points.length * (barW + gap) + 28, box);
  const y = (v: number) => h - (v / max) * (h - 12);
  const ticks = [0, Math.ceil(max / 2), max];
  return (
    <figure className="space-y-3">
      <figcaption className="text-[15px] text-ink">{title}</figcaption>
      <div ref={ref} className="relative overflow-x-auto">
        <svg width={width} height={h + 22} role="img" aria-label={`${title}: ${values.reduce((a, b) => a + b, 0)} in total`} className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={22} x2={width} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
              <text x={0} y={y(t) + 4} fontSize={11} fill="var(--color-muted)">{t}</text>
            </g>
          ))}
          {points.map((p, i) => {
            const v = values[i]!;
            const x = 26 + i * (barW + gap);
            const top = y(v);
            return (
              <g key={p.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0}>
                <rect x={x - gap / 2} y={0} width={barW + gap} height={h} fill="transparent" />
                {v > 0 ? (
                  <path
                    d={`M${x},${h} V${top + 4} Q${x},${top} ${x + 4},${top} H${x + barW - 4} Q${x + barW},${top} ${x + barW},${top + 4} V${h} Z`}
                    fill={hover === i ? "var(--color-pitch-800)" : "var(--color-pitch-700)"}
                  />
                ) : (
                  <rect x={x} y={h - 2} width={barW} height={2} rx={1} fill="var(--color-line)" />
                )}
              </g>
            );
          })}
        </svg>
        {hover !== null && points[hover] && (
          <Tooltip x={26 + hover * (barW + gap) + barW / 2} y={y(values[hover]!)}>
            <div className="font-medium">{formatDate(points[hover].date)}</div>
            <div>
              {points[hover].goals} goal{points[hover].goals === 1 ? "" : "s"} · {points[hover].assists} assist{points[hover].assists === 1 ? "" : "s"}
            </div>
          </Tooltip>
        )}
      </div>
    </figure>
  );
}

export function ChartPanel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx("space-y-8 rounded-[22px] border border-line bg-chalk p-5 sm:p-6", className)}>{children}</div>;
}
