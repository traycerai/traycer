import type { CanvasZoomGesture } from "@/lib/sandbox/canvas-bridge";
import type {
  CanvasPageError,
  CanvasElement,
  CanvasTextSelection,
} from "@/lib/sandbox/canvas-bridge";
import {
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
  type RefObject,
} from "react";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { getClientAppVersionLabel } from "@/lib/app-version";
import { readCssVar } from "@/lib/css-color";
import { getResolvedTheme, subscribeResolvedTheme } from "@/lib/theme-applier";
import { isMac } from "@/lib/keybindings/platform";
import { useOpenLink } from "@/lib/links/open-link";
import { isMobileApp } from "@/lib/mobile-app";
import {
  SANDBOX_SCROLL_GESTURE_EVENT,
  SandboxBridgeHost,
  type SandboxAppRequestHandler,
  type SandboxDisplayMode,
  type SandboxHostContext,
  type SandboxKind,
  type SandboxScrollDirection,
  type SandboxWheel,
  type SandboxShortcutPress,
  type SandboxSize,
  type SandboxStatus,
} from "@/lib/sandbox/bridge-host";
import {
  sandboxForwardedShortcuts,
  type ForwardedShortcut,
} from "@/lib/sandbox/forwarded-shortcuts";
import { useFullscreenBlocker } from "@/lib/sandbox/overlay-owner";
import {
  artifactContentPolicy,
  mcpAppContentPolicy,
  pageContentPolicy,
  type McpAppCsp,
  type SandboxNetworkPolicy,
} from "@/lib/sandbox/mcp-csp";
import {
  sandboxAllowAttribute,
  sandboxLoaderBaseUrl,
  sandboxLoaderUrl,
  type SandboxPermission,
} from "@/lib/sandbox/sandbox-url";
import { sandboxTheme, type SandboxTheme } from "@/lib/sandbox/theme-map";
import { resolveDesktopPlatform } from "@/lib/windows/desktop-capabilities";
import { cn } from "@/lib/utils";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useThemeRevision } from "@/providers/use-theme-revision";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import {
  ArtifactServer,
  buildArtifactAddress,
  type ArtifactManifest,
  type ArtifactReadSpan,
  type ArtifactOutsideReferenceResolver,
} from "@/lib/sandbox/artifact-serving";
import { mountArtifact } from "@/lib/sandbox/artifact-serving/mount-registry";
import { SandboxLinkConfirm } from "./sandbox-link-confirm";

export type SandboxSource =
  | { readonly kind: "html"; readonly html: string }
  | {
      readonly kind: "artifact";
      readonly canvas?: boolean;
      /** Plain HTML keeps ordinary page links and starts with selection off. */
      readonly canvasLinks?: "native";
      readonly artifactId: string;
      /** POSIX path from the artifacts tree root; empty for a top-level artifact. */
      readonly treePath: string;
      /** Manifest path of the document to open, including loose HTML files. */
      readonly entryPath: string;
      readonly manifest: ArtifactManifest;
      readonly readSpan: ArtifactReadSpan;
      readonly resolveOutsideReference: ArtifactOutsideReferenceResolver;
    };

function sameSource(previous: SandboxSource, next: SandboxSource): boolean {
  if (previous.kind === "html")
    return next.kind === "html" && previous.html === next.html;
  return (
    next.kind === "artifact" &&
    previous.artifactId === next.artifactId &&
    previous.treePath === next.treePath &&
    previous.entryPath === next.entryPath &&
    previous.canvas === next.canvas &&
    previous.canvasLinks === next.canvasLinks &&
    previous.manifest === next.manifest &&
    previous.readSpan === next.readSpan &&
    previous.resolveOutsideReference === next.resolveOutsideReference
  );
}

/**
 * Moves a served plain-html artifact between its pages inside the same frame.
 * Paths are relative to the artifact's folder.
 */
export interface SandboxPageNavigation {
  /** The page to show; the frame loads it when it is not already showing. */
  readonly path: string;
  /**
   * Bumped by each Back or Home, so asking again for the page the frame last
   * showed still reloads it after the frame wandered off to a missing page.
   */
  readonly visit: number;
  /** The frame now shows this page, whoever moved it there. */
  readonly onNavigate: (path: string) => void;
  readonly onPageMissing: () => void;
}

/** A page path relative to `treePath`, `../` included, as a tree path. */
function pageTreePath(treePath: string, path: string): string {
  const segments = treePath === "" ? [] : treePath.split("/");
  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

interface ServedFrame {
  readonly generation: number;
  readonly url: string;
  /** The mount's address for another page of the same artifact. */
  readonly pageUrl: (path: string) => string;
  readonly nonce: string;
  readonly theme: SandboxTheme;
  readonly forwardedShortcuts: readonly ForwardedShortcut[];
}

interface SandboxFrameState {
  readonly source: SandboxSource;
  readonly content: string;
  readonly runnerHost: IRunnerHost | null;
  readonly generation: number;
}

/** The next frame state, or `null` while the mounted one still matches. An
 * equivalent replacement source keeps the generation, so the mounted document
 * is retained rather than reloaded. */
function advanceFrameState(
  frame: SandboxFrameState,
  next: Omit<SandboxFrameState, "generation">,
  sourceEquivalent: SandboxFrameProps["sourceEquivalent"],
): SandboxFrameState | null {
  if (
    sameSource(frame.source, next.source) &&
    frame.content === next.content &&
    frame.runnerHost === next.runnerHost
  )
    return null;
  const adopted =
    frame.content === next.content &&
    frame.runnerHost === next.runnerHost &&
    sourceEquivalent?.(frame.source, next.source) === true;
  return {
    ...next,
    generation: adopted ? frame.generation : frame.generation + 1,
  };
}

function currentServedFrame(
  source: SandboxSource,
  frame: ServedFrame | null,
  generation: number,
): ServedFrame | null {
  return source.kind === "artifact" && frame?.generation === generation
    ? frame
    : null;
}

function artifactUnavailable(
  source: SandboxSource,
  runnerHost: IRunnerHost | null,
): boolean {
  return (
    source.kind === "artifact" &&
    (runnerHost === null || runnerHost.sandboxArtifacts === null)
  );
}

export interface SandboxFrameProps {
  readonly onHtmlZoom?: (scale: number) => void;
  readonly onCanvasZoom?: (gesture: CanvasZoomGesture) => void;
  readonly onDoubleClick?: (element: CanvasElement) => void;
  readonly onTextSelection?: (selection: CanvasTextSelection | null) => void;
  readonly onPageError?: (error: CanvasPageError) => void;
  readonly onRelativeLink?: (href: string) => void;
  readonly source: SandboxSource;
  readonly kind: SandboxKind;
  readonly title: string;
  /** An MCP App's server, which the link confirm names; `null` otherwise. */
  readonly appName: string | null;
  readonly networkPolicy: SandboxNetworkPolicy;
  /** An MCP App's normalized CSP; ignored for pages and wireframes. */
  readonly appCsp: McpAppCsp | null;
  readonly permissions: readonly SandboxPermission[];
  /** `null` for pages and wireframes. */
  readonly appRequests: SandboxAppRequestHandler | null;
  readonly className: string;
  /** The frame's height in px, or `null` to fill its container. */
  readonly height: number | null;
  readonly onSize: (size: SandboxSize) => void;
  readonly onStatus: (status: SandboxStatus) => void;
  readonly onRequestTeardown: () => void;
  /** An MCP App's mode; pages and wireframes are always `"inline"`. */
  readonly displayMode: SandboxDisplayMode;
  /**
   * Hands over each bridge as it is created, and `null` once it is gone: an
   * MCP App row sends its tool notifications and its teardown through it.
   */
  readonly onBridge: ((bridge: SandboxBridgeHost | null) => void) | null;
  /** A served plain-html artifact's pages; `null` for everything else. */
  readonly pageNavigation: SandboxPageNavigation | null;
  /**
   * When a replacement source is declared equivalent to the one on screen -
   * the served bytes are unchanged, or the live document already adopted the
   * change in place - the frame keeps its mounted document instead of
   * reloading. The stale server mount is refreshed by the next real change.
   */
  readonly sourceEquivalent?: (
    previous: SandboxSource,
    next: SandboxSource,
  ) => boolean;
  /**
   * Changing this value forces a fresh mount even when the source is
   * equivalent: an adopted document that must reload (a query navigation)
   * needs a server mount built from the CURRENT manifest, not the one the
   * retained document was served from.
   */
  readonly remountKey?: string;
  readonly ref: Ref<HTMLIFrameElement> | null;
}

const NO_PERMISSIONS: readonly SandboxPermission[] = [];

interface FramePolicy {
  /** `false` when an MCP App's declared CSP failed validation. */
  readonly valid: boolean;
  readonly csp: string | null;
}

function hostPlatform(
  runnerHost: IRunnerHost | null,
): SandboxHostContext["platform"] {
  if (runnerHost !== null && resolveDesktopPlatform(runnerHost) !== null) {
    return "desktop";
  }
  return isMobileApp() ? "mobile" : "web";
}

const INLINE_ONLY: readonly SandboxDisplayMode[] = ["inline"];
const APP_DISPLAY_MODES: readonly SandboxDisplayMode[] = [
  "inline",
  "fullscreen",
];

/** The nearest ancestor that scrolls: where a wheel the page gave up goes. */
function scrollContainerOf(element: Element): Element | null {
  const view = element.ownerDocument.defaultView;
  let node = element.parentElement;
  while (node !== null && view !== null) {
    const { overflowY, overflowX } = view.getComputedStyle(node);
    const scrolls =
      (/auto|scroll|overlay/.test(overflowY) &&
        node.scrollHeight > node.clientHeight) ||
      (/auto|scroll|overlay/.test(overflowX) &&
        node.scrollWidth > node.clientWidth);
    if (scrolls) return node;
    node = node.parentElement;
  }
  return element.ownerDocument.scrollingElement;
}

function hostContextFor(
  theme: SandboxTheme,
  platform: SandboxHostContext["platform"],
  kind: SandboxKind,
  displayMode: SandboxDisplayMode,
): SandboxHostContext {
  return {
    theme: theme.colorScheme,
    styles: { variables: theme.variables },
    displayMode,
    availableDisplayModes: kind === "app" ? APP_DISPLAY_MODES : INLINE_ONLY,
    platform,
  };
}

/**
 * Re-dispatch a chord the page forwarded, as if it had been pressed on the
 * frame element: the app's keybinding provider listens on `window` in the
 * capture phase, so the event reaches it exactly like a native keydown.
 */
function replayShortcut(
  iframe: HTMLIFrameElement,
  press: SandboxShortcutPress,
) {
  iframe.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: press.key,
      code: press.code,
      ctrlKey: press.ctrl,
      metaKey: press.meta,
      altKey: press.alt,
      shiftKey: press.shift,
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );
}

/**
 * The same iframe moves to the page asked for, under the same mount and
 * bridge: the bridge takes the next load as a page change.
 */
function useServedPage(
  frameRef: RefObject<HTMLIFrameElement | null>,
  showingPageRef: RefObject<string | null>,
  served: ServedFrame | null,
  pageNavigation: SandboxPageNavigation | null,
): void {
  const path = pageNavigation?.path ?? null;
  const visit = pageNavigation?.visit ?? 0;
  useLayoutEffect(() => {
    const iframe = frameRef.current;
    if (served === null || path === null || iframe === null) return;
    if (path === showingPageRef.current) return;
    showingPageRef.current = path;
    iframe.src = served.pageUrl(path);
  }, [frameRef, showingPageRef, served, path, visit]);
}

/**
 * The one frame every agent page, wireframe and MCP App renders in (D12).
 *
 * HTML sources use the bundled loader; artifacts use a registered document
 * URL. Both stay opaque (`sandbox="allow-scripts allow-forms"`, never
 * `allow-same-origin`) and share the bridge. Borderless and transparent: the page paints the transcript surface
 * itself, so it reads as part of the reply.
 *
 * A change of content (html, kind, policy, permissions) mounts a fresh frame
 * and bridge; a theme change is sent to the live page instead.
 */
export function SandboxFrame(props: SandboxFrameProps) {
  const {
    source,
    kind,
    title,
    networkPolicy,
    appCsp,
    permissions,
    appRequests,
    className,
    height,
    displayMode,
    ref: forwardedRef,
  } = props;
  const runnerHost = useRunnerHostOrNull();
  const artifact = source.kind === "artifact";
  const artifactPolicySource = runnerHost?.sandboxArtifacts
    ? runnerHost.sandboxArtifacts.policySource
    : null;

  const [servedFrame, setServedFrame] = useState<ServedFrame | null>(null);
  const openLink = useOpenLink();
  // Store-backed rather than context-backed: wireframes also render inside
  // editor node views and previews that sit outside the theme provider.
  const resolvedTheme = useSyncExternalStore(
    subscribeResolvedTheme,
    getResolvedTheme,
    getResolvedTheme,
  );
  const themeRevision = useThemeRevision();
  const bindings = useKeybindingStore((s) => s.bindings);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<SandboxBridgeHost | null>(null);
  // The link this frame's page is waiting on the reader for, and how to
  // answer it. The bridge allows one at a time.
  const [confirmUrl, setConfirmUrl] = useState<string | null>(null);
  const settleLinkRef = useRef<((opened: boolean) => void) | null>(null);
  // No app takes fullscreen over the confirm while it is up.
  useFullscreenBlocker(confirmUrl !== null);

  const declared = kind === "app" ? permissions : NO_PERMISSIONS;
  const baseUrl = sandboxLoaderBaseUrl(runnerHost);
  const loaderUrl = sandboxLoaderUrl(baseUrl, declared);
  const platform = hostPlatform(runnerHost);

  const policy = useMemo((): FramePolicy => {
    if (artifact)
      return { valid: true, csp: artifactContentPolicy(artifactPolicySource) };
    if (kind !== "app") {
      return { valid: true, csp: pageContentPolicy(networkPolicy) };
    }
    const result = mcpAppContentPolicy(appCsp);
    return result.kind === "ok"
      ? { valid: true, csp: result.policy }
      : { valid: false, csp: null };
  }, [artifact, artifactPolicySource, kind, networkPolicy, appCsp]);
  const csp = policy.csp;

  const theme = useMemo(() => {
    // The values arrive through the cascade `getComputedStyle` reads, which
    // `theme-applier.ts` has already updated when the revision moves.
    themeRevision;
    return sandboxTheme(artifact ? "page" : kind, resolvedTheme, (token) =>
      readCssVar(document, token),
    );
  }, [artifact, kind, resolvedTheme, themeRevision]);

  const forwardedShortcuts = useMemo(
    () => sandboxForwardedShortcuts(bindings, isMac()),
    [bindings],
  );

  const setRef = useCallback(
    (node: HTMLIFrameElement | null): void => {
      frameRef.current = node;
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef !== null) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef],
  );

  const onDoubleClick = useEffectEvent((element: CanvasElement) =>
    props.onDoubleClick?.(element),
  );
  const onTextSelection = useEffectEvent(
    (selection: CanvasTextSelection | null) =>
      props.onTextSelection?.(selection),
  );
  const onPageError = useEffectEvent((error: CanvasPageError) =>
    props.onPageError?.(error),
  );
  const onRelativeLink = useEffectEvent((href: string) =>
    props.onRelativeLink?.(href),
  );
  const onSize = useEffectEvent((size: SandboxSize) => props.onSize(size));
  const onStatus = useEffectEvent((status: SandboxStatus) =>
    props.onStatus(status),
  );
  // A disposed bridge answers nobody, so its confirm goes with it: a second
  // proxy-ready, a third load or a bad nonce disposes it while the frame stays
  // mounted, and the dialog must not outlive it. The bridge reports this
  // before it frees the app-wide confirm slot.
  const onBridgeStatus = useEffectEvent((status: SandboxStatus) => {
    if (status === "disposed") {
      settleLinkRef.current?.(false);
      settleLinkRef.current = null;
      setConfirmUrl(null);
    }
    props.onStatus(status);
  });
  const onRequestTeardown = useEffectEvent(() => props.onRequestTeardown());
  // The page the iframe is showing, so a page reached by a link is not
  // loaded a second time when the parent catches up with it. `null` once the
  // frame went somewhere that is not a page of the artifact.
  const showingPageRef = useRef<string | null>(null);
  const onPageNavigate = useEffectEvent((path: string) => {
    showingPageRef.current = path;
    props.pageNavigation?.onNavigate(path);
  });
  const onPageMissing = useEffectEvent(() => {
    showingPageRef.current = null;
    props.pageNavigation?.onPageMissing();
  });
  const onBridge = useEffectEvent((bridge: SandboxBridgeHost | null) =>
    props.onBridge?.(bridge),
  );
  const onOpenLink = useEffectEvent(
    (url: string): Promise<boolean> =>
      new Promise((resolve) => {
        settleLinkRef.current = resolve;
        setConfirmUrl(url);
      }),
  );
  const decideLink = (open: boolean): void => {
    const settle = settleLinkRef.current;
    settleLinkRef.current = null;
    if (open && confirmUrl !== null)
      void openLink(confirmUrl, "markdown", null);
    setConfirmUrl(null);
    settle?.(open);
  };
  const onShortcut = useEffectEvent((press: SandboxShortcutPress) => {
    const iframe = frameRef.current;
    if (iframe === null) return;
    if (iframe.ownerDocument.activeElement !== iframe) return;
    replayShortcut(iframe, press);
  });
  const onScrollGesture = useEffectEvent(
    (direction: SandboxScrollDirection) => {
      frameRef.current?.dispatchEvent(
        new CustomEvent(SANDBOX_SCROLL_GESTURE_EVENT, {
          bubbles: true,
          detail: direction,
        }),
      );
    },
  );
  // The gesture is published before the scroll, so the container's follow
  // logic reads the move as the reader's and never corrects it back.
  const onWheel = useEffectEvent((wheel: SandboxWheel) => {
    const iframe = frameRef.current;
    if (iframe === null) return;
    if (wheel.deltaY !== 0) {
      onScrollGesture(wheel.deltaY > 0 ? "toward-end" : "away-from-end");
    }
    scrollContainerOf(iframe)?.scrollBy({
      left: wheel.deltaX,
      top: wheel.deltaY,
      behavior: "instant",
    });
  });
  const onCanvasZoom = useEffectEvent((gesture: CanvasZoomGesture) =>
    props.onCanvasZoom?.(gesture),
  );
  const onHtmlZoom = useEffectEvent((scale: number) =>
    props.onHtmlZoom?.(scale),
  );
  const initialInputs = useEffectEvent(() => ({
    source,
    kind,
    networkPolicy,
    policy,
    declared,
    theme,
    forwardedShortcuts,
    hostContext: hostContextFor(theme, platform, kind, displayMode),
    appRequests,
    runnerHost,
    pageNavigation: props.pageNavigation,
  }));

  // One frame element per content. Keyed by a generation, not by the content
  // itself, which can be a 25 MiB string.
  const content = `${loaderUrl}\n${kind}\n${networkPolicy}\n${csp ?? ""}\n${props.remountKey ?? ""}`;
  const [frame, setFrame] = useState({
    source,
    content,
    runnerHost,
    generation: 0,
  });
  const advanced = advanceFrameState(
    frame,
    { source, content, runnerHost },
    props.sourceEquivalent,
  );
  if (advanced !== null) setFrame(advanced);
  const frameGeneration = frame.generation;

  useLayoutEffect(() => {
    const inputs = initialInputs();
    if (
      inputs.source.kind !== "artifact" ||
      inputs.runnerHost === null ||
      inputs.runnerHost.sandboxArtifacts === null
    )
      return;
    const nonce = crypto.randomUUID();
    const server = new ArtifactServer({
      treePath: inputs.source.treePath,
      manifest: inputs.source.manifest,
      readSpan: inputs.source.readSpan,
      resolveOutsideReference: inputs.source.resolveOutsideReference,
      document: {
        canvas: inputs.source.canvas,
        canvasLinks: inputs.source.canvasLinks,
        policySource: inputs.runnerHost.sandboxArtifacts.policySource,
        csp: inputs.policy.csp,
        theme: inputs.theme,
        nonce,
        shortcuts: inputs.forwardedShortcuts,
      },
    });
    const mount = mountArtifact(inputs.runnerHost, server);
    const origin = inputs.runnerHost.sandboxArtifacts.artifactOrigin({
      artifactId: inputs.source.artifactId,
      mountId: mount.mountId,
    });
    const { artifactId, treePath } = inputs.source;
    const pageUrl = (path: string): string =>
      buildArtifactAddress({
        origin,
        artifactId,
        mountId: mount.mountId,
        treePath: "",
        // An empty entry path names the folder's index page.
        path: pageTreePath(treePath, path === "" ? "index.html" : path),
      });
    // A remount (new bytes, new theme) keeps the reader on the page they were
    // reading rather than sending them back to the entry page.
    const page = inputs.pageNavigation?.path ?? inputs.source.entryPath;
    showingPageRef.current = page;
    const url = pageUrl(page);
    let active = true;
    void mount.ready.then(
      () => {
        if (active)
          setServedFrame({
            generation: frameGeneration,
            url,
            pageUrl,
            nonce,
            theme: inputs.theme,
            forwardedShortcuts: inputs.forwardedShortcuts,
          });
      },
      () => {
        mount.dispose();
        if (active) onStatus("crashed");
      },
    );
    return () => {
      active = false;
      mount.dispose();
    };
  }, [frameGeneration]);

  const served = currentServedFrame(source, servedFrame, frameGeneration);

  // A layout effect: the listeners must be on before the frame can post its
  // first message or fire its first load, and both are tasks that cannot run
  // between this commit and its layout effects.
  useLayoutEffect(() => {
    const inputs = initialInputs();
    if (!inputs.policy.valid) {
      // An MCP App whose declared CSP fails validation never renders.
      onStatus("crashed");
      return;
    }
    if (inputs.source.kind === "artifact" && served === null) return;
    const iframe = frameRef.current;
    const win = iframe?.ownerDocument.defaultView ?? null;
    if (iframe === null || win === null) return;
    const bridge = new SandboxBridgeHost({
      document:
        inputs.source.kind === "artifact"
          ? {
              kind: "served",
              canvas: inputs.source.canvas,
              nonce: served?.nonce ?? "",
              forwardedShortcuts: served?.forwardedShortcuts ?? [],
              pages:
                inputs.pageNavigation === null
                  ? null
                  : {
                      treePath: inputs.source.treePath,
                      onNavigate: onPageNavigate,
                      onPageMissing,
                    },
            }
          : {
              kind: "loader",
              nonce: crypto.randomUUID(),
              resource: {
                html: inputs.source.html,
                kind: inputs.kind,
                networkPolicy: inputs.networkPolicy,
                csp: inputs.policy.csp,
                permissions: inputs.declared,
                theme: inputs.theme,
                forwardedShortcuts: inputs.forwardedShortcuts,
              },
            },
      hostContext:
        served === null
          ? inputs.hostContext
          : {
              ...inputs.hostContext,
              theme: served.theme.colorScheme,
              styles: { variables: served.theme.variables },
            },
      hostVersion: getClientAppVersionLabel(),
      post: (message) => iframe.contentWindow?.postMessage(message, "*"),
      events: {
        onHtmlZoom,
        onCanvasZoom,
        onDoubleClick,
        onTextSelection,
        onPageError,
        onRelativeLink,
        onStatus: onBridgeStatus,
        onSize,
        onOpenLink,
        onShortcut,
        onRequestTeardown,
        onScrollGesture,
        onWheel,
      },
      appRequests: inputs.appRequests,
    });
    bridgeRef.current = bridge;
    onBridge(bridge);
    const handleMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== iframe.contentWindow) return;
      bridge.receive(event.data);
    };
    const handleLoad = (): void => bridge.frameLoaded();
    win.addEventListener("message", handleMessage);
    iframe.addEventListener("load", handleLoad);
    return () => {
      win.removeEventListener("message", handleMessage);
      iframe.removeEventListener("load", handleLoad);
      bridge.dispose();
      if (bridgeRef.current === bridge) bridgeRef.current = null;
      onBridge(null);
    };
  }, [frameGeneration, served]);

  useServedPage(frameRef, showingPageRef, served, props.pageNavigation);

  useLayoutEffect(() => {
    bridgeRef.current?.updateHostContext(
      hostContextFor(theme, platform, kind, displayMode),
    );
  }, [theme, platform, kind, displayMode, served]);

  if (!policy.valid) return null;
  if (artifactUnavailable(source, runnerHost)) {
    return (
      <div className={cn("text-muted-foreground", className)}>
        This artifact opens in the desktop app.
      </div>
    );
  }
  if (artifact && served === null) return null;

  return (
    <>
      <iframe
        // A reused frame would keep the old document's load count and its
        // policy container.
        key={frameGeneration}
        ref={setRef}
        title={title}
        src={served?.url ?? loaderUrl}
        sandbox="allow-scripts allow-forms"
        allow={sandboxAllowAttribute(declared)}
        referrerPolicy="no-referrer"
        className={cn(
          "block w-full border-0 bg-transparent",
          height === null && "h-full",
          className,
        )}
        style={{ height: height ?? undefined }}
      />
      <SandboxLinkConfirm
        url={confirmUrl}
        kind={kind}
        appName={props.appName}
        onDecide={decideLink}
      />
    </>
  );
}
