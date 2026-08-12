"use client";

import { useEffect } from "react";

export function PwaRegistration() {
  useEffect(() => {
    const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
    document.documentElement.classList.toggle(
      "is-installed-pwa",
      navigatorWithStandalone.standalone === true,
    );

    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // 설치 지원이 없는 브라우저에서도 계산기는 그대로 동작합니다.
    });
  }, []);

  return null;
}
