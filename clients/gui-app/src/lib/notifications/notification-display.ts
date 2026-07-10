import type { NotificationShow } from "@/hooks/notifications/use-notifications";
import {
  rowFromAppLocalEntry,
  rowFromHostEntry,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";
import type { AppLocalNotificationEntry } from "@/stores/notifications/app-local-notifications-store";
import type { HostNotificationEntryV11 } from "@traycer/protocol/host/notifications/contracts";

export interface NotificationDisplayTarget {
  readonly showNotification: NotificationShow;
  readonly playChime: () => void;
}

export function displayNotificationRows(
  rows: ReadonlyArray<MergedNotificationRow>,
  target: NotificationDisplayTarget,
): void {
  if (rows.length === 0) return;
  const content = buildNotificationToastContent(rows);
  void target
    .showNotification(content.title, content.body, content.payload)
    .catch(() => {
      // The feed remains authoritative; a failed native toast is non-critical.
    });
  target.playChime();
}

export function displayHostChannelEmission(
  entries: ReadonlyArray<HostNotificationEntryV11>,
  target: NotificationDisplayTarget,
): void {
  displayNotificationRows(entries.map(rowFromHostEntry), target);
}

export function displayAppLocalNotification(
  entry: AppLocalNotificationEntry,
  target: NotificationDisplayTarget,
): void {
  displayNotificationRows([rowFromAppLocalEntry(entry)], target);
}

export function playNotificationChime(): void {
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

function buildNotificationToastContent(
  rows: ReadonlyArray<MergedNotificationRow>,
): {
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
  return {
    title: "Traycer",
    body: `${rows.length} new notifications`,
    payload: first.payload,
  };
}
