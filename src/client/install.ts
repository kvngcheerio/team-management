import { useSyncExternalStore } from "react";

/**
 * Add-to-home-screen support. Chrome/Edge/Samsung Internet on Android fire `beforeinstallprompt` once,
 * early in page load, so it's captured here at start-up and replayed from the Install button.
 * iPhone/iPad have no prompt: the guide walks through Share → Add to Home Screen instead.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e as InstallPromptEvent;
  notify();
});
window.addEventListener("appinstalled", () => {
  deferred = null;
  notify();
});

function subscribe(l: () => void) {
  listeners.add(l);
  const mq = window.matchMedia("(display-mode: standalone)");
  mq.addEventListener("change", l);
  return () => {
    listeners.delete(l);
    mq.removeEventListener("change", l);
  };
}

export function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export type Platform = "ios" | "android" | "desktop";

export function platform(): Platform {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch points give it away.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "desktop";
}

/** Whether the app is installed, and a one-tap install where the browser supports it. */
export function useInstall() {
  const canPrompt = useSyncExternalStore(subscribe, () => deferred !== null);
  const installed = useSyncExternalStore(subscribe, isStandalone);
  const install = async () => {
    if (!deferred) return false;
    const e = deferred;
    deferred = null;
    notify();
    await e.prompt();
    return (await e.userChoice).outcome === "accepted";
  };
  return { canPrompt, installed, install, platform: platform() };
}
