import assert from "node:assert/strict";

// These values distinguish the application's layout from browser-default HTML.
// Keep this separate from screenshot baselines so missing CSS cannot be approved
// accidentally by updating a reference image.
export function assertPreviewUiState(state, { calculator = true, hydrated = true } = {}) {
  assert.equal(state.environment, "preview", "HTML must be annotated by the real preview Worker");
  assert.equal(state.noticeVisible, true, "The preview identity must remain visible");
  assert.ok(state.theme.length > 0, "The global stylesheet did not establish the theme");
  assert.equal(state.bodyMargin, "0px", "Browser-default body margins indicate missing CSS");
  assert.ok(state.stylesheets > 0, "No nonempty stylesheet was applied");
  assert.ok(state.scrollWidth <= state.viewportWidth + 1, "The viewport overflows horizontally");
  if (calculator) {
    assert.equal(state.roleDisplay, "grid", "Buy/sell layout stylesheet is missing");
    assert.equal(state.formDisplay, "grid", "Amount form stylesheet is missing");
    assert.ok(state.cardPadding >= 14, "The trade card lost its layout padding");
    if (hydrated) assert.equal(state.hydrated, true, "Client JavaScript did not hydrate the calculator");
  }
}
