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
  readonly ratioLocked: boolean;
  readonly ratio: number | null;
  readonly resizeScale: number;
  readonly resizeFromCenter: () => boolean;
  readonly setRatio: (ratio: number) => void;
  readonly fitOwnedHere: boolean;
  readonly open: () => void;
  readonly reset: () => Promise<void>;
  readonly resize: (width: number, height: number) => Promise<void>;
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
  } | null;
  readonly paintedSize: {
    readonly width: number;
    readonly height: number;
  } | null;
  readonly claim: () => void;
  readonly onInteraction: (event: SyntheticEvent) => void;
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
}): BrowserViewportPresentation {
  const sessions = useMaybeBrowserSessionsContext();
  const coordinatorKey = useMaybeBrowserSessionsCoordinatorKey();
  const observed = sessions?.viewports[input.tabId];
  const state = observed?.sessionId === input.sessionId ? observed : null;
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
  const [ratio, setRatio] = useState<number | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [failure, setFailure] = useState<{
    error: Error;
    revision: number;
    connectionGeneration: number;
  } | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const geometryRef = useRef<BrowserViewportGeometry | null>(null);
  const actionRevision = useRef(0);
  const report = sessions?.reportViewport;
  const supported = state !== null;
  const connectionGeneration = sessions?.connectionGeneration;
  const lifecycle = sessions?.lifecycle;
  const canChange = !input.disabled && lifecycle === "live";
  const expanded = opened || state?.intent.mode === "fixed";

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
          claim: false,
        });
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
    mutationFn: async (intent: BrowserViewportIntent): Promise<void> => {
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
      await sessions.setViewport(input.sessionId, input.tabId, intent);
    },
    onError: (error) => {
      // Rollback can publish before the RPC rejects. Anchor the failure to
      // that confirmed state, rather than hiding it against its own rollback.
      const current =
        browserSessionsCoordinatorState(coordinatorKey) ?? sessions;
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
  const resize = async (width: number, height: number): Promise<void> => {
    actionRevision.current += 1;
    claim();
    await mutation.mutateAsync({ mode: "fixed", width, height });
  };
  const reset = async (): Promise<void> => {
    const revision = ++actionRevision.current;
    claim();
    await mutation.mutateAsync({ mode: "fit" });
    if (actionRevision.current !== revision) return;
    setPreviewScale(null);
    setOpened(false);
    triggerRef.current?.focus();
  };
  const open = (): void => {
    if (state === null || expanded || !canChange) return;
    const revision = ++actionRevision.current;
    claim();
    // The native apply path preserves annotations before the row can reflow Fit.
    void mutation
      .mutateAsync(state.intent)
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
  const { size, scale, fitOwnedHere, guestViewport, paintedSize } =
    viewportLayout({
      state,
      area,
      pageZoom: input.pageZoom,
      native: input.native,
      viewerId,
      expanded,
      previewScaleSetting,
    });
  return {
    areaRef,
    scrollRef,
    claim,
    onInteraction,
    guestViewport,
    paintedSize,
    controller: {
      state,
      size,
      expanded,
      pending: mutation.isPending,
      disabled: !canChange,
      error:
        failure !== null &&
        failure.error === mutation.error &&
        failure.revision === state.revision &&
        failure.connectionGeneration === connectionGeneration
          ? failure.error.message
          : null,
      dismissError: () => setFailure(null),
      previewScale: scale,
      previewScaleSetting,
      setPreviewScale,
      ratioLocked: ratio !== null,
      ratio,
      resizeScale: scale * input.pageZoom,
      resizeFromCenter: () =>
        paintedSize === null ||
        paintedSize.width <=
          (scrollRef.current?.clientWidth ?? area.width + 48) - 48,
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

function viewportLayout(input: {
  readonly state: BrowserViewportState;
  readonly area: { readonly width: number; readonly height: number };
  readonly pageZoom: number;
  readonly native: boolean;
  readonly viewerId: string;
  readonly expanded: boolean;
  readonly previewScaleSetting: number | null;
}): {
  readonly size: BrowserViewportController["size"];
  readonly scale: number;
  readonly fitOwnedHere: boolean;
  readonly guestViewport: BrowserViewportPresentation["guestViewport"];
  readonly paintedSize: BrowserViewportPresentation["paintedSize"];
} {
  const { state, area } = input;
  const size =
    state.applied ?? (state.intent.mode === "fixed" ? state.intent : null);
  const intrinsic =
    size === null
      ? null
      : {
          width: size.width * input.pageZoom,
          height: size.height * input.pageZoom,
        };
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
    fitOwnedHere,
    guestViewport: null,
    paintedSize: null,
  };
  if (
    input.native &&
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
    },
    paintedSize: {
      width: intrinsic.width * scale,
      height: intrinsic.height * scale,
    },
  };
}
