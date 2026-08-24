"use client";

import { useEffect, useState } from "react";
import {
  getInstallInviteDismissedUntil,
  INSTALL_INVITE_DISMISS_KEY,
  isInstallInviteSuppressed,
} from "../lib/install-invite.mjs";

type InstallMode = "guide" | "ios" | "android" | "ready" | "installed";

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

function isSamsungInternet() {
  return /SamsungBrowser/i.test(navigator.userAgent);
}

function isMobileBrowser() {
  return isAppleMobileBrowser()
    || /Android|Mobile/i.test(navigator.userAgent)
    || window.matchMedia("(max-width: 700px)").matches;
}

function manualInstallMode(): Extract<InstallMode, "guide" | "ios" | "android"> {
  if (isAppleMobileBrowser()) return "ios";
  if (/Android/i.test(navigator.userAgent)) return "android";
  return "guide";
}

function isInviteDismissed() {
  try {
    return isInstallInviteSuppressed(window.localStorage.getItem(INSTALL_INVITE_DISMISS_KEY));
  } catch {
    return false;
  }
}

function rememberInviteDismissal() {
  try {
    window.localStorage.setItem(
      INSTALL_INVITE_DISMISS_KEY,
      String(getInstallInviteDismissedUntil()),
    );
  } catch {
    // Storage can be unavailable in private or embedded browsers.
  }
}

export function InstallCta({ showEntry = true }: { showEntry?: boolean }) {
  const [mode, setMode] = useState<InstallMode>("guide");
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [inviteVisible, setInviteVisible] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let promptReceived = false;
    const displayQueries = ["standalone", "minimal-ui", "fullscreen", "window-controls-overlay"]
      .map((displayMode) => window.matchMedia(`(display-mode: ${displayMode})`));

    const updateInstalledState = () => {
      if (isInstalledDisplayMode()) {
        setDeferredPrompt(null);
        setMode("installed");
        setInviteVisible(false);
      }
    };
    const handleBeforeInstallPrompt = (event: Event) => {
      if (isInstalledDisplayMode()) return;

      // Samsung Internet exposed an install path that did not behave consistently
      // in device testing. Keep the product flow deterministic: Android users on
      // Samsung Internet are sent to the tested Chrome installation guide instead
      // of being offered a browser-specific direct WebAPK prompt.
      if (isSamsungInternet()) {
        promptReceived = true;
        event.preventDefault();
        setDeferredPrompt(null);
        setMode("android");
        if (isMobileBrowser() && !isInviteDismissed()) setInviteVisible(true);
        return;
      }

      promptReceived = true;
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      setMode("ready");
      if (isMobileBrowser() && !isInviteDismissed()) setInviteVisible(true);
    };
    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setMode("installed");
      setInviteVisible(false);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    displayQueries.forEach((query) => query.addEventListener("change", updateInstalledState));
    const initialStateTimeout = window.setTimeout(() => {
      if (promptReceived) return;
      if (isInstalledDisplayMode()) {
        setMode("installed");
        setInviteVisible(false);
      } else {
        setMode(manualInstallMode());
        setInviteVisible(isMobileBrowser() && !isInviteDismissed());
      }
    }, 0);

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
    setInstalling(true);
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "accepted") {
        setMode("installed");
        setInviteVisible(false);
      } else {
        rememberInviteDismissal();
        setMode(manualInstallMode());
        setInviteVisible(false);
      }
    } catch {
      setMode(manualInstallMode());
    } finally {
      setInstalling(false);
    }
  }

  function dismissInvite() {
    rememberInviteDismissal();
    setInviteVisible(false);
  }

  if (mode === "installed") return null;

  const guideHref = mode === "ios"
    ? "/install/#iphone"
    : mode === "android"
      ? "/install/#android"
      : "/install/";
  const inviteTitle = mode === "ready"
    ? "P2P 계산기를 설치할까요?"
    : "P2P 계산기를 홈 화면에 추가할까요?";
  const inviteDescription = mode === "ready"
    ? "다음부터 주소 입력 없이 바로 열 수 있습니다."
    : mode === "ios"
      ? "공유 메뉴에서 홈 화면에 추가할 수 있습니다."
      : mode === "android"
        ? "Chrome으로 연 뒤 브라우저 메뉴에서 설치할 수 있습니다."
        : "설치 안내에서 브라우저별 방법을 확인할 수 있습니다.";

  return (
    <>
      {showEntry && mode === "ready" ? (
        <button
          aria-busy={installing}
          className="install-entry install-entry-button"
          disabled={installing}
          type="button"
          onClick={() => void install()}
        >
          {installing ? "설치 창 여는 중…" : "홈 화면에 추가"}
        </button>
      ) : showEntry ? (
        <a className="install-entry" href={guideHref}>
          {mode === "ios"
            ? "iPhone 홈 화면에 추가"
            : mode === "android"
              ? "Android 홈 화면에 추가"
              : "홈 화면에 추가하는 방법"}
        </a>
      ) : null}

      {inviteVisible ? (
        <aside className="install-invite" aria-labelledby="install-invite-title">
          <div className="install-invite-heading">
            <span className="install-invite-icon" aria-hidden="true">₿</span>
            <div>
              <h2 id="install-invite-title">{inviteTitle}</h2>
              <p>{inviteDescription}</p>
            </div>
          </div>
          <div className="install-invite-actions">
            {mode === "ready" ? (
              <button
                aria-busy={installing}
                className="install-invite-primary"
                disabled={installing}
                type="button"
                onClick={() => void install()}
              >
                {installing ? "설치 창 여는 중…" : "설치하기"}
              </button>
            ) : (
              <a className="install-invite-primary" href={guideHref}>추가 방법 보기</a>
            )}
            <button className="install-invite-later" type="button" onClick={dismissInvite}>나중에</button>
          </div>
        </aside>
      ) : null}
    </>
  );
}
