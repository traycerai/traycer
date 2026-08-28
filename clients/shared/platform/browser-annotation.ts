import type {
  BrowserAnnotationCounts,
  BrowserAnnotationRecord,
} from "@traycer/protocol/persistence/epic/schemas";

export interface BrowserViewTileKey {
  readonly viewTabId: string;
  readonly paneId: string;
  readonly tileInstanceId: string;
  readonly pageSessionId: string;
}

export interface BrowserAnnotationTheme {
  readonly appearance: "light" | "dark";
  readonly background: string;
  readonly foreground: string;
  readonly popover: string;
  readonly popoverForeground: string;
  readonly mutedForeground: string;
  readonly border: string;
  readonly input: string;
  readonly ring: string;
  readonly primary: string;
  readonly primaryForeground: string;
  readonly accent: string;
  readonly accentForeground: string;
  readonly destructive: string;
  readonly warning: string;
  readonly warningForeground: string;
  readonly fontFamily: string;
}

export interface BrowserAnnotationStartInput extends BrowserViewTileKey {
  readonly theme: BrowserAnnotationTheme;
}

export type BrowserAnnotationMode = "select" | "region" | "draw" | "erase";

export type BrowserAnnotationAttachPayload = Omit<
  BrowserAnnotationRecord,
  "kind" | "imageFileName" | "imageHash"
>;

export interface BrowserAnnotationAttachedIpcEvent extends BrowserViewTileKey {
  readonly targetChatId: string;
  readonly payload: BrowserAnnotationAttachPayload;
  readonly pngBytes: Uint8Array<ArrayBuffer>;
}

export interface BrowserAnnotationTargetOption {
  readonly chatId: string;
  readonly label: string;
}

export interface BrowserAnnotationSetTargetChatLabelInput extends BrowserViewTileKey {
  readonly targets: readonly BrowserAnnotationTargetOption[];
  readonly defaultChatId: string | null;
}

export interface BrowserAnnotationAttachResultInput {
  readonly annotationId: string;
  readonly status: "attached" | "failed";
}

export type BrowserAnnotationEndReason =
  | "cancelled"
  | "navigation"
  | "reload"
  | "crash"
  | "tile-close"
  | "replaced";

export type BrowserAnnotationStartFailureReason =
  | "tile-not-found"
  | "page-not-ready"
  | "debugger-not-attached"
  | "no-main-frame"
  | "no-isolated-world"
  | "inject-failed";

export type BrowserAnnotationStartResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: BrowserAnnotationStartFailureReason;
    };

/**
 * `attachRequested` is deliberately absent: it carries marks captured by the
 * CDP-injected guest overlay and never crosses into this forwarded IPC event
 * (`desktop`'s `BrowserAnnotationSessionEvent` adds it back for the
 * desktop-main-only path).
 */
export type BrowserAnnotationForwardedSessionEvent =
  | {
      readonly type: "stateChanged";
      readonly mode: BrowserAnnotationMode;
      readonly markCount: number;
    }
  | { readonly type: "cancelled" }
  | {
      readonly type: "ended";
      readonly reason: Exclude<BrowserAnnotationEndReason, "cancelled">;
    };

export interface BrowserAnnotationSessionIpcEvent extends BrowserViewTileKey {
  readonly event: BrowserAnnotationForwardedSessionEvent;
}

export type { BrowserAnnotationCounts };
