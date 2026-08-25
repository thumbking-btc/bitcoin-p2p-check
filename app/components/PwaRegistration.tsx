"use client";

import { useEffect, useState } from "react";
import { APP_VERSION } from "../lib/app-version";
import { shouldDisableServiceWorker } from "../lib/deployment-environment.mjs";

const CACHE_PREFIX = "bitcoin-p2p-check-";

export function PwaRegistration() {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
    document.documentElement.classList.toggle(
      "is-installed-pwa",
      navigatorWithStandalone.standalone === true,
    );

    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

    const annotatedEnvironment = document.documentElement.getAttribute("data-deployment-environment");
    if (shouldDisableServiceWorker(window.location.hostname, annotatedEnvironment)) {
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

    let disposed = false;
    let reloading = false;
    let registration: ServiceWorkerRegistration | null = null;
    let trackedInstallingWorker: ServiceWorker | null = null;

    const showWaitingWorker = () => {
      if (!disposed && registration?.waiting && navigator.serviceWorker.controller) {
        setWaitingWorker(registration.waiting);
      }
    };
    const handleInstallingState = () => {
      if (trackedInstallingWorker?.state === "installed") showWaitingWorker();
    };
    const handleUpdateFound = () => {
      trackedInstallingWorker?.removeEventListener("statechange", handleInstallingState);
      trackedInstallingWorker = registration?.installing ?? null;
      trackedInstallingWorker?.addEventListener("statechange", handleInstallingState);
    };
    const handleControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
    const serviceWorkerUrl = `/sw.js?v=${encodeURIComponent(APP_VERSION)}`;
    void navigator.serviceWorker.register(serviceWorkerUrl, {
      scope: "/",
      updateViaCache: "none",
    }).then((value) => {
      if (disposed) return;
      registration = value;
      showWaitingWorker();
      registration.addEventListener("updatefound", handleUpdateFound);
      void registration.update().catch(() => {});
    }).catch(() => {
      // 설치 지원이 없는 브라우저에서도 계산기는 그대로 동작합니다.
    });

    return () => {
      disposed = true;
      registration?.removeEventListener("updatefound", handleUpdateFound);
      trackedInstallingWorker?.removeEventListener("statechange", handleInstallingState);
      navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
    };
  }, []);

  if (!waitingWorker) return null;

  return (
    <aside className="pwa-update-notice" aria-labelledby="pwa-update-title" role="status">
      <div>
        <strong id="pwa-update-title">새 버전이 준비되었습니다.</strong>
        <p>작성 중인 내용을 확인한 뒤 새로고침하십시오.</p>
      </div>
      <button
        type="button"
        onClick={() => waitingWorker.postMessage({ type: "SKIP_WAITING" })}
      >
        새 버전 적용
      </button>
      <button type="button" onClick={() => setWaitingWorker(null)}>나중에</button>
    </aside>
  );
}
