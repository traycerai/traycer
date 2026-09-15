import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { toHostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { BrowserViewGuestViewportRequested } from "@traycer-clients/shared/platform/browser-view";
import {
  browserViewportSizeSchema,
  type BrowserViewportGeometry,
  type BrowserViewportIntent,
  type BrowserViewportState,
} from "@traycer/protocol/host/browser/viewport";
import {
  useMaybeBrowserSessionsContext,
  useMaybeBrowserSessionsCoordinatorKey,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import { browserSessionsCoordinatorState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { browserMutationKeys } from "@/lib/query-keys/browser-mutation-keys";
import {
  browserTabId,
  subscribeBrowserTabId,
} from "@/lib/browser-tab-identity";
import { useDesktopWindowId } from "@/lib/windows/desktop-window-id";
import { toastFromHostError } from "@/lib/host-error-toast";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";
import {
  confirmBrowserGuestViewport,
  readBrowserGuestViewport,
  subscribeBrowserGuestViewport,
  type BrowserGuestViewportPresentation,
} from "@/lib/browser-view/guest/persistent-browser-guest-host";
import type { BrowserViewDeviceProfile } from "@traycer-clients/shared/platform/browser-device-profiles";

export interface BrowserViewportOrigin {
  readonly x: number;
  readonly anchor: 0 | 0.5 | 1;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly availableWidth: number;
  readonly availableHeight: number;
}

export interface BrowserViewportController {
  readonly state: BrowserViewportState;
  readonly size: { readonly width: number; readonly height: number } | null;
  readonly expanded: boolean;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly dismissError: () => void;
  readonly previewScale: number;
  readonly previewScaleSetting: number | null;
  readonly setPreviewScale: (scale: number | null) => void;
  readonly previewOrigin: BrowserViewportOrigin | null;
  readonly ratioLocked: boolean;
  readonly ratio: number | null;
  readonly resizeScale: number;
  readonly setRatio: (ratio: number) => void;
  readonly fitOwnedHere: boolean;
  readonly open: () => void;
  /**
   * Tells this tile's page what device it is being shown as, or `null` for this
   * machine's own ratio and pointer. Absent where there is no local guest to
   * emulate - a screencast tile's page runs elsewhere.
   *
   * Separate from {@link resize} because the two travel different roads: size is
   * viewport INTENT that main persists per tab, while this is a live override on
   * one guest's webContents that dies with it.
   */
  readonly emulateDevice:
    | ((profile: BrowserViewDeviceProfile | null) => Promise<void>)
    | null;
  /**
   * The native guest currently behind this tile, or `null` where there is none.
   *
   * Exposed because a device override belongs to ONE webContents: a consumer that
   * remembers what it already applied has to notice when the guest underneath is
   * replaced, which the size alone does not reveal.
   */
  readonly guestRegistrationId: string | null;
  readonly reset: () => Promise<void>;
  readonly resize: (
    width: number,
    height: number,
    origin: BrowserViewportOrigin | null,
  ) => Promise<void>;
  readonly setRatioLocked: (locked: boolean) => void;
  readonly claim: () => void;
  readonly setTrigger: (element: HTMLButtonElement | null) => void;
}

export interface BrowserViewportPresentation {
  readonly controller: BrowserViewportController | null;
  readonly areaRef: RefObject<HTMLDivElement | null>;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly guestViewport: {
    readonly width: number;
    readonly height: number;
    readonly scale: number;
    readonly autoFit: boolean;
    readonly requestId: string | null;
  } | null;
  readonly paintedSize: {
    readonly width: number;
    readonly height: number;
  } | null;
  readonly claim: () => void;
  readonly onInteraction: (event: SyntheticEvent) => void;
}

interface ViewportFailure {
  readonly error: Error;
  readonly revision: number;
  readonly connectionGeneration: number;
}

/** The host owns layout; this hook owns only this surface's presentation. */
export function useBrowserViewport(input: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly instanceId: string;
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly pageZoom: number;
  readonly native: boolean;
  /**
   * Applies a device character to this tile's guest, where there is one. Passed
   * in rather than issued here: the desktop control channel belongs to the tile,
   * and a placement with no local guest supplies nothing.
   */
  readonly emulateDevice:
    | ((profile: BrowserViewDeviceProfile | null) => Promise<void>)
    | null;
  readonly registrationId: string | null;
}): BrowserViewportPresentation {
  const sessions = useMaybeBrowserSessionsContext();
  const coordinatorKey = useMaybeBrowserSessionsCoordinatorKey();
  const observed = sessions?.viewports[input.tabId];
  const state = observed?.sessionId === input.sessionId ? observed : null;
  const nativeViewport = useNativeViewportPresentation(
    input.registrationId,
    state,
    input.pageZoom,
  );
  const paneFocused = usePaneFocused();
  const desktopWindowId = useDesktopWindowId();
  const readWindowId = useCallback(
    () => desktopWindowId ?? browserTabId(),
    [desktopWindowId],
  );
  const windowId = useSyncExternalStore(subscribeBrowserTabId, readWindowId);
  // Native binding recovery remounts the surface; placement and window survive.
  const viewerId = JSON.stringify([windowId, input.instanceId]);
  const [opened, setOpened] = useState(false);
  const [previewScaleSetting, setPreviewScale] = useState<number | null>(null);
  const [previewOrigin, setPreviewOrigin] =
    useState<BrowserViewportOrigin | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [failure, setFailure] = useState<ViewportFailure | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const geometryRef = useRef<BrowserViewportGeometry | null>(null);
  const actionRevision = useRef(0);
  const activationPending = useRef(false);
  const report = sessions?.reportViewport;
  const supported = state !== null;
  const connectionGeneration = sessions?.connectionGeneration;
  const lifecycle = sessions?.lifecycle;
  const canChange = !input.disabled && lifecycle === "live";
  const { expanded, nativePending, resetPreferences, clearAgentOrigin } =
    viewportControlState(state, nativeViewport, {
      opened,
      scale: previewScaleSetting,
      origin: previewOrigin,
    });

  // Preview preferences belong to the responsive controls' lifetime, including
  // when another viewer or agent exits that mode. Reset before children paint.
  if (resetPreferences) {
    setPreviewScale(null);
    setPreviewOrigin(null);
  }

  useEffect(() => {
    // Activation can precede the first nonzero measurement. Keep it pending
    // across geometry changes without treating those changes as new activity.
    activationPending.current =
      input.visible && paneFocused && document.hasFocus();
  }, [input.visible, paneFocused, viewerId]);

  useEffect(() => {
    const element = areaRef.current;
    if (element === null || !input.visible) return;
    // Local to this subscription: reconnect and ownership/lifecycle changes
    // still resend, but ResizeObserver's initial delivery need not repeat it.
    let lastReported: BrowserViewportGeometry | null = null;
    const measure = (): void => {
      const width = element.clientWidth - (expanded ? 48 : 0);
      const height = element.clientHeight - (expanded ? 48 : 0);
      if (width <= 0 || height <= 0) return;
      setArea((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
      const geometry = {
        width: Math.max(1, Math.round(width / input.pageZoom)),
        height: Math.max(1, Math.round(height / input.pageZoom)),
        dpr: Math.min(8, window.devicePixelRatio),
      };
      geometryRef.current = geometry;
      if (
        supported &&
        canChange &&
        (lastReported?.width !== geometry.width ||
          lastReported.height !== geometry.height ||
          lastReported.dpr !== geometry.dpr)
      ) {
        lastReported = geometry;
        report?.({
          sessionId: input.sessionId,
          tabId: input.tabId,
          viewerId,
          geometry,
          claim: activationPending.current && document.hasFocus(),
        });
        activationPending.current = false;
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [
    input.visible,
    input.pageZoom,
    input.sessionId,
    input.tabId,
    report,
    supported,
    viewerId,
    connectionGeneration,
    canChange,
    expanded,
    paneFocused,
  ]);

  const claim = useCallback(() => {
    const geometry = geometryRef.current;
    if (!supported || !canChange || geometry === null || !input.visible) return;
    report?.({
      sessionId: input.sessionId,
      tabId: input.tabId,
      viewerId,
      geometry,
      claim: true,
    });
  }, [
    input.sessionId,
    input.tabId,
    input.visible,
    report,
    supported,
    canChange,
    viewerId,
  ]);

  const mutation = useMutation({
    mutationKey: browserMutationKeys.setViewport(
      input.hostId,
      input.sessionId,
      input.tabId,
    ),
    retry: false,
    mutationFn: async (action: {
      readonly intent: BrowserViewportIntent;
      readonly origin: BrowserViewportOrigin | null;
      readonly revision: number;
      readonly connectionGeneration: number | undefined;
    }): Promise<void> => {
      const { intent } = action;
      if (!canChange)
        throw new Error(
          "Viewport controls are unavailable for this browser view.",
        );
      if (sessions === null || !supported)
        throw new Error("Update this host to change browser dimensions.");
      if (intent.mode === "fixed") {
        const checked = browserViewportSizeSchema.safeParse({
          width: intent.width,
          height: intent.height,
        });
        if (!checked.success)
          throw new Error(
            checked.error.issues[0]?.message ??
              "Enter a supported viewport size.",
          );
      }
      // Invalid drafts must never take Fit ownership or reflow the page.
      setPreviewOrigin(action.origin);
      claim();
      await sessions.setViewport(input.sessionId, input.tabId, intent);
    },
    onError: (error, action) => {
      // Rollback can publish before the RPC rejects. Anchor the failure to
      // that confirmed state, rather than hiding it against its own rollback.
      const current =
        browserSessionsCoordinatorState(coordinatorKey) ?? sessions;
      if (
        action.revision !== actionRevision.current ||
        action.connectionGeneration !== current?.connectionGeneration
      )
        return;
      setFailure({
        error,
        revision: current?.viewports[input.tabId]?.revision ?? 0,
        connectionGeneration: current?.connectionGeneration ?? 0,
      });
      if (!expanded)
        toastFromHostError(
          toHostRpcError(error, "browser.sessions"),
          error.message,
        );
    },
  });
  if (clearAgentOrigin && !mutation.isPending) setPreviewOrigin(null);
  const apply = (
    intent: BrowserViewportIntent,
    origin: BrowserViewportOrigin | null,
  ): Promise<void> =>
    mutation.mutateAsync({
      intent,
      origin,
      revision: ++actionRevision.current,
      connectionGeneration,
    });
  const resize = async (
    width: number,
    height: number,
    origin: BrowserViewportOrigin | null,
  ): Promise<void> => {
    await apply({ mode: "fixed", width, height }, origin);
  };
  const reset = async (): Promise<void> => {
    const applied = apply({ mode: "fit" }, null);
    const revision = actionRevision.current;
    await applied;
    if (actionRevision.current !== revision) return;
    setPreviewScale(null);
    setOpened(false);
    triggerRef.current?.focus();
  };
  const open = (): void => {
    if (state === null || expanded || !canChange) return;
    const applied = apply(state.intent, previewOrigin);
    const revision = actionRevision.current;
    // The native apply path preserves annotations before the row can reflow Fit.
    void applied
      .then(() => {
        if (actionRevision.current === revision) setOpened(true);
      })
      .catch(() => undefined);
  };
  const onInteraction = (event: SyntheticEvent): void => {
    // Toolbar mutations claim when applied. Inspecting presets or changing
    // preview scale must not reflow another viewer's Fit.
    if (
      event.target === scrollRef.current ||
      (event.target instanceof Element &&
        event.target.closest("[data-viewport-controls]") !== null)
    )
      return;
    claim();
  };
  if (state === null)
    return {
      areaRef,
      scrollRef,
      claim,
      onInteraction,
      guestViewport: null,
      paintedSize: null,
      controller: null,
    };
  const { size, scale, resizeScale, fitOwnedHere, guestViewport, paintedSize } =
    viewportLayout({
      state,
      area,
      pageZoom: input.pageZoom,
      native: input.native,
      viewerId,
      expanded,
      previewScaleSetting,
      nativeViewport,
    });
  return {
    areaRef,
    scrollRef,
    claim,
    onInteraction,
    guestViewport,
    paintedSize,
    controller: {
      emulateDevice: input.emulateDevice,
      guestRegistrationId: input.registrationId,
      state:
        nativeViewport === null
          ? state
          : { ...state, intent: nativeViewport.intent },
      size,
      expanded,
      pending: mutation.isPending || nativePending,
      disabled: !canChange,
      error: viewportFailureMessage(
        failure,
        mutation.error,
        state.revision,
        connectionGeneration,
      ),
      dismissError: () => setFailure(null),
      previewScale: scale,
      previewScaleSetting,
      setPreviewScale: (nextScale) => {
        if (nextScale === null) setPreviewOrigin(null);
        setPreviewScale(nextScale);
      },
      previewOrigin,
      ratioLocked: ratio !== null,
      ratio,
      resizeScale,
      setRatio: (nextRatio) => {
        if (ratio !== null) setRatio(nextRatio);
      },
      fitOwnedHere,
      open,
      reset,
      resize,
      setRatioLocked: (locked) =>
        setRatio(locked && size !== null ? size.width / size.height : null),
      claim,
      setTrigger: (element) => {
        triggerRef.current = element;
      },
    },
  };
}

function viewportControlState(
  state: BrowserViewportState | null,
  nativeViewport: BrowserGuestViewportPresentation | null,
  preferences: {
    readonly opened: boolean;
    readonly scale: number | null;
    readonly origin: BrowserViewportOrigin | null;
  },
): {
  readonly expanded: boolean;
  readonly nativePending: boolean;
  readonly resetPreferences: boolean;
  readonly clearAgentOrigin: boolean;
} {
  const expanded =
    preferences.opened ||
    state?.intent.mode === "fixed" ||
    nativeViewport?.intent.mode === "fixed";
  return {
    expanded,
    nativePending: nativeViewport?.confirmed === false,
    resetPreferences:
      !expanded && (preferences.scale !== null || preferences.origin !== null),
    clearAgentOrigin: state?.source === "agent" && preferences.origin !== null,
  };
}

function viewportFailureMessage(
  failure: ViewportFailure | null,
  error: Error | null,
  revision: number,
  connectionGeneration: number | undefined,
): string | null {
  return failure !== null &&
    failure.error === error &&
    failure.revision === revision &&
    failure.connectionGeneration === connectionGeneration
    ? failure.error.message
    : null;
}

function viewportLayout(input: {
  readonly state: BrowserViewportState;
  readonly area: { readonly width: number; readonly height: number };
  readonly pageZoom: number;
  readonly native: boolean;
  readonly viewerId: string;
  readonly expanded: boolean;
  readonly previewScaleSetting: number | null;
  readonly nativeViewport: BrowserViewGuestViewportRequested | null;
}): {
  readonly size: BrowserViewportController["size"];
  readonly scale: number;
  readonly resizeScale: number;
  readonly fitOwnedHere: boolean;
  readonly guestViewport: BrowserViewportPresentation["guestViewport"];
  readonly paintedSize: BrowserViewportPresentation["paintedSize"];
} {
  const { state, area } = input;
  const request = input.nativeViewport;
  const { size, intrinsic, zoom } = viewportDimensions(
    state,
    input.pageZoom,
    request,
  );
  const scale =
    input.previewScaleSetting ??
    (intrinsic === null || area.width === 0 || area.height === 0
      ? 1
      : Math.min(
          1,
          area.width / intrinsic.width,
          area.height / intrinsic.height,
        ));
  const fitOwnedHere =
    state.fitOwnerId === null || state.fitOwnerId === input.viewerId;
  const layout = {
    size,
    scale,
    resizeScale: scale * zoom,
    fitOwnedHere,
    guestViewport: null,
    paintedSize: null,
  };
  if (
    input.native &&
    request === null &&
    state.intent.mode === "fit" &&
    fitOwnedHere &&
    input.previewScaleSetting === null
  ) {
    return { ...layout, paintedSize: input.expanded ? area : null };
  }
  if (intrinsic === null) return layout;
  return {
    ...layout,
    guestViewport: {
      ...intrinsic,
      scale,
      autoFit: input.previewScaleSetting === null,
      requestId: request?.requestId ?? null,
    },
    paintedSize: {
      width: intrinsic.width * scale,
      height: intrinsic.height * scale,
    },
  };
}

function viewportDimensions(
  state: BrowserViewportState,
  zoom: number,
  request: BrowserViewGuestViewportRequested | null,
): {
  readonly size: BrowserViewportController["size"];
  readonly intrinsic: BrowserViewportController["size"];
  readonly zoom: number;
} {
  if (request !== null)
    return {
      size: nativeViewportSize(request),
      intrinsic: { width: request.width, height: request.height },
      zoom: request.zoom,
    };
  const size =
    state.applied ?? (state.intent.mode === "fixed" ? state.intent : null);
  return {
    size,
    intrinsic:
      size === null
        ? null
        : { width: size.width * zoom, height: size.height * zoom },
    zoom,
  };
}

function nativeViewportSize(request: BrowserViewGuestViewportRequested): {
  readonly width: number;
  readonly height: number;
} {
  if (request.intent.mode === "fixed") return request.intent;
  return {
    width: Math.max(1, Math.round(request.width / request.zoom)),
    height: Math.max(1, Math.round(request.height / request.zoom)),
  };
}

function useNativeViewportPresentation(
  registrationId: string | null,
  state: BrowserViewportState | null,
  zoom: number,
): BrowserGuestViewportPresentation | null {
  const request = useSyncExternalStore(subscribeBrowserGuestViewport, () =>
    readBrowserGuestViewport(registrationId),
  );
  useEffect(() => {
    confirmBrowserGuestViewport({ registrationId, state, zoom });
  }, [registrationId, state, zoom, request]);
  return request;
}
