import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Seams for the suites that draw Retry and Edit on a post the bot failed to
 * answer: Retry needs the host's negotiated `bot.conversation.send` at 1.1 or
 * later, and Edit needs the signed-in user to be the post's writer.
 */

/** The viewer these suites sign in; a post written by anyone else is a teammate's. */
export const VIEWER_USER_ID = "user-viewer";

/** Records `bot.conversation.send` at `major.minor` as `hostId`'s last handshake. */
export function negotiateBotSend(
  hostId: string,
  version: { readonly major: number; readonly minor: number },
): void {
  recordNegotiatedHostManifest(hostId, { "bot.conversation.send": version });
}

/** Signs `userId` in, as the profile the failed-request hook compares a post's writer to. */
export function signInViewer(userId: string): void {
  useAuthStore.setState({
    profile: {
      userId,
      userName: "Olive Owner",
      email: "olive@example.com",
      avatarUrl: null,
    },
  });
}

/** Leaves no handshake recorded and no one signed in for the next case. */
export function resetBotFailedRequestSupport(): void {
  resetNegotiatedManifests();
  useAuthStore.setState({ profile: null });
}
