# Preview rendering incident and regression contract

## Observed failure, not a device diagnosis

The reported immutable preview was `6e2c4466-bitcoin-p2p-check.thumbking-btc.workers.dev`, source commit `31b786e5c4bb08e817ba4801902ee9a2c6f0eaf7`. Both `/` and `/?pwa-review=1` returned HTML, but the two stylesheets and twelve directly referenced JavaScript assets returned HTTP 404. Clean Chromium and WebKit contexts with service workers blocked reproduced the problem. The expected HTML CSP, `nosniff`, and Worker-provided preview annotation were also absent. Client hydration never completed.

Diagnostic evidence: GitHub Actions run `33929115044`, artifact `9957913473` (`reported-preview-diagnostics-aa4f73c30d9fc3f93d78a57794e8207e6c2b20e5`). This contradicts earlier assumptions that only Safari or an old client cache was responsible, or that static loading labels proved JavaScript was running.

## Root cause: different entrypoints were tested and published

The Vite Cloudflare plugin uses `worker/prerender.ts` to build static pages. It generates `.wrangler/deploy/config.json`, which redirects implicit Wrangler commands to the generated RSC Worker. Cloudflare's branch build followed that redirect. The build-only entry rendered HTML but did not use the production/static handler's asset routing, CSP, or HTML environment annotations.

Local release tests used explicit Wrangler configuration files and therefore tested `worker/index.ts`, not the implicitly published build-only Worker. A successful `/api/version` response did not distinguish the two handlers. The earlier fingerprint gate failed before exercising the real browser, and the candidate was nevertheless handed to the operator; that readiness decision was incorrect.

Reference: https://developers.cloudflare.com/workers/wrangler/configuration/#generated-wrangler-configuration

## Repair

`postbuild` now generates CSP and then publishes a validated preview-only Wrangler redirect. The generated configuration points to `worker/preview-entry.ts` and the exact `dist/client` directory. The preview entry reuses the secured default handler from `worker/index.ts` without exporting the storage-only Durable Object class. Production and staging retain their original entries and configurations.

The packaging guard rejects unexpected capabilities, production variables, storage bindings, observability changes, or a prerender entrypoint. Its check mode never silently repairs a changed pointer. An implicit `wrangler deploy --dry-run` is exercised in CI in addition to the existing explicit-config tests. No production deployment command is enabled.

The first corrected publication (`f3b00afadb79fdff69f2f234b57ae3a023c8c9be`, version `4bb3aa77-92ba-49f8-9ac8-970f436e9ca0`) restored all fourteen direct assets to HTTP 200, restored the enforced security headers, and rendered the original design in both engines. No application CSS was changed to obtain that result.

## Independent build reproducibility issue

Comparing the downloaded CI and Cloudflare assets showed a random RSC compatibility UUID in `vinext-*.js`; other filename differences cascaded through its imports. This was not evidence of a Node-version defect. Vinext creates a random RSC compatibility ID unless `deploymentId` is supplied. Both `deploymentId` and `generateBuildId` now use the exact checked-out commit from `git rev-parse HEAD`, never the synthetic pull-request merge SHA or a random fallback. The strict fingerprint gate subsequently passed for commit `8661da18e96c87ec10f5e14d74c40d20aab7e3fc`.

Primary implementation reference: https://github.com/cloudflare/vinext/blob/e91f3bd6b4c5f307f528dee5556aaa1d927e00a5/packages/vinext/src/config/next-config.ts (`createRscCompatibilityId`).

## Required acceptance evidence for each candidate

The same PR head must pass the complete release gate, static asset graph checks, implicit publication-target dry-run, exact Cloudflare commit-preview identity, deployed Chromium and WebKit rendering, unchanged asset fingerprints, and byte-for-byte checks of all built JavaScript/CSS plus the service worker, manifest, and CSP policy. Every primary HTML route must enforce the CSP from the inspected build. Reports and screenshots are retained as workflow artifacts even when a later check fails.

Computed-style assertions check the actual theme, body margin, grid layouts, existing responsive padding, viewport width, visible preview identity, and completed hydration. Role-switch interactions must work. A negative control disables the stylesheets and must be rejected; 404, wrong MIME, missing security headers, and changed bytes also have negative tests. Do not repair a failing test by changing the application's established design or relaxing CSP.

Cloudflare upload success alone is not acceptance. The automated branch preview may exist before GitHub verification finishes; it must not be recommended for human review or merged on that basis. Keep PR #26 in Draft until broader release requirements are separately met.

## Browser-test boundaries

Chromium and WebKit validate online rendering at 320, 390, and 1280 pixels, JavaScript-disabled primary routes, and PWA opt-in/online relaunch/opt-out. Chromium additionally validates service-worker-served offline startup, a genuinely failing uncached API request, no cached API responses, and online recovery. Playwright documents its service-worker instrumentation as Chromium-only; native iPhone home-screen installation and Safari offline relaunch are not claimed as automated coverage.

References: https://playwright.dev/docs/service-workers and https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine . `navigator.onLine` is not proof of API reachability; the offline check verifies an actual uncached request fails.

Playwright's WebKit screenshot preparation injects an inline `body {}` animation-sync stylesheet. With strict CSP this diagnostic action itself emits a violation. Application error/CSP assertions therefore finish before screenshot capture, and capture occurs only afterward in cleanup. The site's CSP remains unchanged; application violations still fail the gate. See https://github.com/microsoft/playwright/blob/46cd5008d12d4e1297793d921e6cc3b595e388da/packages/playwright-core/src/server/screenshotter.ts .

Old immutable preview URLs remain historical broken versions. A repair is a new source commit and new version URL, not an instruction to clear the operator's cache. No main/staging branch merge or production deployment is part of this incident repair.
