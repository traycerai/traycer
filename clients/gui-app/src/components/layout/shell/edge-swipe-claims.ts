// Capture-phase shell recognition precedes the row's bubbling pointer handler.
const claimed = new WeakSet<Event>();

export function claimEdgeSwipeEvent(event: Event): void {
  claimed.add(event);
}

export function isEdgeSwipeEventClaimed(event: Event): boolean {
  return claimed.has(event);
}
