import { useEffect } from "react";
import {
  createNotificationDemux,
  defaultNotificationChannelAccepts,
  NOTIFICATION_EMISSION_HOLD_MS,
  readNotificationEmissionRows,
  shouldSuppressNotificationEmissionForFocus,
  subscribeNotificationEmissionSources,
  type NotificationEmissionChannel,
  type NotificationEmissionClock,
  type NotificationEmissionRow,
} from "@/lib/notifications/notification-demux";
import { useNotificationShow } from "@/hooks/notifications/use-notifications";

export function NotificationEmissionController(): null {
  const showNotification = useNotificationShow();

  useEffect(() => {
    const demux = createNotificationDemux({
      holdMs: NOTIFICATION_EMISSION_HOLD_MS,
      clock: browserNotificationEmissionClock,
      channels: [
        createToastNotificationChannel(showNotification),
        createChimeNotificationChannel(playNotificationChime),
      ],
      getRows: readNotificationEmissionRows,
      shouldSuppressForFocus: shouldSuppressNotificationEmissionForFocus,
    });
    const unsubscribe = subscribeNotificationEmissionSources(demux);
    return () => {
      unsubscribe();
      demux.dispose();
    };
  }, [showNotification]);

  return null;
}

const browserNotificationEmissionClock: NotificationEmissionClock = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs) => window.setTimeout(handler, delayMs),
  clearTimeout: (timerId) => {
    window.clearTimeout(timerId);
  },
};

function createToastNotificationChannel(
  showNotification: (
    title: string,
    body: string,
    payload: unknown,
  ) => Promise<void>,
): NotificationEmissionChannel {
  return {
    id: "os-toast",
    accepts: defaultNotificationChannelAccepts,
    emit: (rows) => {
      const content = buildToastContent(rows);
      void showNotification(content.title, content.body, content.payload).catch(
        () => {
          // The feed remains authoritative; a failed native toast is non-critical.
        },
      );
    },
  };
}

function createChimeNotificationChannel(
  playChime: () => void,
): NotificationEmissionChannel {
  return {
    id: "chime",
    accepts: defaultNotificationChannelAccepts,
    emit: () => {
      playChime();
    },
  };
}

function buildToastContent(rows: ReadonlyArray<NotificationEmissionRow>): {
  readonly title: string;
  readonly body: string;
  readonly payload: unknown;
} {
  const first = rows[0];
  if (rows.length === 1) {
    return {
      title: "Traycer",
      body: first.text,
      payload: first.payload,
    };
  }
  if (rows.length === 0) {
    return {
      title: "Traycer",
      body: "0 new notifications",
      payload: null,
    };
  }
  return {
    title: "Traycer",
    body: `${rows.length} new notifications`,
    payload: first.payload,
  };
}

function playNotificationChime(): void {
  if (typeof window === "undefined") return;
  if (typeof window.AudioContext === "undefined") return;
  try {
    const context = new window.AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.2);
    oscillator.onended = () => {
      void context.close();
    };
  } catch {
    // Autoplay/device restrictions can reject audio setup; the toast/feed still work.
  }
}
