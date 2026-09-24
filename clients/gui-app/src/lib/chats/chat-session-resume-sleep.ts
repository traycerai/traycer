import type {
  IRunnerHost,
  SystemResumeEvent,
} from "@traycer-clients/shared/platform/runner-host";
import { WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS } from "@traycer-clients/shared/host-transport/remote/index";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { isMobileApp } from "@/lib/mobile-app";
import { appLogger } from "@/lib/logger";

/**
 * Whether a resume came back from a background long enough that every warm
 * chat would be re-dialed.
 *
 * The same gate `wakeReconnectOptions` uses to force the redial: at or past
 * {@link WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS} the OS has torn the
 * sockets down, so a warm chat is about to re-subscribe and download its
 * snapshot again whether or not anyone opens it. Under it the socket may well
 * have survived a quick app switch, and a warm chat is still what makes
 * switching back to it instant - so it is left alone. A resume that cannot
 * state its dwell (the DOM pair in the dev browser) is left alone too.
 */
export function resumeRedialsWarmChats(event: SystemResumeEvent): boolean {
  const backgroundedForMs = event.backgroundedForMs;
  return (
    backgroundedForMs !== null &&
    backgroundedForMs >= WAKE_FORCE_RECONNECT_AFTER_BACKGROUND_MS
  );
}

/**
 * On the installed mobile app, return from a long background with only the
 * chats a tile holds reconnecting: every lease-free chat with no unsettled
 * work is put to sleep (stream closed, store kept) and reconnects when a tile
 * next leases it. Returns a disposer.
 *
 * The wake pulse re-dials every chat stream a window holds, and on a phone
 * each re-dial re-sends `chat.subscribe` and downloads the chat's skeleton and
 * snapshot again - for warm chats nobody is looking at as much as for the one
 * on screen. Chats with work in flight stay connected: agent activity reads
 * them, and closing the stream would drop the frames that settle the work.
 * Epic and other non-chat streams keep their wake behaviour; this touches
 * only the chat registry.
 *
 * Runs on the same resume edge as the transports' own wake reconnect, in
 * whichever order the shell delivers them. Either way the chat ends asleep: a
 * reconnect already started is closed with the stream, and the closed-session
 * wake retry skips sleeping sessions.
 */
export function subscribeWarmChatSleepOnResume(
  runnerHost: IRunnerHost | null,
): () => void {
  if (runnerHost === null || !isMobileApp()) return () => undefined;
  const subscription = runnerHost.onSystemResumed((event) => {
    if (!resumeRedialsWarmChats(event)) return;
    const slept = getChatSessionRegistry().sleepIdleWarmSessions();
    appLogger.info("[chat-session] resume left warm chats asleep", {
      slept,
      backgroundedForMs: event.backgroundedForMs,
    });
  });
  return () => {
    subscription.dispose();
  };
}
