import { Card, PageHeader } from "../components/ui";
import { useMe } from "../hooks";

export default function RulesPage() {
  const { data } = useMe();
  return (
    <div className="max-w-2xl">
      <PageHeader title="How scoring works" kicker="Rules" />
      <Card className="p-5">
        <ol className="space-y-3">
          {(data?.rules ?? []).map((r, i) => (
            <li key={i} className="flex gap-3">
              <span className="display grid size-7 shrink-0 place-items-center rounded-full bg-pitch-100 text-sm font-bold text-pitch-800">{i + 1}</span>
              <span className="pt-0.5 leading-relaxed">{r}</span>
            </li>
          ))}
        </ol>
      </Card>
      <Card className="mt-4 bg-pitch-50 p-5">
        <h2 className="text-xl font-medium tracking-[-0.02em]">Example</h2>
        <p className="mt-1 text-sm leading-relaxed">
          Red wins 3 matches, Blue 2, White 1. Red is the daily winner. Every Red player who was there and was a member when play started gets <b>3 points</b> — not 9. A guest playing for Red still gets 0 points but keeps their goals and assists.
        </p>
      </Card>
    </div>
  );
}
