"use client";

import { useEffect } from "react";
import { APP_VERSION } from "../lib/app-version";

const CACHE_PREFIX = "bitcoin-p2p-check-";

function isPreviewHostname(hostname: string) {
  return hostname.startsWith("staging-")
    || /^[0-9a-f]{8}-bitcoin-p2p-check\.thumbking-btc\.workers\.dev$/iu.test(hostname);
}

export function PwaRegistration() {
  useEffect(() => {
    const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
    document.documentElement.classList.toggle(
      "is-installed-pwa",
      navigatorWithStandalone.standalone === true,
    );

    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

    if (isPreviewHostname(window.location.hostname)) {
      void navigator.serviceWorker.getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .catch(() => {});

      if ("caches" in window) {
        void caches.keys()
          .then((keys) => Promise.all(
            keys
              .filter((key) => key.startsWith(CACHE_PREFIX))
              .map((key) => caches.delete(key)),
          ))
          .catch(() => {});
      }
      return;
    }

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
