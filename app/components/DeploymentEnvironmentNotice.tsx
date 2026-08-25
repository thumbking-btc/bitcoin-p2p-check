"use client";

import { useEffect, useState } from "react";
import {
  normalizeOptionalDeploymentEnvironment,
  resolveDeploymentNotice,
} from "../lib/deployment-environment.mjs";

type DeploymentEnvironment = "production" | "staging" | "preview" | "unknown";

type VersionPayload = Readonly<{
  deploymentEnvironment?: unknown;
}>;

export function DeploymentEnvironmentNotice() {
  const [hostname, setHostname] = useState("");
  const [reportedEnvironment, setReportedEnvironment] = useState<DeploymentEnvironment | null>(null);

  useEffect(() => {
    const currentHostname = window.location.hostname;
    const annotatedEnvironment = normalizeOptionalDeploymentEnvironment(
      document.documentElement.getAttribute("data-deployment-environment"),
    );
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setHostname(currentHostname);
      setReportedEnvironment(annotatedEnvironment);
    });

    if (annotatedEnvironment === null) {
      void fetch("/api/version", {
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) return;
          const value = await response.json() as VersionPayload;
          const environment = normalizeOptionalDeploymentEnvironment(value.deploymentEnvironment);
          if (environment !== null) setReportedEnvironment(environment);
        })
        .catch(() => undefined);
    }

    return () => controller.abort();
  }, []);

  const notice = resolveDeploymentNotice(reportedEnvironment, hostname);
  const mismatch = notice?.mismatch === true;
  const label = !notice
    ? ""
    : mismatch
      ? "환경 설정 불일치"
      : notice.environment === "staging"
        ? "STAGING"
        : notice.environment === "preview" ? "PREVIEW" : "NON-PRODUCTION";
  const message = !notice
    ? ""
    : mismatch
      ? `호스트는 ${notice.inferredEnvironment.toUpperCase()}, Worker는 ${notice.reportedEnvironment.toUpperCase()}로 식별됩니다.`
      : "시험 환경입니다. 서버 거래 기록 저장 기능은 비활성화되어 있습니다.";

  return (
    <aside
      className={`deployment-notice${mismatch ? " deployment-notice-mismatch" : ""}`}
      data-deployment-environment={notice?.environment}
      hidden={!notice}
      id="deployment-environment-notice"
      role={mismatch ? "alert" : "status"}
      suppressHydrationWarning
    >
      <strong data-deployment-label="" suppressHydrationWarning>{label}</strong>
      <span data-deployment-message="" suppressHydrationWarning>{message}</span>
    </aside>
  );
}
