import { recordNegotiatedHostManifest } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

/**
 * Every UNARY floor mixed mode admits on, staged together - the ONE fixture
 * for it, shared by the provider suite and the cloud-view consumption suite.
 *
 * The WHOLE set, not the subset any one path happens to use:
 * `useNotificationFeedModeFor` admits on all of them, so omitting one drops a
 * suite into local mode and the failure surfaces as unrelated cloud assertions
 * rather than as a version problem.
 *
 * Shared rather than copied because the list grows with the floor.
 * `clearAll@1.1` is the fourth and was added a release after the first three;
 * a new floor reads `null`, which fails closed, so the tell is a suite that
 * quietly stops testing mixed mode rather than one that reports a missing
 * minor. Two literals that agreed today would let the next floor land in one
 * and leave the other running local-mode cases under a mixed-mode name. Add
 * the entry HERE in the same change as the floor.
 */
export function stageNotificationPartitionFloors(
  hostIds: ReadonlyArray<string>,
): void {
  for (const hostId of hostIds) {
    recordNegotiatedHostManifest(hostId, {
      "host.notifications.list": { major: 2, minor: 2 },
      "host.notifications.markAllRead": { major: 1, minor: 1 },
      "host.notifications.indicatorState": { major: 1, minor: 1 },
      "host.notifications.clearAll": { major: 1, minor: 1 },
    });
  }
}
