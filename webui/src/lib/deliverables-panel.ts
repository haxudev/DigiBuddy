/**
 * How wide the docked deliverables column is.
 *
 * The column is a real grid track now, not a floating window, so its width is
 * layout: too narrow and a report preview is unreadable, too wide and the
 * transcript it was generated from disappears. The reader sets it by dragging
 * the column's left edge, which means the number arrives from a pointer and has
 * to be clamped before it reaches CSS.
 *
 * The arithmetic lives here rather than in the component because the console's
 * tests run `src/lib/*.test.ts`; a drag handler in a React tree is not
 * something this repository can exercise, but the rule it applies is.
 */

/** Narrower than this and the preview pane stops being a preview. */
export const MIN_PANEL_WIDTH = 320;

/** What the column opens at, before anyone has dragged it. */
export const DEFAULT_PANEL_WIDTH = 460;

/**
 * The transcript keeps this much room whatever the reader drags.
 *
 * Deliverables are read next to the answer that produced them, so the column
 * must never be able to swallow the conversation. Maximising is the deliberate
 * way to give a deliverable the whole viewport, and it has its own control.
 */
export const MIN_CHAT_WIDTH = 420;

/** Where the chosen width is remembered, for every conversation at once. */
export const PANEL_WIDTH_KEY = "digibuddy.deliverables.width";

/** Below this the deliverables pane is a drawer, not a grid track. */
export const DOCKED_DELIVERABLES_BREAKPOINT = 860;

/**
 * Whether the chosen width participates in the grid.
 *
 * The mobile drawer is sized in CSS from the viewport, so clamping the saved
 * desktop width there would only overwrite a useful preference with a number
 * from a layout that is not using it.
 */
export function deliverablesUseGridTrack(viewportWidth: number): boolean {
  return viewportWidth > DOCKED_DELIVERABLES_BREAKPOINT;
}

/**
 * The real space shared by the transcript and deliverables column.
 *
 * The sessions sidebar is a `minmax()` track, so it is neither safe to subtract
 * the minimum nor the maximum from the viewport. Measuring from the chat
 * column's left edge to the shell's right edge gives the two tracks that
 * actually fight over the dragged width.
 */
export function sharedDeliverablesWidth(shellRight: number, chatLeft: number): number {
  if (!Number.isFinite(shellRight) || !Number.isFinite(chatLeft)) {
    return 0;
  }
  return Math.max(0, shellRight - chatLeft);
}

/**
 * A width the layout can actually honour.
 *
 * `available` is the space the column and the transcript share. On a viewport
 * too small to satisfy both minimums the column's minimum wins over the
 * transcript's -- the alternative is a column narrower than its own content,
 * which reflows into an unusable sliver -- and the narrow-screen layout, where
 * the column is a drawer rather than a track, never asks this question.
 */
export function clampPanelWidth(width: number, available: number): number {
  if (!Number.isFinite(width)) return DEFAULT_PANEL_WIDTH;
  const ceiling = Math.max(MIN_PANEL_WIDTH, available - MIN_CHAT_WIDTH);
  return Math.round(Math.min(Math.max(width, MIN_PANEL_WIDTH), ceiling));
}

/**
 * The width a drag to `pointerX` asks for.
 *
 * The handle sits on the column's left edge and the column is flush with the
 * right of the viewport, so the width is simply what is left of the edge --
 * dragging left widens. Unclamped on purpose: the caller pairs this with
 * `clampPanelWidth`, and keeping the two apart is what makes the clamp
 * testable on its own.
 */
export function panelWidthFromPointer(pointerX: number, viewportRight: number): number {
  return viewportRight - pointerX;
}

/** Read the remembered width, tolerating storage that is absent or junk. */
export function readPanelWidth(storage: Pick<Storage, "getItem"> | null): number {
  if (!storage) return DEFAULT_PANEL_WIDTH;
  try {
    const stored = Number(storage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_PANEL_WIDTH;
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
}

/** Remember a width, ignoring a storage that refuses to hold it. */
export function writePanelWidth(
  storage: Pick<Storage, "setItem"> | null,
  width: number,
): void {
  if (!storage) return;
  try {
    storage.setItem(PANEL_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // A full or blocked store costs the reader their width next session, which
    // is not worth breaking the drag over.
  }
}

/** Read storage through `window`, because the property access can throw too. */
export function readPanelWidthFromWindow(
  source: Pick<Window, "localStorage"> | null | undefined,
): number {
  try {
    return readPanelWidth(source?.localStorage ?? null);
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
}

/** Write storage through `window`, matching the same blocked-site-data failure. */
export function writePanelWidthToWindow(
  source: Pick<Window, "localStorage"> | null | undefined,
  width: number,
): void {
  try {
    writePanelWidth(source?.localStorage ?? null, width);
  } catch {
    // Browsers can throw before `setItem`, while resolving `localStorage`
    // itself. That failure is no more important than a quota failure.
  }
}
