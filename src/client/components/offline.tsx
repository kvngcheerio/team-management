import { useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { useInstall } from "../install";
import { dismissFailures, useOutbox } from "../outbox";
import { Button, cx } from "./ui";

function subscribeOnline(l: () => void) {
  window.addEventListener("online", l);
  window.addEventListener("offline", l);
  return () => {
    window.removeEventListener("online", l);
    window.removeEventListener("offline", l);
  };
}

export function useOnline() {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Offline notice and the state of changes saved on this phone (waiting, sending, failed). */
export function OfflineBanner() {
  const online = useOnline();
  const { items, failures, needsSignIn } = useOutbox();
  const [showPending, setShowPending] = useState(false);
  const waiting = items.length;
  if (online && !waiting && !failures.length) return null;
  return (
    <div className="space-y-2" aria-live="polite">
      {(!online || waiting > 0) && (
        <div className={cx("rounded-2xl px-4 py-3 text-sm", online ? "bg-sky-50 text-sky-900" : "bg-stone-100 text-ink")}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {!online && <b>You're offline. </b>}
              {!online && !waiting && "Showing what was last loaded. Check-ins and live scores still save on this phone."}
              {waiting > 0 &&
                (needsSignIn ? (
                  <>
                    {plural(waiting, "change")} waiting. <Link to="/signin" className="font-semibold underline">Sign in again</Link> to send them.
                  </>
                ) : online ? (
                  `Sending ${plural(waiting, "saved change")}…`
                ) : (
                  `${plural(waiting, "change")} saved on this phone; they'll send when you're back online.`
                ))}
            </span>
            {waiting > 0 && (
              <button className="font-medium underline underline-offset-4" onClick={() => setShowPending((v) => !v)}>
                {showPending ? "Hide" : "Show"}
              </button>
            )}
          </div>
          {showPending && waiting > 0 && (
            <ul className="mt-2 list-disc pl-5 text-muted">
              {items.map((i) => (
                <li key={i.id}>{i.label}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {failures.length > 0 && (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <p className="font-semibold">{plural(failures.length, "saved change")} couldn't be applied:</p>
          <ul className="mt-1 list-disc pl-5">
            {failures.map((f) => (
              <li key={f.id}>
                {f.label}: {f.message}
              </li>
            ))}
          </ul>
          <button className="mt-2 font-medium underline underline-offset-4" onClick={dismissFailures}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

const DISMISS_KEY = "matchday:install-card-dismissed";

/** Nudge on phones to add the app to the home screen, until installed or dismissed. */
export function InstallCard() {
  const { installed, canPrompt, install, platform } = useInstall();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (installed || dismissed || (platform === "desktop" && !canPrompt)) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[22px] border border-line bg-pitch-50 px-4 py-3">
      <img src="/icons/icon-192.png" alt="" className="size-10 rounded-xl" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-semibold">Add the app to your home screen</div>
        <div className="text-muted">Opens full screen in one tap, and works at the pitch with weak signal.</div>
      </div>
      <div className="flex items-center gap-2">
        {canPrompt ? (
          <Button size="sm" onClick={() => void install()}>Install</Button>
        ) : (
          <Link to="/install"><Button size="sm">Show me how</Button></Link>
        )}
        <button className="px-2 text-sm text-muted hover:text-ink" onClick={dismiss} aria-label="Dismiss">
          Not now
        </button>
      </div>
    </div>
  );
}
