import type {
  BrowserAnnotationCounts,
  BrowserAnnotationRecord,
  BrowserViewElementCapture,
} from "@traycer/protocol/persistence/epic/schemas";

export interface BrowserViewTileKey {
  readonly viewTabId: string;
  readonly paneId: string;
  readonly tileInstanceId: string;
  readonly pageSessionId: string;
}

export type BrowserAnnotationMode = "select" | "region" | "draw" | "erase";

export type BrowserAnnotationMarkKind = "element" | "region" | "stroke";

export interface BrowserAnnotationCssRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserAnnotationMarkSnapshot {
  readonly id: string;
  readonly kind: BrowserAnnotationMarkKind;
  readonly bounds: BrowserAnnotationCssRect;
  readonly selector: string | null;
}

export interface BrowserAnnotationAttachRequest {
  readonly targetChatId: string;
  readonly marks: readonly BrowserAnnotationMarkSnapshot[];
  readonly elements: readonly BrowserViewElementCapture[];
  readonly comment: string;
  readonly unionRect: BrowserAnnotationCssRect;
}

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

export type BrowserAnnotationSessionEvent =
  | {
      readonly type: "stateChanged";
      readonly mode: BrowserAnnotationMode;
      readonly markCount: number;
    }
  | { readonly type: "cancelled" }
  | {
      readonly type: "attachRequested";
      readonly payload: BrowserAnnotationAttachRequest;
    }
  | {
      readonly type: "ended";
      readonly reason: Exclude<BrowserAnnotationEndReason, "cancelled">;
    };

export type BrowserAnnotationForwardedSessionEvent = Exclude<
  BrowserAnnotationSessionEvent,
  { readonly type: "attachRequested" }
>;

export interface BrowserAnnotationSessionIpcEvent extends BrowserViewTileKey {
  readonly event: BrowserAnnotationForwardedSessionEvent;
}

export type { BrowserAnnotationCounts };
