"use client";

import { useEffect } from "react";
import { APP_VERSION } from "../lib/app-version";

export function PwaRegistration() {
  useEffect(() => {
    const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
    document.documentElement.classList.toggle(
      "is-installed-pwa",
      navigatorWithStandalone.standalone === true,
    );

    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

    const serviceWorkerUrl = `/sw.js?v=${encodeURIComponent(APP_VERSION)}`;
    navigator.serviceWorker.register(serviceWorkerUrl, {
      scope: "/",
      updateViaCache: "none",
    }).catch(() => {
      // 설치 지원이 없는 브라우저에서도 계산기는 그대로 동작합니다.
    });
  }, []);

  return null;
}
