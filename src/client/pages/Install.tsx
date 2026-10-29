import { useState } from "react";
import { Button, Card, PageHeader, Segmented } from "../components/ui";
import { useInstall, type Platform } from "../install";

const STEPS: Record<Platform, { title: string; steps: string[]; note?: string }> = {
  ios: {
    title: "iPhone or iPad",
    steps: [
      "Open this site in Safari (on iOS 16.4 or later, Chrome works too).",
      "Tap the Share button: the square with an arrow pointing up (bottom of the screen in Safari, top right in Chrome).",
      "Scroll down and tap “Add to Home Screen”.",
      "Keep “Open as Web App” switched on if you see it, then tap “Add”.",
      "Open the app from its new icon on your home screen.",
    ],
    note: "Match notifications on iPhone will only work from the home-screen app, so it's worth adding now.",
  },
  android: {
    title: "Android",
    steps: [
      "Open this site in Chrome (Samsung Internet and Edge work too).",
      "Tap the ⋮ menu at the top right.",
      "Tap “Install app” or “Add to Home screen”, then “Install”.",
      "Open the app from its new icon on your home screen or in the app drawer.",
    ],
  },
  desktop: {
    title: "Computer",
    steps: [
      "Open this site in Chrome or Edge.",
      "Click the install icon at the right end of the address bar (a screen with a down arrow), or open the ⋮ menu and choose “Install”.",
      "The app opens in its own window and gets a Dock / Start menu icon.",
    ],
  },
};

export default function InstallPage() {
  const { installed, canPrompt, install, platform } = useInstall();
  const [tab, setTab] = useState<Platform>(platform);
  const [result, setResult] = useState<string | null>(null);
  const guide = STEPS[tab];
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Install the app" kicker="Easy access" />
      {installed ? (
        <Card className="p-5">
          <p className="font-semibold">You're using the installed app. 🎉</p>
          <p className="mt-1 text-sm text-muted">Nothing else to do.</p>
        </Card>
      ) : (
        <>
          <p className="text-[15px] text-muted">
            Add the app to your home screen: it opens full screen in one tap, keeps the last match days, teams and table on your phone, and
            check-ins or live scores made without signal send when you're back online.
          </p>
          {canPrompt && (
            <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
              <span className="font-semibold">Your browser can install it in one tap.</span>
              <Button onClick={async () => setResult((await install()) ? "Installed. Find it on your home screen." : "No problem; you can install it later.")}>
                Install
              </Button>
              {result && <p className="w-full text-sm text-muted">{result}</p>}
            </Card>
          )}
          <Segmented
            value={tab}
            label="Device"
            onChange={setTab}
            options={[
              { value: "ios" as const, label: "iPhone" },
              { value: "android" as const, label: "Android" },
              { value: "desktop" as const, label: "Computer" },
            ]}
          />
          <Card className="p-5">
            <h2 className="mb-3 text-lg font-semibold">{guide.title}</h2>
            <ol className="list-decimal space-y-2 pl-5 text-[15px]">
              {guide.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            {guide.note && <p className="mt-4 rounded-xl bg-pitch-50 px-3 py-2 text-sm">{guide.note}</p>}
          </Card>
        </>
      )}
    </div>
  );
}
