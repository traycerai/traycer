import type { BrowserAnnotationForwardedSessionEvent } from "@traycer-clients/shared/platform/browser-annotation";
import type { BrowserViewElementCapture } from "@traycer-clients/shared/platform/browser-view";

export type {
  BrowserAnnotationAttachedIpcEvent,
  BrowserAnnotationAttachPayload,
  BrowserAnnotationAttachResultInput,
  BrowserAnnotationCounts,
  BrowserAnnotationEndReason,
  BrowserAnnotationForwardedSessionEvent,
  BrowserAnnotationMode,
  BrowserAnnotationSessionIpcEvent,
  BrowserAnnotationSetTargetChatLabelInput,
  BrowserAnnotationStartInput,
  BrowserAnnotationStartFailureReason,
  BrowserAnnotationStartResult,
  BrowserAnnotationTheme,
  BrowserAnnotationTargetOption,
} from "@traycer-clients/shared/platform/browser-annotation";

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

/**
 * The full session event vocabulary. `attachRequested` never crosses into the
 * forwarded IPC event (`BrowserAnnotationForwardedSessionEvent`) - it carries
 * marks captured by the CDP-injected guest overlay, which only desktop-main
 * consumes on its way to building the attach payload.
 */
export type BrowserAnnotationSessionEvent =
  | BrowserAnnotationForwardedSessionEvent
  | {
      readonly type: "attachRequested";
      readonly payload: BrowserAnnotationAttachRequest;
    };
