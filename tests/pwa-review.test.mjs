import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCTION_HOSTNAME,
  STAGING_HOSTNAME,
  shouldDisableServiceWorker,
} from "../app/lib/deployment-environment.mjs";
import {
  PWA_REVIEW_STORAGE_KEY,
  resolvePwaReviewOptIn,
} from "../app/lib/pwa-review.mjs";

const COMMIT_PREVIEW_HOSTNAME = `deadbeef-${PRODUCTION_HOSTNAME}`;

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("keeps service workers disabled on non-production environments by default", () => {
  assert.equal(shouldDisableServiceWorker(COMMIT_PREVIEW_HOSTNAME, "preview"), true);
  assert.equal(shouldDisableServiceWorker(STAGING_HOSTNAME, "staging"), true);
});

test("allows explicit PWA review only on a Worker-annotated exact preview host", () => {
  assert.equal(shouldDisableServiceWorker(COMMIT_PREVIEW_HOSTNAME, "preview", true), false);
  assert.equal(shouldDisableServiceWorker(STAGING_HOSTNAME, "staging", true), true);
  assert.equal(shouldDisableServiceWorker(PRODUCTION_HOSTNAME, "preview", true), true);
  assert.equal(shouldDisableServiceWorker(COMMIT_PREVIEW_HOSTNAME, "production", true), true);
});

test("production keeps its normal service worker behavior", () => {
  assert.equal(shouldDisableServiceWorker(PRODUCTION_HOSTNAME, "production"), false);
});

test("PWA review opt-in persists only in the current origin storage and can be cleared", () => {
  const storage = memoryStorage();
  assert.equal(resolvePwaReviewOptIn("?pwa-review=1", storage), true);
  assert.equal(storage.getItem(PWA_REVIEW_STORAGE_KEY), "1");
  assert.equal(resolvePwaReviewOptIn("", storage), true);
  assert.equal(resolvePwaReviewOptIn("?pwa-review=0", storage), false);
  assert.equal(storage.getItem(PWA_REVIEW_STORAGE_KEY), null);
  assert.equal(resolvePwaReviewOptIn("", storage), false);
});

test("PWA review opt-in still works without persistent browser storage", () => {
  assert.equal(resolvePwaReviewOptIn("?pwa-review=1", null), true);
  assert.equal(resolvePwaReviewOptIn("", null), false);
});
