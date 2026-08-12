"use client";

import { useEffect, useState } from "react";

type InstallMode = "guide" | "ios" | "ready" | "installed";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function isInstalledDisplayMode() {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return navigatorWithStandalone.standalone === true
    || ["standalone", "minimal-ui", "fullscreen", "window-controls-overlay"]
      .some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches);
}

function isAppleMobileBrowser() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function InstallCta() {
  const [mode, setMode] = useState<InstallMode>("guide");
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const displayQueries = ["standalone", "minimal-ui", "fullscreen", "window-controls-overlay"]
      .map((displayMode) => window.matchMedia(`(display-mode: ${displayMode})`));

    const updateInstalledState = () => {
      if (isInstalledDisplayMode()) {
        setDeferredPrompt(null);
        setMode("installed");
      }
    };
    const handleBeforeInstallPrompt = (event: Event) => {
      if (isInstalledDisplayMode()) return;
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      setMode("ready");
    };
    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setMode("installed");
    };

    const initialStateTimeout = window.setTimeout(() => {
      setMode(isInstalledDisplayMode() ? "installed" : isAppleMobileBrowser() ? "ios" : "guide");
    }, 0);
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    displayQueries.forEach((query) => query.addEventListener("change", updateInstalledState));

    return () => {
      window.clearTimeout(initialStateTimeout);
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
      displayQueries.forEach((query) => query.removeEventListener("change", updateInstalledState));
    };
  }, []);

  async function install() {
    const prompt = deferredPrompt;
    if (!prompt) return;
    setDeferredPrompt(null);
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setMode(choice.outcome === "accepted" ? "installed" : "guide");
    } catch {
      setMode("guide");
    }
  }

  if (mode === "installed") return null;
  if (mode === "ready") {
    return <button className="install-entry install-entry-button" type="button" onClick={() => void install()}>홈 화면에 추가</button>;
  }
  if (mode === "ios") {
    return <a className="install-entry" href="/install/#iphone">Safari에서 홈 화면에 추가</a>;
  }
  return <a className="install-entry" href="/install/">홈 화면에 추가하는 방법</a>;
}
