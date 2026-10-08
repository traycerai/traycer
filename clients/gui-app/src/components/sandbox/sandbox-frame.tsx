import {
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { getClientAppVersionLabel } from "@/lib/app-version";
import { readCssVar } from "@/lib/css-color";
import { getResolvedTheme, subscribeResolvedTheme } from "@/lib/theme-applier";
import { isMac } from "@/lib/keybindings/platform";
import { useOpenLink } from "@/lib/links/open-link";
import { isMobileApp } from "@/lib/mobile-app";
import {
  SandboxBridgeHost,
  type SandboxAppRequestHandler,
  type SandboxDisplayMode,
  type SandboxHostContext,
  type SandboxKind,
  type SandboxShortcutPress,
  type SandboxSize,
  type SandboxStatus,
} from "@/lib/sandbox/bridge-host";
import { sandboxForwardedShortcuts } from "@/lib/sandbox/forwarded-shortcuts";
import { useFullscreenBlocker } from "@/lib/sandbox/overlay-owner";
import {
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
import { SandboxLinkConfirm } from "./sandbox-link-confirm";

export interface SandboxFrameProps {
  readonly html: string;
  readonly kind: SandboxKind;
  readonly title: string;
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
 * The one frame every agent page, wireframe and MCP App renders in (D12).
 *
 * The frame loads the bundled sandbox loader on its own origin, opaque
 * (`sandbox="allow-scripts allow-forms"`, never `allow-same-origin`), and the
 * loader writes the resource over itself once {@link SandboxBridgeHost} hands
 * it over. Borderless and transparent: the page paints the transcript surface
 * itself, so it reads as part of the reply.
 *
 * A change of content (html, kind, policy, permissions) mounts a fresh frame
 * and bridge; a theme change is sent to the live page instead.
 */
export function SandboxFrame(props: SandboxFrameProps) {
  const {
    html,
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
    if (kind !== "app") {
      return { valid: true, csp: pageContentPolicy(networkPolicy) };
    }
    const result = mcpAppContentPolicy(appCsp);
    return result.kind === "ok"
      ? { valid: true, csp: result.policy }
      : { valid: false, csp: null };
  }, [kind, networkPolicy, appCsp]);
  const csp = policy.csp;

  const theme = useMemo(() => {
    // The values arrive through the cascade `getComputedStyle` reads, which
    // `theme-applier.ts` has already updated when the revision moves.
    themeRevision;
    return sandboxTheme(kind, resolvedTheme, (token) =>
      readCssVar(document, token),
    );
  }, [kind, resolvedTheme, themeRevision]);

  const forwardedShortcuts = useMemo(
    () => sandboxForwardedShortcuts(bindings, isMac()),
    [bindings],
  );

  const setRef = (node: HTMLIFrameElement | null): void => {
    frameRef.current = node;
    if (typeof forwardedRef === "function") {
      forwardedRef(node);
    } else if (forwardedRef !== null) {
      forwardedRef.current = node;
    }
  };

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
  const initialInputs = useEffectEvent(() => ({
    html,
    kind,
    networkPolicy,
    policy,
    declared,
    theme,
    forwardedShortcuts,
    hostContext: hostContextFor(theme, platform, kind, displayMode),
    appRequests,
  }));

  // One frame element per content. Keyed by a generation, not by the content
  // itself, which can be a 25 MiB string.
  const content = `${loaderUrl}\n${kind}\n${networkPolicy}\n${csp ?? ""}`;
  const [frame, setFrame] = useState({ html, content, generation: 0 });
  if (frame.html !== html || frame.content !== content) {
    setFrame({ html, content, generation: frame.generation + 1 });
  }
  const frameGeneration = frame.generation;

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
    const iframe = frameRef.current;
    const win = iframe?.ownerDocument.defaultView ?? null;
    if (iframe === null || win === null) return;
    const bridge = new SandboxBridgeHost({
      resource: {
        html: inputs.html,
        kind: inputs.kind,
        networkPolicy: inputs.networkPolicy,
        csp: inputs.policy.csp,
        permissions: inputs.declared,
        theme: inputs.theme,
        forwardedShortcuts: inputs.forwardedShortcuts,
      },
      nonce: crypto.randomUUID(),
      hostContext: inputs.hostContext,
      hostVersion: getClientAppVersionLabel(),
      post: (message) => iframe.contentWindow?.postMessage(message, "*"),
      events: {
        onStatus: onBridgeStatus,
        onSize,
        onOpenLink,
        onShortcut,
        onRequestTeardown,
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
  }, [frameGeneration]);

  useLayoutEffect(() => {
    bridgeRef.current?.updateHostContext(
      hostContextFor(theme, platform, kind, displayMode),
    );
  }, [theme, platform, kind, displayMode]);

  if (!policy.valid) return null;

  return (
    <>
      <iframe
        // A reused frame would keep the old document's load count and its
        // policy container.
        key={frameGeneration}
        ref={setRef}
        title={title}
        src={loaderUrl}
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
      <SandboxLinkConfirm url={confirmUrl} onDecide={decideLink} />
    </>
  );
}
