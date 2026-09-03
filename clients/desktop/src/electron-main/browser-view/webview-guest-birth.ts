import { randomUUID } from "node:crypto";
import {
  app,
  type Event,
  type WebContents,
  type WebPreferences,
} from "electron";
import type {
  BrowserViewGuestMountRequested,
  BrowserViewGuestReleaseRequested,
} from "@traycer-clients/shared/platform/browser-view";
import { log } from "../app/logger";
import {
  ensureBrowserViewSessionForPartition,
  gateBrowserViewGuestRequests,
  registerBrowserViewWebContents,
} from "./browser-session";

/**
 * How long a minted grant may wait for did-attach and for `onAttached` to
 * settle.
 */
const ATTACHMENT_GRANT_TTL_MS = 10_000;

const BLANK_GUEST_SRC = "about:blank";
const BLANK_GUEST_SRC_PREFIX = `${BLANK_GUEST_SRC}#`;

/** Every `webPreferences` key `hardenGuestPreferences` assigns; the rest go. */
const HARDENED_GUEST_PREFERENCE_KEYS = new Set([
  "disablePopups",
  "nodeIntegration",
  "nodeIntegrationInSubFrames",
  "sandbox",
  "contextIsolation",
  "webSecurity",
  "allowRunningInsecureContent",
  "webviewTag",
  "partition",
]);

interface MintAttachmentGrantInput {
  readonly windowId: string;
  readonly partition: string;
  readonly onAttached: (guest: WebContents) => Promise<void>;
  readonly onExpired:
    | ((release: BrowserViewGuestReleaseRequested) => void)
    | null;
}

interface GuestBirth {
  readonly registrationId: string;
  readonly windowId: string;
  readonly partition: string;
  readonly timeout: NodeJS.Timeout;
  readonly onAttached: (guest: WebContents) => Promise<void>;
  readonly onExpired:
    | ((release: BrowserViewGuestReleaseRequested) => void)
    | null;
  readonly settlement: PromiseWithResolvers<void>;
  embedderId: number | null;
  guest: WebContents | null;
  handedOff: boolean;
  ready: boolean;
  disposeGate: (() => void) | null;
}

const births = new Map<string, GuestBirth>();
/**
 * One embedder slot. Electron 42.11 `createGuest` emits `will-attach-webview`
 * then, same turn, `webContents.create()` (app `web-contents-created`).
 * `AttachToIframe` then `Emit("did-attach")` before `createGuest` returns
 * the id the renderer needs for webview methods.
 */
const awaitingCreateByEmbedderId = new Map<number, string>();
let watchingGuestCreation = false;

export function mintAttachmentGrant(input: MintAttachmentGrantInput): {
  readonly mount: BrowserViewGuestMountRequested;
  readonly ready: Promise<void>;
} {
  ensureBrowserViewSessionForPartition(input.partition);
  const registrationId = randomUUID();
  const timeout = setTimeout(() => {
    expireBirth(registrationId);
  }, ATTACHMENT_GRANT_TTL_MS);
  const settlement = Promise.withResolvers<void>();
  void settlement.promise.catch(() => undefined);
  births.set(registrationId, {
    registrationId,
    windowId: input.windowId,
    partition: input.partition,
    timeout,
    onAttached: input.onAttached,
    onExpired: input.onExpired,
    settlement,
    embedderId: null,
    guest: null,
    handedOff: false,
    ready: false,
    disposeGate: null,
  });
  return {
    mount: { registrationId, partition: input.partition },
    ready: settlement.promise,
  };
}

export function releaseAttachmentGrant(
  registrationId: string,
): { readonly registrationId: string; readonly windowId: string } | null {
  const birth = births.get(registrationId);
  if (birth === undefined) return null;
  const windowId = birth.windowId;
  dropBirth(registrationId);
  return { registrationId, windowId };
}

function clearAttachmentGrantsForWindow(windowId: string): void {
  for (const [registrationId, birth] of births) {
    if (birth.windowId === windowId) dropBirth(registrationId);
  }
}

export function clearAllAttachmentGrants(): void {
  for (const registrationId of [...births.keys()]) {
    dropBirth(registrationId);
  }
}

/**
 * Fail-closed `<webview>` admission for one trusted main window.
 * Install before `loadMainWindow`.
 */
export function installWebviewAttachGuards(
  host: WebContents,
  windowId: string,
): void {
  watchGuestCreation();
  host.on(
    "will-attach-webview",
    (
      event: Event,
      webPreferences: WebPreferences,
      params: Record<string, string>,
    ) => {
      handleWillAttach(host, windowId, event, webPreferences, params);
    },
  );
  host.on("did-attach-webview", (_event: Event, guest: WebContents) => {
    handleDidAttach(host, guest);
  });
  host.on(
    "did-start-navigation",
    (
      _details: Event,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || isInPlace) return;
      clearAttachmentGrantsForWindow(windowId);
    },
  );
  host.on("render-process-gone", () => {
    clearAttachmentGrantsForWindow(windowId);
  });
  host.on("destroyed", () => {
    clearAttachmentGrantsForWindow(windowId);
  });
}

function watchGuestCreation(): void {
  if (watchingGuestCreation) return;
  watchingGuestCreation = true;
  app.on("web-contents-created", (_event, contents) => {
    bindCreatedGuest(contents);
  });
}

function bindCreatedGuest(contents: WebContents): void {
  if (contents.getType() !== "webview") return;
  const embedder = contents.hostWebContents;
  if (embedder === null) return;
  const registrationId = awaitingCreateByEmbedderId.get(embedder.id);
  if (registrationId === undefined) return;
  awaitingCreateByEmbedderId.delete(embedder.id);
  const birth = births.get(registrationId);
  if (birth === undefined) {
    closeGuest(contents);
    return;
  }
  birth.guest = contents;
  birth.disposeGate = gateBrowserViewGuestRequests(contents.id);
  contents.once("destroyed", () => {
    if (births.get(registrationId)?.guest === contents) {
      dropBirth(registrationId);
    }
  });
}

function handleWillAttach(
  host: WebContents,
  windowId: string,
  event: Event,
  webPreferences: WebPreferences,
  params: Record<string, string>,
): void {
  const src = params.src ?? "";
  const registrationId = registrationIdFromAttachParams(params);
  const partition = webPreferences.partition || params.partition || "";
  const birth = births.get(registrationId);
  if (birth === undefined) {
    denyAttach(event, "no-grant", src);
    return;
  }
  if (birth.windowId !== windowId) {
    denyAttach(event, "window", src);
    return;
  }
  if (birth.guest !== null) {
    denyAttach(event, "replay", src);
    return;
  }
  if (partition !== birth.partition) {
    denyAttach(event, "partition", src);
    dropBirth(registrationId);
    return;
  }
  if (awaitingCreateByEmbedderId.get(host.id) !== undefined) {
    denyAttach(event, "busy", src);
    return;
  }
  hardenGuestPreferences(webPreferences, birth.partition);
  birth.embedderId = host.id;
  awaitingCreateByEmbedderId.set(host.id, registrationId);
}

function handleDidAttach(host: WebContents, guest: WebContents): void {
  const birth = birthForGuest(guest);
  if (birth === undefined) {
    closeGuest(guest);
    return;
  }
  if (birth.handedOff) return;
  if (
    guest.getType() !== "webview" ||
    guest.hostWebContents !== host ||
    guest.session !== ensureBrowserViewSessionForPartition(birth.partition)
  ) {
    dropBirth(birth.registrationId);
    return;
  }
  birth.handedOff = true;
  registerBrowserViewWebContents(guest);
  try {
    birth.onAttached(guest).then(
      () => {
        finishReady(birth);
      },
      () => {
        dropBirth(birth.registrationId);
      },
    );
  } catch {
    dropBirth(birth.registrationId);
  }
}

function finishReady(birth: GuestBirth): void {
  if (births.get(birth.registrationId) !== birth || birth.ready) return;
  birth.ready = true;
  clearTimeout(birth.timeout);
  disposeGate(birth);
  birth.settlement.resolve();
}

/**
 * The renderer picks `<webview webpreferences="...">`, so every key main does
 * not itself assign below is deleted first: a deny-list would miss whatever
 * key Electron gains next.
 */
function hardenGuestPreferences(
  webPreferences: WebPreferences,
  partition: string,
): void {
  const prefs: WebPreferences & { disablePopups?: boolean } = webPreferences;
  for (const key of Object.keys(prefs)) {
    if (!HARDENED_GUEST_PREFERENCE_KEYS.has(key)) {
      delete prefs[key as keyof typeof prefs];
    }
  }
  prefs.disablePopups = true;
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.sandbox = true;
  prefs.contextIsolation = true;
  prefs.webSecurity = true;
  prefs.allowRunningInsecureContent = false;
  prefs.webviewTag = false;
  prefs.partition = partition;
}

/**
 * The renderer puts the registration id in the `about:blank#…` fragment, the
 * one attribute `will-attach-webview` params forward.
 */
function registrationIdFromAttachParams(
  params: Record<string, string>,
): string {
  const src = params.src ?? "";
  if (!src.startsWith(BLANK_GUEST_SRC_PREFIX)) return "";
  return src.slice(BLANK_GUEST_SRC_PREFIX.length);
}

function denyAttach(event: Event, reason: string, src: string): void {
  event.preventDefault();
  log.warn("[webview-birth] attach denied", {
    reason,
    blankSrc: src === BLANK_GUEST_SRC || src.startsWith(BLANK_GUEST_SRC_PREFIX),
  });
}

function expireBirth(registrationId: string): void {
  const birth = births.get(registrationId);
  if (birth === undefined || birth.ready) return;
  dropBirth(registrationId);
  birth.onExpired?.({ registrationId });
}

function dropBirth(registrationId: string): void {
  const birth = births.get(registrationId);
  if (birth === undefined) return;
  births.delete(registrationId);
  clearTimeout(birth.timeout);
  disposeGate(birth);
  birth.settlement.reject(new Error("webview guest birth failed"));
  if (
    birth.embedderId !== null &&
    awaitingCreateByEmbedderId.get(birth.embedderId) === registrationId
  ) {
    awaitingCreateByEmbedderId.delete(birth.embedderId);
  }
  const guest = birth.guest;
  birth.guest = null;
  if (guest !== null) closeGuest(guest);
}

function disposeGate(birth: GuestBirth): void {
  const dispose = birth.disposeGate;
  birth.disposeGate = null;
  dispose?.();
}

function birthForGuest(guest: WebContents): GuestBirth | undefined {
  for (const birth of births.values()) {
    if (birth.guest === guest) return birth;
  }
  return undefined;
}

function closeGuest(guest: WebContents): void {
  if (!guest.isDestroyed()) guest.close();
}
