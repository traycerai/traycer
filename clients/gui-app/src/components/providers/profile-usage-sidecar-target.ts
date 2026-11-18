export function isProfileUsageSidecarTarget(
  target: EventTarget | null,
): boolean {
  return (
    target instanceof Element &&
    target.closest("[data-profile-usage-sidecar]") !== null
  );
}
