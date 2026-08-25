/**
 * Moving the highlight in the composer's suggestion menu.
 *
 * The menu is typed into rather than tabbed into: the caret stays in the
 * textarea and the list is driven from there, the way a mention picker works
 * everywhere else. That makes the highlight a piece of state the composer owns
 * and this module moves, rather than DOM focus.
 */

export type SuggestionKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

const KEYS = new Set<string>(["ArrowDown", "ArrowUp", "Home", "End"]);

export function isSuggestionKey(key: string): key is SuggestionKey {
  return KEYS.has(key);
}

/**
 * Where the highlight lands next.
 *
 * Wraps at both ends, because a menu opened by typing is usually short and
 * being stopped at the bottom of a five-row list is a small, pointless
 * frustration. An empty list has nowhere to go.
 */
export function moveActive(
  index: number,
  length: number,
  key: SuggestionKey,
): number {
  if (length <= 0) return 0;
  const current = clampActive(index, length);
  switch (key) {
    case "ArrowDown":
      return (current + 1) % length;
    case "ArrowUp":
      return (current - 1 + length) % length;
    case "Home":
      return 0;
    case "End":
      return length - 1;
  }
}

/** Keep a remembered highlight inside a list that has since changed length. */
export function clampActive(index: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isInteger(index) || index < 0) return 0;
  return Math.min(index, length - 1);
}
