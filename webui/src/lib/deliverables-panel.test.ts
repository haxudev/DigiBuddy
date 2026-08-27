import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PANEL_WIDTH,
  DOCKED_DELIVERABLES_BREAKPOINT,
  MIN_CHAT_WIDTH,
  MIN_PANEL_WIDTH,
  PANEL_WIDTH_KEY,
  clampPanelWidth,
  deliverablesUseGridTrack,
  panelWidthFromPointer,
  readPanelWidth,
  readPanelWidthFromWindow,
  sharedDeliverablesWidth,
  writePanelWidth,
  writePanelWidthToWindow,
} from "./deliverables-panel.ts";

test("a comfortable width is kept as asked", () => {
  assert.equal(clampPanelWidth(520, 1440), 520);
});

test("a width below the minimum is raised to it", () => {
  assert.equal(clampPanelWidth(120, 1440), MIN_PANEL_WIDTH);
});

test("the transcript keeps its minimum width", () => {
  assert.equal(clampPanelWidth(1300, 1440 - 288), 1440 - 288 - MIN_CHAT_WIDTH);
});

test("the sessions sidebar is not counted as shared space", () => {
  const available = sharedDeliverablesWidth(1280, 288);
  assert.equal(clampPanelWidth(900, available), 1280 - 288 - MIN_CHAT_WIDTH);
});

test("a viewport too small for both minimums still yields a usable column", () => {
  const available = sharedDeliverablesWidth(861, 240);
  assert.equal(clampPanelWidth(600, available), MIN_PANEL_WIDTH);
});

test("a resize that shrinks the viewport reclamps a persisted wide column", () => {
  const available = sharedDeliverablesWidth(900, 240);
  assert.equal(clampPanelWidth(900, available), MIN_PANEL_WIDTH);
});

test("the mobile drawer does not use the grid width", () => {
  assert.equal(deliverablesUseGridTrack(DOCKED_DELIVERABLES_BREAKPOINT), false);
  assert.equal(deliverablesUseGridTrack(DOCKED_DELIVERABLES_BREAKPOINT + 1), true);
});

test("a width that is not a number falls back to the default", () => {
  assert.equal(clampPanelWidth(Number.NaN, 1440), DEFAULT_PANEL_WIDTH);
});

test("a fractional drag settles on whole pixels", () => {
  assert.equal(clampPanelWidth(520.4, 1440), 520);
});

test("dragging the left edge leftwards widens the column", () => {
  assert.equal(panelWidthFromPointer(900, 1440), 540);
  assert.equal(panelWidthFromPointer(1100, 1440), 340);
});

test("a remembered width is read back", () => {
  const storage = { getItem: (key: string) => (key === PANEL_WIDTH_KEY ? "512" : null) };
  assert.equal(readPanelWidth(storage), 512);
});

test("absent, junk, or unreadable storage falls back to the default", () => {
  assert.equal(readPanelWidth(null), DEFAULT_PANEL_WIDTH);
  assert.equal(readPanelWidth({ getItem: () => "wide" }), DEFAULT_PANEL_WIDTH);
  assert.equal(readPanelWidth({ getItem: () => "0" }), DEFAULT_PANEL_WIDTH);
  assert.equal(
    readPanelWidth({
      getItem: () => {
        throw new Error("blocked");
      },
    }),
    DEFAULT_PANEL_WIDTH,
  );
});

test("a width is written as whole pixels and a failing store is survivable", () => {
  const written: Record<string, string> = {};
  writePanelWidth({ setItem: (key, value) => void (written[key] = value) }, 512.6);
  assert.equal(written[PANEL_WIDTH_KEY], "513");

  assert.doesNotThrow(() =>
    writePanelWidth(
      {
        setItem: () => {
          throw new Error("full");
        },
      },
      512,
    ),
  );
  assert.doesNotThrow(() => writePanelWidth(null, 512));
});

test("blocked access to the storage property is survivable", () => {
  const blocked = {
    get localStorage(): Storage {
      throw new Error("blocked");
    },
  };

  assert.equal(readPanelWidthFromWindow(blocked), DEFAULT_PANEL_WIDTH);
  assert.doesNotThrow(() => writePanelWidthToWindow(blocked, 512));
});
