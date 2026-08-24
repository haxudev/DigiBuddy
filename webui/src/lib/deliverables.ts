/**
 * Deciding when to surface the deliverables window.
 *
 * A generated file only counts as delivered once the reader can see it. The
 * window is therefore opened by the arrival of a new deliverable rather than by
 * a button the reader has to discover, while switching sessions stays quiet so
 * old deliverables never pop open on their own.
 */
export type DeliveryFocus = {
  /** Session the deliverables belong to. */
  session: string;
  /** Identity of the newest deliverable in that session, or "" when none. */
  latest: string;
};

export function deliveryFocus(
  session: string,
  artifactIds: readonly string[],
): DeliveryFocus {
  return { session, latest: artifactIds[artifactIds.length - 1] ?? "" };
}

export function shouldOpenDeliverables(
  previous: DeliveryFocus,
  next: DeliveryFocus,
): boolean {
  if (!next.latest) return false;
  // Reading another session is navigation, not delivery.
  if (previous.session !== next.session) return false;
  return previous.latest !== next.latest;
}
