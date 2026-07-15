import type { NotificationShow } from "@/hooks/notifications/use-notifications";
import { createElement } from "react";
import { toast } from "sonner";
import {
  rowFromAppLocalEntry,
  rowFromHostEntry,
  type MergedNotificationRow,
} from "@/stores/notifications/merged-notifications";
import type { AppLocalNotificationEntry } from "@/stores/notifications/app-local-notifications-store";
import type { HostNotificationEntry } from "@traycer/protocol/host/notifications/contracts";

export interface NotificationDisplayTarget {
  readonly showNotification: NotificationShow;
  readonly playChime: () => void;
  readonly onToastClick: (row: MergedNotificationRow) => void;
}

export function displayNotificationRows(
  rows: ReadonlyArray<MergedNotificationRow>,
  target: NotificationDisplayTarget,
): void {
  if (rows.length === 0) return;
  const content = buildNotificationToastContent(rows);
  try {
    void target
      .showNotification(
        content.title,
        content.body,
        content.payload,
        content.replaceKey,
      )
      .catch(() => {
        // The feed remains authoritative; a failed native toast is non-critical.
      });
  } catch {
    // The feed remains authoritative; a failed native toast is non-critical.
  }
  if (content.row.payload === null) {
    toast(content.title, {
      description: content.body,
      id: content.replaceKey,
    });
  } else {
    toast.custom(
      (id) =>
        createElement(
          "div",
          {
            className:
              "flex w-[var(--width)] items-start gap-2 rounded-[var(--radius)] border border-border bg-popover p-4 text-popover-foreground shadow-md",
          },
          createElement(
            "button",
            {
              type: "button",
              className: "min-w-0 flex-1 text-left",
              onClick: () => target.onToastClick(content.row),
            },
            createElement(
              "div",
              { className: "font-medium leading-normal" },
              content.title,
            ),
            createElement(
              "div",
              {
                className: "mt-0.5 text-sm leading-snug text-muted-foreground",
              },
              content.body,
            ),
          ),
          createElement(
            "button",
            {
              type: "button",
              "aria-label": "Close toast",
              className: "text-muted-foreground hover:text-foreground",
              onClick: () => toast.dismiss(id),
            },
            "×",
          ),
        ),
      { id: content.replaceKey },
    );
  }
  target.playChime();
}

export function displayHostChannelEmission(
  entries: ReadonlyArray<HostNotificationEntry>,
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
  readonly row: MergedNotificationRow;
  readonly payload: unknown;
  readonly replaceKey: string;
} {
  const first = rows[0];
  if (rows.length === 1) {
    return {
      title: first.title,
      body: first.body,
      row: first,
      payload: first.payload,
      replaceKey: notificationReplaceKey(first),
    };
  }
  return {
    title: "Traycer",
    body: `${rows.length} new notifications`,
    row: first,
    payload: first.payload,
    replaceKey: "notification-batch",
  };
}

export function notificationReplaceKey(row: MergedNotificationRow): string {
  if (row.source === "app-local") return row.sourceId;
  return hostEntityReplaceKey(row.payload) ?? `host:id:${row.sourceId}`;
}

function hostEntityReplaceKey(
  payload: MergedNotificationRow["payload"],
): string | null {
  if (payload === null) return null;

  switch (payload.kind) {
    case "approval":
    case "chat":
      return chatOrEpicReplaceKey(payload.chatId, payload.epicId);
    case "interview":
      return `host:chat:${payload.chatId}`;
    case "artifact":
    case "epic":
      return epicReplaceKey(payload.epicId);
    case "session":
      return null;
  }
}

function chatOrEpicReplaceKey(
  chatId: string | undefined,
  epicId: string | undefined,
): string | null {
  if (chatId !== undefined) return `host:chat:${chatId}`;
  return epicReplaceKey(epicId);
}

function epicReplaceKey(epicId: string | undefined): string | null {
  return epicId === undefined ? null : `host:epic:${epicId}`;
}
