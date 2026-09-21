import assert from "node:assert/strict";
import test from "node:test";
import { assertPreviewUiState } from "../scripts/preview-ui-contract.mjs";

const working = {
  environment: "preview", noticeVisible: true, theme: "#f7931a", bodyMargin: "0px",
  stylesheets: 2, scrollWidth: 390, viewportWidth: 390, roleDisplay: "grid",
  formDisplay: "grid", cardPadding: 12, hydrated: true,
};
test("the rendering contract rejects browser-default HTML and missing JavaScript", () => {
  assert.doesNotThrow(() => assertPreviewUiState(working));
  for (const broken of [
    { theme: "" }, { bodyMargin: "8px" }, { stylesheets: 0 }, { roleDisplay: "block" },
    { formDisplay: "block" }, { cardPadding: 0 }, { hydrated: false },
    { environment: "production" }, { noticeVisible: false }, { scrollWidth: 700 },
  ]) assert.throws(() => assertPreviewUiState({ ...working, ...broken }));
  assert.doesNotThrow(() => assertPreviewUiState({ ...working, hydrated: false }, { hydrated: false }));
  assert.throws(() => assertPreviewUiState({ ...working, environment: "staging" }));
  assert.doesNotThrow(() => assertPreviewUiState({ ...working, environment: "staging" }, { environment: "staging" }));
  assert.throws(() => assertPreviewUiState({ ...working, environment: "production" }, { environment: "production" }));
});
