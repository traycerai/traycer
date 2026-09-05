import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import {
  providerIdSchema,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { basePersistOptions, landingTerminalsKey } from "@/lib/persist";
import { selectPlainTerminalViewModel } from "@/lib/terminals/plain-terminal-authority";

export const DEFAULT_LANDING_PANEL_WIDTH_FRACTION = 0.36;
export const MIN_LANDING_PANEL_WIDTH_FRACTION = 0.22;
export const MAX_LANDING_PANEL_WIDTH_FRACTION = 0.72;

export type LandingPanelTitleSource = "default" | "manual";

/**
 * The layout key for a start page whose draft has no id yet. Every writer of
 * a per-page layout (the panel, the gesture provider, the draft surface, a
 * picker-started sign-in) must key the same way or the panel a gesture opened
 * is not the panel the user sees.
 */
export const UNBOUND_LANDING_PAGE_ID = "unbound-landing-page";

/** Which kind of surface a panel tab holds. The strip mixes both. */
export type LandingPanelTabKind = "terminal" | "browser";

export const LANDING_TERMINAL_SOURCE_STORE_VERSION = 1;

/**
 * Everything {@link landingTabRefKey} needs, and the reason it is a type of its
 * own: a tab ref and a tombstone are different records that name the same
 * resource, and both must key identically or a tombstone stops matching the tab
 * it was written for.
 */
export type LandingPanelTabIdentity =
  | {
      readonly kind: "terminal";
      readonly hostId: string;
      readonly sessionId: string;
    }
  | {
      readonly kind: "browser";
      readonly hostId: string;
      readonly sessionId: string;
      readonly tabId: string;
    };

/**
 * The ONE identity every dedupe, tombstone, clear and remove path in this store
 * goes through.
 *
 * Terminals are host plus session, as they always were. Browser tabs on one
 * device SHARE a single independent session, so host plus session names the
 * whole device rather than one tab - keying them that way would let the second
 * browser tab on a device silently displace the first on `addTab`, on a persist
 * round trip, and on every tombstone lookup. The tab id is what distinguishes
 * them.
 *
 * The kind is part of the key rather than implied by the arity: nothing
 * promises a browser session id and a terminal id are drawn from different
 * namespaces, and one collision would let `removeHostTerminal` take a browser
 * tab with it.
 */
export function landingTabRefKey(identity: LandingPanelTabIdentity): string {
  if (identity.kind === "browser") {
    return `browser\u0000${identity.hostId}\u0000${identity.sessionId}\u0000${identity.tabId}`;
  }
  return `terminal\u0000${identity.hostId}\u0000${identity.sessionId}`;
}

export interface LandingTerminalTabRef {
  readonly kind: "terminal";
  readonly instanceId: string;
  readonly sessionId: string;
  readonly hostId: string;
  readonly cwd: string;
  readonly name: string;
  readonly titleSource: LandingPanelTitleSource;
  /**
   * True only after a capable host acknowledged this logical terminal. The
   * legacy cwd/name/title fields remain downgrade evidence, never semantic
   * authority while this bit is set and a capable host projection is fresh.
   */
  readonly hostAuthorityAcknowledged?: boolean;
  /** A genuinely-new terminal awaiting `terminal.plain.create`. */
  readonly pendingCreate?: boolean;
  /** Schema version attached to legacy import evidence. */
  readonly sourceStoreVersion?: number;
  /**
   * `"provider-login"` means the HOST created this session, for a provider
   * sign-in (`providers.startTerminalLogin` with an independent scope). Such a
   * tab never creates: the session carries the provider's spawn env, and a
   * `terminal.plain.create` or legacy `terminal.create` under its id would
   * spawn a bare shell that looks like the sign-in terminal and cannot sign
   * anyone in. It is also import-exempt - a manager-owned session is not
   * legacy evidence for `terminal.plain.importLegacy` - and it survives its
   * session's exit so the user can restart the sign-in from where it ended.
   * Absent for every terminal this panel created itself.
   */
  readonly origin?: "provider-login";
  /** The provider the sign-in was for; only meaningful with `origin`. */
  readonly originProviderId?: ProviderId;
}

/** Whether this tab shows a host-created provider sign-in session. */
export function isProviderLoginLandingTab(tab: LandingTerminalTabRef): boolean {
  return tab.origin === "provider-login";
}

/**
 * One Start Page browser tab: one tab inside its device's single shared
 * `independent` session, which is why it carries a `tabId` the terminal arm has
 * no analogue for.
 */
export interface LandingBrowserTabRef {
  readonly kind: "browser";
  readonly instanceId: string;
  readonly sessionId: string;
  readonly hostId: string;
  readonly tabId: string;
  readonly name: string;
  readonly titleSource: LandingPanelTitleSource;
}

export type LandingPanelTabRef = LandingTerminalTabRef | LandingBrowserTabRef;

export function isLandingTerminalTab(
  tab: LandingPanelTabRef,
): tab is LandingTerminalTabRef {
  return tab.kind === "terminal";
}

export function isLandingBrowserTab(
  tab: LandingPanelTabRef,
): tab is LandingBrowserTabRef {
  return tab.kind === "browser";
}

/**
 * The terminal slice of a mixed tab list.
 *
 * The panel's terminal machinery - reconciliation, the plain-terminal
 * authority, the bound-host fleet, the kill drain - is terminal-only and stays
 * that way; it reads this rather than the raw list. Filtering at the seam is
 * deliberate: the alternative is a `kind` check inside each of those, and the
 * one that got forgotten would silently hand a browser ref to `terminal.kill`.
 */
export function landingTerminalTabs(
  tabs: ReadonlyArray<LandingPanelTabRef>,
): ReadonlyArray<LandingTerminalTabRef> {
  return tabs.filter(isLandingTerminalTab);
}

/** The browser slice of a mixed tab list. See {@link landingTerminalTabs}. */
export function landingBrowserTabs(
  tabs: ReadonlyArray<LandingPanelTabRef>,
): ReadonlyArray<LandingBrowserTabRef> {
  return tabs.filter(isLandingBrowserTab);
}

/**
 * The active row's instance id when that row is a TERMINAL, else `null`.
 *
 * Every caller that hands the keyboard to `focusTerminalInstance` wants this
 * and not `activeInstanceId`: the active row can now be a browser tab or the
 * unpicked placeholder, and a terminal focus request parked against an id no
 * terminal will ever register is never claimed and never cleared - it simply
 * sits pending for the rest of the session, where the next terminal to
 * register can be handed it. Each caller falls through to whatever it already
 * did when there was no active row at all.
 */
export function activeLandingTerminalInstanceId(
  state: Pick<LandingPanelStoreState, "tabs" | "activeInstanceId">,
): string | null {
  const active = state.activeInstanceId;
  if (active === null) return null;
  return landingTerminalTabs(state.tabs).some(
    (tab) => tab.instanceId === active,
  )
    ? active
    : null;
}

/**
 * A kill that is still owed for a session whose tab is already gone.
 *
 * The provenance fields exist because the drain cannot otherwise tell an absent
 * plain projection apart from a dead session. Absence is proof of death for
 * exactly one shape of tombstone - a session a capable host had ALREADY
 * acknowledged as a plain terminal - and reading it that way for any other
 * shape leaks the PTY the tombstone was written to kill:
 *
 * - a `terminal.plain.create` still in flight has no projection YET, and the
 *   session id is the one the CLIENT supplied to `create`, so the terminal that
 *   lands afterwards is precisely the one this tombstone names;
 * - a legacy session has no plain projection EVER, and a host is frequently
 *   offline because it is upgrading - so the drain meets it as `capable`.
 *
 * Both fields are copied off the closing TAB rather than read from the live
 * authority. They are facts about this session's history; the authority only
 * reports what its host can do right now, and by the time the drain runs that
 * host may be negotiating a different protocol than the session was closed
 * under. The capability at the moment of the gesture is deliberately NOT
 * recorded: every routing decision below turns out to rest on these two, and an
 * unread field in a persisted schema is one every future build must keep.
 */
export interface LandingTerminalPendingKill {
  readonly kind: "terminal";
  readonly hostId: string;
  readonly sessionId: string;
  /** A capable host had acknowledged this session as a plain terminal. */
  readonly hostAuthorityAcknowledged: boolean;
  /** The tab's `terminal.plain.create` had not settled when it was closed. */
  readonly pendingCreate: boolean;
}

/**
 * A browser tab closed while its device could not be asked.
 *
 * It carries no provenance twin of the terminal arm's two booleans because the
 * question they answer does not arise here: a browser tab is only ever
 * tombstoned for a tab the host itself minted and reported, so absence from the
 * device's inventory means gone, full stop. There is no client-supplied id
 * whose creation could still be in flight.
 */
export interface LandingBrowserPendingKill {
  readonly kind: "browser";
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}

export type LandingPanelPendingKill =
  | LandingTerminalPendingKill
  | LandingBrowserPendingKill;

export function isLandingTerminalPendingKill(
  pending: LandingPanelPendingKill,
): pending is LandingTerminalPendingKill {
  return pending.kind === "terminal";
}

export function isLandingBrowserPendingKill(
  pending: LandingPanelPendingKill,
): pending is LandingBrowserPendingKill {
  return pending.kind === "browser";
}

/** The terminal slice of the tombstone set. See {@link landingTerminalTabs}. */
export function landingTerminalPendingKills(
  pendingKills: ReadonlyArray<LandingPanelPendingKill>,
): ReadonlyArray<LandingTerminalPendingKill> {
  return pendingKills.filter(isLandingTerminalPendingKill);
}

/** The browser slice of the tombstone set. See {@link landingTerminalTabs}. */
export function landingBrowserPendingKills(
  pendingKills: ReadonlyArray<LandingPanelPendingKill>,
): ReadonlyArray<LandingBrowserPendingKill> {
  return pendingKills.filter(isLandingBrowserPendingKill);
}

/**
 * Whether this session's absence from its host's own listing proves it is dead.
 *
 * True for exactly one shape of tombstone: a session a capable host had ALREADY
 * acknowledged. That host published it once, so its disappearance is the host
 * saying it is gone. For anything else absence is the host saying NOTHING - a
 * create still in flight has not been listed yet, and a legacy session is not in
 * a plain projection to begin with.
 *
 * Lives here rather than beside any one caller because three separate drains ask
 * this question - the recovery bridge, and both arms of landing-terminal
 * reconciliation - and answering it differently in any of them reopens the leak.
 *
 * `pendingCreate` is checked as well as acknowledgement even though
 * `hostAcknowledgedTab` clears one while setting the other: the pair arrives
 * from persisted JSON, where nothing enforces that invariant.
 *
 * Narrowed to the terminal arm at the signature. The browser arm has no
 * equivalent uncertainty (see {@link LandingBrowserPendingKill}), and a caller
 * that reaches for this with a browser tombstone is asking the wrong question.
 */
export function absentListingProvesDeath(
  pending: LandingTerminalPendingKill,
): boolean {
  return pending.hostAuthorityAcknowledged && !pending.pendingCreate;
}

/** The tombstone a closing tab owes, in the shape its own kind is drained in. */
export function landingPanelPendingKillFor(
  ref: LandingPanelTabRef,
): LandingPanelPendingKill {
  if (ref.kind === "browser") {
    return {
      kind: "browser",
      hostId: ref.hostId,
      sessionId: ref.sessionId,
      tabId: ref.tabId,
    };
  }
  return {
    kind: "terminal",
    hostId: ref.hostId,
    sessionId: ref.sessionId,
    hostAuthorityAcknowledged: ref.hostAuthorityAcknowledged === true,
    pendingCreate: ref.pendingCreate === true,
  };
}

export interface LandingPanelLayout {
  readonly panelOpen: boolean;
  readonly panelWidthFraction: number;
  readonly maximized: boolean;
}

export const DEFAULT_LANDING_PANEL_LAYOUT: LandingPanelLayout = {
  panelOpen: false,
  panelWidthFraction: DEFAULT_LANDING_PANEL_WIDTH_FRACTION,
  maximized: false,
};

/**
 * The unpicked "New tab" row: a real strip entry the user can activate, close
 * or switch away from, whose body is the Terminal / Browser chooser.
 *
 * It lives outside `tabs` and outside persistence. Outside `tabs` because it
 * names no host resource - every consumer of a tab ref would have to defend
 * against a member with no session. Outside persistence because an unpicked
 * choice is not state worth restoring: after a reload it is simply gone.
 *
 * `index` is its position in `tabs`, which is where {@link fulfilledTabs} puts
 * the picked tab so it keeps the strip position the placeholder held.
 */
export interface LandingPanelPlaceholder {
  readonly instanceId: string;
  readonly index: number;
}

export interface LandingPanelStoreState {
  readonly tabs: ReadonlyArray<LandingPanelTabRef>;
  readonly activeInstanceId: string | null;
  /** The unpicked new-tab row, or `null`. Never persisted. */
  readonly placeholder: LandingPanelPlaceholder | null;
  readonly layoutsByLandingPageId: Readonly<
    Partial<Record<string, LandingPanelLayout>>
  >;
  /**
   * Retains the v1 global layout only for pages that have not yet recorded
   * their own layout. New layout writes always target one landing page.
   */
  readonly fallbackLayout: LandingPanelLayout | null;
  readonly pendingKills: ReadonlyArray<LandingPanelPendingKill>;
  /**
   * The tab a programmatic panel open was made to SHOW, or `null`. Not
   * persisted: it describes one open transition in this window.
   *
   * The panel reads a closed-to-open transition as the user's opening gesture
   * and settles it by re-targeting the launch cwd - reuse a terminal already
   * running there, else spawn one and focus it. An open made to reveal a tab
   * that already exists (a host-created sign-in terminal, whose display-only
   * `"~"` cwd matches no launch cwd) is not that gesture: settling it would
   * spawn a bare shell and put it in front of the tab the open was for. The
   * panel consumes this on its next open transition to tell the two apart.
   */
  readonly panelReveal: string | null;
  readonly setPanelOpen: (landingPageId: string, open: boolean) => void;
  /**
   * Opens the panel to SHOW `instanceId` on each of `landingPageIds`, and
   * with `everyPage` on EVERY start page as well: each page that has recorded
   * a layout of its own, and through the fallback every page that has not.
   * Records `panelReveal` so the panel does not settle the open as a gesture.
   *
   * The one caller is the sign-in open. `everyPage` is for a start page
   * discarded while `providers.startTerminalLogin` was in flight with no
   * other pane mounted, so no id names a surface the user can see this on.
   * Whichever start page mounts NEXT then shows the panel, which is where the
   * tab (tabs are shared across pages) already is. Both halves of that form
   * are needed: `landingPanelLayoutFor` gives a page's own layout precedence
   * over the fallback, so a page that once closed its panel would ignore a
   * fallback-only write and hide the terminal behind the very layout it
   * recorded.
   *
   * Bounded by the same rule that retires layouts generally: the collapse on
   * an empty tab set closes every one of them once the last tab is gone, so
   * this cannot outlive the terminal it was written for.
   */
  readonly revealPanel: (reveal: {
    readonly landingPageIds: ReadonlyArray<string>;
    readonly everyPage: boolean;
    readonly instanceId: string;
  }) => void;
  /**
   * Retires `panelReveal`. The panel calls it on every open or collapse
   * transition and on a page switch, so a reveal that never saw its
   * transition (the panel was already open) cannot suppress a later gesture.
   */
  readonly clearPanelReveal: () => void;
  readonly setPanelWidthFraction: (
    landingPageId: string,
    fraction: number,
  ) => void;
  readonly setPanelMaximized: (
    landingPageId: string,
    maximized: boolean,
  ) => void;
  readonly addTab: (tab: LandingPanelTabRef) => void;
  readonly activateTab: (instanceId: string) => void;
  readonly renameTab: (instanceId: string, name: string) => void;
  /** Refreshes a derived title without overwriting a user rename. */
  readonly syncDefaultTitle: (instanceId: string, name: string) => void;
  /**
   * Opens the new-tab placeholder and activates it, or activates the one
   * already open. Only ever one at a time, so a second `+` focuses the first
   * rather than stacking a second unpicked row.
   */
  readonly openPlaceholder: (instanceId: string, index: number) => void;
  /**
   * Replaces the placeholder with the tab that was picked, at the placeholder's
   * own strip position, and activates it.
   *
   * Appends when no placeholder is open. That is not a fallback for a caller
   * mistake: picking Terminal can route through the directory picker, so the
   * placeholder may legitimately be dismissed while the create is in flight,
   * and the terminal that lands still has to become a tab.
   */
  /**
   * Lands an answered tab on the placeholder row it was asked for.
   *
   * `forPlaceholderInstanceId` names the row the caller was answering, and
   * `null` is a caller that never had one - a chord, which takes the tab live
   * wherever it lands. When it names a row that is no longer the placeholder,
   * the answer LOST that row: something else fulfilled or dismissed it while
   * the device was replying. The tab still lands, because the device opened it
   * and a tab with no row would be unreachable, but it lands quietly - the
   * keyboard stays with whatever the reader chose in the meantime.
   */
  readonly fulfillPlaceholder: (
    tab: LandingPanelTabRef,
    forPlaceholderInstanceId: string | null,
  ) => void;
  readonly dismissPlaceholder: () => void;
  /**
   * Atomically tombstones then removes a user-closed tab.
   *
   * The tombstone's provenance is copied off the tab being closed, so no caller
   * has to supply it and no call site can get it wrong.
   */
  readonly closeTab: (
    landingPageId: string,
    instanceId: string,
  ) => LandingPanelTabRef | null;
  /** Removes a self-exited tab without asking the host to kill it again. */
  readonly removeExitedTab: (landingPageId: string, instanceId: string) => void;
  /**
   * Replaces one `(device, kind)` slice of the tab list, leaving every other
   * slice's order and position untouched.
   *
   * Sliced rather than wholesale because two reconcilers now run against one
   * list - a terminal pass per device and a browser pass per device - and a
   * method that replaced the whole list would have each pass wipe the others'
   * tabs on every frame.
   */
  readonly applyReconciliationSlice: (
    hostId: string,
    kind: LandingPanelTabKind,
    refs: ReadonlyArray<LandingPanelTabRef>,
    collapseWhenEmpty: boolean,
  ) => void;
  readonly clearPendingKill: (identity: LandingPanelTabIdentity) => void;
  readonly rekeyTab: (instanceId: string, sessionId: string) => void;
  readonly adoptHostTerminal: (
    instanceId: string,
    terminal: PlainTerminalProjection,
  ) => void;
  readonly removeHostTerminal: (hostId: string, terminalId: string) => void;
  readonly resetForTests: () => void;
}

interface PersistedLandingPanelState {
  readonly tabs: ReadonlyArray<LandingPanelTabRef>;
  readonly activeInstanceId: string | null;
  readonly layoutsByLandingPageId: Readonly<
    Partial<Record<string, LandingPanelLayout>>
  >;
  readonly fallbackLayout: LandingPanelLayout | null;
  readonly pendingKills: ReadonlyArray<LandingPanelPendingKill>;
}

function initialPersistedLandingPanelState(): PersistedLandingPanelState {
  return {
    tabs: [],
    activeInstanceId: null,
    layoutsByLandingPageId: {},
    fallbackLayout: null,
    pendingKills: [],
  };
}

function initialLandingPanelState(): PersistedLandingPanelState & {
  readonly placeholder: LandingPanelPlaceholder | null;
} {
  return { ...initialPersistedLandingPanelState(), placeholder: null };
}

export function landingPanelLayoutFor(
  state: Pick<
    LandingPanelStoreState,
    "layoutsByLandingPageId" | "fallbackLayout"
  >,
  landingPageId: string,
): LandingPanelLayout {
  return (
    state.layoutsByLandingPageId[landingPageId] ??
    state.fallbackLayout ??
    DEFAULT_LANDING_PANEL_LAYOUT
  );
}

export function clampLandingPanelWidthFraction(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_LANDING_PANEL_WIDTH_FRACTION;
  }
  return Math.min(
    MAX_LANDING_PANEL_WIDTH_FRACTION,
    Math.max(MIN_LANDING_PANEL_WIDTH_FRACTION, value),
  );
}

export function parseLandingTerminalTabRef(
  value: unknown,
): LandingTerminalTabRef | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyString(value.instanceId) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(value.hostId) ||
    !isNonEmptyString(value.cwd) ||
    !isNonEmptyString(value.name)
  ) {
    return null;
  }
  const titleSource = parseTitleSource(value.titleSource);
  return {
    kind: "terminal",
    instanceId: value.instanceId,
    sessionId: value.sessionId,
    hostId: value.hostId,
    cwd: value.cwd,
    name: value.name,
    titleSource,
    ...(value.hostAuthorityAcknowledged === true
      ? { hostAuthorityAcknowledged: true }
      : {}),
    ...(value.pendingCreate === true ? { pendingCreate: true } : {}),
    ...(isNonNegativeInteger(value.sourceStoreVersion)
      ? { sourceStoreVersion: value.sourceStoreVersion }
      : {}),
    ...parseProviderLoginOrigin(value),
  };
}

// The origin marker is what keeps a sign-in tab from creating a bare shell
// under the host's session id, so a persisted one is read back strictly: a
// marker without a recognizable provider still marks the tab (the tile then
// shows the ended state without a restart button, exactly as the epic tile
// does for a ref written before the provider was recorded).
function parseProviderLoginOrigin(
  value: Record<string, unknown>,
): Pick<LandingTerminalTabRef, "origin" | "originProviderId"> {
  if (value.origin !== "provider-login") return {};
  const providerId = providerIdSchema.safeParse(value.originProviderId);
  return providerId.success
    ? { origin: "provider-login", originProviderId: providerId.data }
    : { origin: "provider-login" };
}

export function parseLandingBrowserTabRef(
  value: unknown,
): LandingBrowserTabRef | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyString(value.instanceId) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(value.hostId) ||
    !isNonEmptyString(value.tabId) ||
    !isNonEmptyString(value.name)
  ) {
    return null;
  }
  return {
    kind: "browser",
    instanceId: value.instanceId,
    sessionId: value.sessionId,
    hostId: value.hostId,
    tabId: value.tabId,
    name: value.name,
    titleSource: parseTitleSource(value.titleSource),
  };
}

/**
 * The tolerant read of one persisted tab.
 *
 * An ABSENT `kind` is a ref written before browser tabs existed, and every one
 * of those was a terminal - so it defaults there rather than being dropped.
 * GUI persisted stores stay at version 1 by policy; this tolerance IS the
 * migration.
 */
export function parseLandingPanelTabRef(
  value: unknown,
): LandingPanelTabRef | null {
  if (!isRecord(value)) return null;
  return value.kind === "browser"
    ? parseLandingBrowserTabRef(value)
    : parseLandingTerminalTabRef(value);
}

export function parsePersistedLandingPanelState(
  value: unknown,
): PersistedLandingPanelState {
  const initial = initialPersistedLandingPanelState();
  if (!isRecord(value)) return initial;
  const tabs = parseTabs(value.tabs);
  return {
    tabs,
    activeInstanceId: parseActiveInstanceId(value.activeInstanceId, tabs),
    layoutsByLandingPageId: parseLandingPanelLayouts(
      value.layoutsByLandingPageId,
    ),
    fallbackLayout: parseFallbackLayout(value),
    pendingKills: parsePendingKills(value.pendingKills),
  };
}

export const useLandingPanelStore = create<LandingPanelStoreState>()(
  persist(
    (set, get) => ({
      ...initialLandingPanelState(),
      panelReveal: null,
      setPanelOpen: (landingPageId, panelOpen) =>
        set((state) =>
          updateLandingPanelLayout(state, landingPageId, {
            ...landingPanelLayoutFor(state, landingPageId),
            panelOpen,
          }),
        ),
      revealPanel: ({ landingPageIds, everyPage, instanceId }) =>
        set((state) => {
          const opened = everyPage ? openEveryPageLayout(state) : {};
          return {
            ...opened,
            ...openPageLayouts({ ...state, ...opened }, landingPageIds),
            panelReveal: instanceId,
          };
        }),
      clearPanelReveal: () =>
        set((state) =>
          state.panelReveal === null ? state : { panelReveal: null },
        ),
      setPanelWidthFraction: (landingPageId, panelWidthFraction) =>
        set((state) =>
          updateLandingPanelLayout(state, landingPageId, {
            ...landingPanelLayoutFor(state, landingPageId),
            panelWidthFraction:
              clampLandingPanelWidthFraction(panelWidthFraction),
          }),
        ),
      setPanelMaximized: (landingPageId, maximized) =>
        set((state) =>
          updateLandingPanelLayout(state, landingPageId, {
            ...landingPanelLayoutFor(state, landingPageId),
            maximized,
          }),
        ),
      addTab: (tab) =>
        set((state) => {
          const existing = findEquivalentTab(state.tabs, tab);
          if (existing !== undefined) {
            return {
              activeInstanceId: existing.instanceId,
            };
          }
          return {
            tabs: [...state.tabs, tab],
            activeInstanceId: tab.instanceId,
          };
        }),
      // The placeholder is activatable like any other strip row: it is a real
      // tab from the user's side, and `⌘1`-`⌘9` / clicking it must reach it.
      activateTab: (instanceId) =>
        set((state) =>
          state.tabs.some((tab) => tab.instanceId === instanceId) ||
          state.placeholder?.instanceId === instanceId
            ? { activeInstanceId: instanceId }
            : state,
        ),
      renameTab: (instanceId, name) => {
        const trimmed = name.trim();
        if (trimmed.length === 0) return;
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.instanceId === instanceId
              ? retitledTab(tab, trimmed, "manual")
              : tab,
          ),
        }));
      },
      syncDefaultTitle: (instanceId, name) => {
        const trimmed = name.trim();
        if (trimmed.length === 0) return;
        set((state) => {
          const target = state.tabs.find(
            (tab) => tab.instanceId === instanceId,
          );
          if (
            target === undefined ||
            target.titleSource === "manual" ||
            target.name === trimmed
          ) {
            return state;
          }
          return {
            tabs: state.tabs.map((tab) =>
              tab.instanceId === instanceId
                ? retitledTab(tab, trimmed, tab.titleSource)
                : tab,
            ),
          };
        });
      },
      openPlaceholder: (instanceId, index) =>
        set((state) => {
          const existing = state.placeholder;
          if (existing !== null) {
            return { activeInstanceId: existing.instanceId };
          }
          const placeholder: LandingPanelPlaceholder = {
            instanceId,
            index: clampPlaceholderIndex(index, state.tabs.length),
          };
          return { placeholder, activeInstanceId: placeholder.instanceId };
        }),
      fulfillPlaceholder: (tab, forPlaceholderInstanceId) =>
        set((state) => {
          const ownsRow =
            forPlaceholderInstanceId === null ||
            state.placeholder?.instanceId === forPlaceholderInstanceId;
          const existing = findEquivalentTab(state.tabs, tab);
          if (existing !== undefined) {
            // Not ours to clear, and not ours to select: the row this answered
            // is gone, and the placeholder on screen belongs to someone else.
            if (!ownsRow) return state;
            return {
              placeholder: null,
              activeInstanceId: existing.instanceId,
            };
          }
          if (!ownsRow) return { tabs: [...state.tabs, tab] };
          return {
            tabs: fulfilledTabs(state.tabs, state.placeholder, tab),
            placeholder: null,
            activeInstanceId: tab.instanceId,
          };
        }),
      dismissPlaceholder: () =>
        set((state) => {
          const placeholder = state.placeholder;
          if (placeholder === null) return state;
          const activeInstanceId =
            state.activeInstanceId === placeholder.instanceId
              ? null
              : state.activeInstanceId;
          return {
            placeholder: null,
            activeInstanceId: nextActiveInstanceId(
              state.tabs,
              null,
              activeInstanceId,
            ),
            // Symmetric with `closeTab`: dismissing the last thing in the panel
            // leaves nothing to display, so the panel collapses exactly as
            // closing the last tab does.
            ...(landingPanelIsEmpty(state.tabs, null)
              ? collapseLayoutsForEmptyPanel(state)
              : {}),
          };
        }),
      closeTab: (_landingPageId, instanceId) => {
        const closed = get().tabs.find(
          (entry) => entry.instanceId === instanceId,
        );
        if (closed === undefined) return null;
        set((state) => {
          const tabs = state.tabs.filter(
            (entry) => entry.instanceId !== instanceId,
          );
          const pendingKills = hasPendingKill(state.pendingKills, closed)
            ? state.pendingKills
            : [...state.pendingKills, landingPanelPendingKillFor(closed)];
          return {
            tabs,
            activeInstanceId: nextActiveInstanceId(
              tabs,
              state.placeholder,
              state.activeInstanceId,
            ),
            pendingKills,
            ...(landingPanelIsEmpty(tabs, state.placeholder)
              ? collapseLayoutsForEmptyPanel(state)
              : {}),
          };
        });
        return closed;
      },
      removeExitedTab: (_landingPageId, instanceId) =>
        set((state) => {
          const tabs = state.tabs.filter(
            (tab) => tab.instanceId !== instanceId,
          );
          if (tabs.length === state.tabs.length) return state;
          return {
            tabs,
            activeInstanceId: nextActiveInstanceId(
              tabs,
              state.placeholder,
              state.activeInstanceId,
            ),
            ...(landingPanelIsEmpty(tabs, state.placeholder)
              ? collapseLayoutsForEmptyPanel(state)
              : {}),
          };
        }),
      applyReconciliationSlice: (hostId, kind, refs, collapseWhenEmpty) =>
        set((state) => {
          const tabs = spliceLandingPanelSlice(state.tabs, hostId, kind, refs);
          return {
            tabs,
            activeInstanceId: nextActiveInstanceId(
              tabs,
              state.placeholder,
              state.activeInstanceId,
            ),
            ...(collapseWhenEmpty &&
            landingPanelIsEmpty(tabs, state.placeholder)
              ? collapseLayoutsForEmptyPanel(state)
              : {}),
          };
        }),
      // Writes a fresh array even when nothing matched, which is what the
      // pre-union store did. Three separate drains clear against one tombstone
      // set and re-examine it on each other's writes, so a no-op short-circuit
      // here would withhold a wake several of them are subscribed for. Not
      // adopted as an optimization because nothing established it was safe.
      clearPendingKill: (identity) =>
        set((state) => {
          const key = landingTabRefKey(identity);
          return {
            pendingKills: state.pendingKills.filter(
              (pending) => landingTabRefKey(pending) !== key,
            ),
          };
        }),
      // Terminal-only by construction: the caller is the terminal tile's
      // create-error recovery, and a browser ref's identity is its tab id, not
      // the session id this rewrites. Rewriting one would move a browser tab's
      // key onto a session it does not belong to.
      rekeyTab: (instanceId, sessionId) =>
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.kind === "terminal" && tab.instanceId === instanceId
              ? { ...tab, sessionId }
              : tab,
          ),
        })),
      // Matched on instance + host only. The canonical terminal a capable host
      // returns for `importLegacy` ("existing"/"imported") may carry a
      // DIFFERENT terminalId than the legacy evidence we sent - the response
      // contract permits it - and rekeying that pointer is exactly what
      // `hostAcknowledgedTab` is for. Also demanding the ids already match
      // dropped the acknowledgement, left the tab unacknowledged beside a
      // freshly adopted canonical duplicate, and re-imported on the next pass.
      adoptHostTerminal: (instanceId, terminal) =>
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.kind === "terminal" &&
            tab.instanceId === instanceId &&
            tab.hostId === terminal.record.hostId
              ? hostAcknowledgedTab(tab, terminal)
              : tab,
          ),
        })),
      removeHostTerminal: (hostId, terminalId) =>
        set((state) => {
          const key = landingTabRefKey({
            kind: "terminal",
            hostId,
            sessionId: terminalId,
          });
          const tabs = state.tabs.filter(
            (tab) => landingTabRefKey(tab) !== key,
          );
          if (tabs.length === state.tabs.length) return state;
          return {
            tabs,
            activeInstanceId: nextActiveInstanceId(
              tabs,
              state.placeholder,
              state.activeInstanceId,
            ),
            ...(landingPanelIsEmpty(tabs, state.placeholder)
              ? collapseLayoutsForEmptyPanel(state)
              : {}),
          };
        }),
      resetForTests: () =>
        set({ ...initialLandingPanelState(), panelReveal: null }),
    }),
    {
      ...basePersistOptions(landingTerminalsKey(null)),
      storage: createJSONStorage(() => window.localStorage),
      // `placeholder` is deliberately absent: an unpicked new-tab row is not
      // state worth restoring, and the core flows say so outright.
      partialize: (state): PersistedLandingPanelState => ({
        tabs: state.tabs,
        activeInstanceId: state.activeInstanceId,
        layoutsByLandingPageId: state.layoutsByLandingPageId,
        fallbackLayout: state.fallbackLayout,
        pendingKills: state.pendingKills,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...parsePersistedLandingPanelState(persistedState),
      }),
    },
  ),
);

function openPageLayouts(
  state: Pick<
    LandingPanelStoreState,
    "layoutsByLandingPageId" | "fallbackLayout"
  >,
  landingPageIds: ReadonlyArray<string>,
): Pick<LandingPanelStoreState, "layoutsByLandingPageId"> {
  let next = state;
  for (const landingPageId of landingPageIds) {
    next = {
      ...next,
      ...updateLandingPanelLayout(next, landingPageId, {
        ...landingPanelLayoutFor(next, landingPageId),
        panelOpen: true,
      }),
    };
  }
  return { layoutsByLandingPageId: next.layoutsByLandingPageId };
}

function openEveryPageLayout(
  state: Pick<
    LandingPanelStoreState,
    "layoutsByLandingPageId" | "fallbackLayout"
  >,
): Pick<LandingPanelStoreState, "layoutsByLandingPageId" | "fallbackLayout"> {
  const layoutsByLandingPageId: Partial<Record<string, LandingPanelLayout>> =
    {};
  for (const [landingPageId, layout] of Object.entries(
    state.layoutsByLandingPageId,
  )) {
    if (layout !== undefined) {
      layoutsByLandingPageId[landingPageId] = { ...layout, panelOpen: true };
    }
  }
  return {
    layoutsByLandingPageId,
    fallbackLayout: {
      ...(state.fallbackLayout ?? DEFAULT_LANDING_PANEL_LAYOUT),
      panelOpen: true,
    },
  };
}

/**
 * Whether the panel has nothing left to display.
 *
 * Every collapse decision in this store goes through it, and the placeholder is
 * a term because it occupies the body: an empty `tabs` with a chooser on screen
 * is not an empty panel, and collapsing there would shut the surface the user
 * has just been handed. Reconciliation counts too, not only the two close
 * paths - a pass that finds no terminals runs while the chooser is up.
 */
function landingPanelIsEmpty(
  tabs: ReadonlyArray<LandingPanelTabRef>,
  placeholder: LandingPanelPlaceholder | null,
): boolean {
  return tabs.length === 0 && placeholder === null;
}

function findEquivalentTab(
  tabs: ReadonlyArray<LandingPanelTabRef>,
  tab: LandingPanelTabRef,
): LandingPanelTabRef | undefined {
  const key = landingTabRefKey(tab);
  return tabs.find(
    (entry) =>
      entry.instanceId === tab.instanceId || landingTabRefKey(entry) === key,
  );
}

function clampPlaceholderIndex(index: number, length: number): number {
  if (!Number.isInteger(index)) return length;
  return Math.min(Math.max(index, 0), length);
}

/**
 * The picked tab at the placeholder's strip position.
 *
 * The index is clamped rather than trusted: the placeholder can outlive the
 * list it indexed into - a reconciliation pass may drop tabs while the chooser
 * is up, or while the directory picker is deciding where a terminal lands.
 */
function fulfilledTabs(
  tabs: ReadonlyArray<LandingPanelTabRef>,
  placeholder: LandingPanelPlaceholder | null,
  tab: LandingPanelTabRef,
): ReadonlyArray<LandingPanelTabRef> {
  if (placeholder === null) return [...tabs, tab];
  const index = clampPlaceholderIndex(placeholder.index, tabs.length);
  return [...tabs.slice(0, index), tab, ...tabs.slice(index)];
}

/**
 * Replaces one `(device, kind)` slice in place.
 *
 * Refs outside the slice keep their index. The slice's existing positions are
 * filled from `refs` in order, and anything left over - the pass's adoptions -
 * goes directly after the slice's LAST position rather than at the end of the
 * list, so a device's tabs stay contiguous instead of migrating past another
 * device's every time one is adopted.
 *
 * A slice with no members today holds no position at all, so its refs append.
 */
function spliceLandingPanelSlice(
  tabs: ReadonlyArray<LandingPanelTabRef>,
  hostId: string,
  kind: LandingPanelTabKind,
  refs: ReadonlyArray<LandingPanelTabRef>,
): ReadonlyArray<LandingPanelTabRef> {
  const isSliceMember = (tab: LandingPanelTabRef): boolean =>
    tab.hostId === hostId && tab.kind === kind;
  const lastSliceIndex = tabs.reduce(
    (last, tab, index) => (isSliceMember(tab) ? index : last),
    -1,
  );
  if (lastSliceIndex === -1) return [...tabs, ...refs];
  const next: LandingPanelTabRef[] = [];
  let consumed = 0;
  tabs.forEach((tab, index) => {
    if (!isSliceMember(tab)) {
      next.push(tab);
    } else if (consumed < refs.length) {
      next.push(refs[consumed]);
      consumed += 1;
    }
    if (index !== lastSliceIndex) return;
    for (; consumed < refs.length; consumed += 1) {
      next.push(refs[consumed]);
    }
  });
  return next;
}

/**
 * A tab with a new title, narrowed per arm.
 *
 * The two branches are identical to read and are not redundant: spreading a
 * discriminated union does not preserve the discriminant's correlation with the
 * arm's own fields, so one shared spread would not type-check as a
 * `LandingPanelTabRef`.
 */
function retitledTab(
  tab: LandingPanelTabRef,
  name: string,
  titleSource: LandingPanelTitleSource,
): LandingPanelTabRef {
  if (tab.kind === "browser") return { ...tab, name, titleSource };
  return { ...tab, name, titleSource };
}

function updateLandingPanelLayout(
  state: Pick<LandingPanelStoreState, "layoutsByLandingPageId">,
  landingPageId: string,
  layout: LandingPanelLayout,
): Pick<LandingPanelStoreState, "layoutsByLandingPageId"> {
  return {
    layoutsByLandingPageId: {
      ...state.layoutsByLandingPageId,
      [landingPageId]: layout,
    },
  };
}

/**
 * Tabs are shared across landing pages. Once none remain, no page can keep an
 * open panel: that would display a permanently empty surface whose prior
 * opening gesture cannot settle. This is intentionally narrower than a user
 * collapse, width adjustment, or fullscreen toggle, which remain scoped.
 */
function collapseLayoutsForEmptyPanel(
  state: Pick<
    LandingPanelStoreState,
    "layoutsByLandingPageId" | "fallbackLayout"
  >,
): Pick<LandingPanelStoreState, "layoutsByLandingPageId" | "fallbackLayout"> {
  const layoutsByLandingPageId: Partial<Record<string, LandingPanelLayout>> =
    {};
  for (const [landingPageId, layout] of Object.entries(
    state.layoutsByLandingPageId,
  )) {
    if (layout !== undefined) {
      layoutsByLandingPageId[landingPageId] = { ...layout, panelOpen: false };
    }
  }

  return {
    layoutsByLandingPageId,
    fallbackLayout:
      state.fallbackLayout === null
        ? null
        : { ...state.fallbackLayout, panelOpen: false },
  };
}

function parseLandingPanelLayouts(
  value: unknown,
): Readonly<Partial<Record<string, LandingPanelLayout>>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([landingPageId, raw]) => {
      if (landingPageId.trim().length === 0 || !isRecord(raw)) return [];
      return [[landingPageId, parseLandingPanelLayout(raw)]];
    }),
  );
}

function parseFallbackLayout(
  value: Record<string, unknown>,
): LandingPanelLayout | null {
  if (isRecord(value.fallbackLayout)) {
    return parseLandingPanelLayout(value.fallbackLayout);
  }
  if (isRecord(value.layoutsByLandingPageId)) return null;
  if (
    typeof value.panelOpen !== "boolean" &&
    typeof value.panelWidthFraction !== "number" &&
    typeof value.maximized !== "boolean"
  ) {
    return null;
  }
  return parseLandingPanelLayout(value);
}

function parseLandingPanelLayout(
  value: Record<string, unknown>,
): LandingPanelLayout {
  return {
    panelOpen: value.panelOpen === true,
    panelWidthFraction:
      typeof value.panelWidthFraction === "number"
        ? clampLandingPanelWidthFraction(value.panelWidthFraction)
        : DEFAULT_LANDING_PANEL_WIDTH_FRACTION,
    maximized: value.maximized === true,
  };
}

function parseTabs(value: unknown): ReadonlyArray<LandingPanelTabRef> {
  if (!Array.isArray(value)) return [];
  const seenInstanceIds = new Set<string>();
  const seenKeys = new Set<string>();
  return value.flatMap((entry) => {
    const tab = parseLandingPanelTabRef(entry);
    if (tab === null) return [];
    const key = landingTabRefKey(tab);
    if (seenInstanceIds.has(tab.instanceId) || seenKeys.has(key)) {
      return [];
    }
    seenInstanceIds.add(tab.instanceId);
    seenKeys.add(key);
    return [tab];
  });
}

function parsePendingKills(
  value: unknown,
): ReadonlyArray<LandingPanelPendingKill> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    const pending = parsePendingKill(entry);
    if (pending === null) return [];
    const key = landingTabRefKey(pending);
    if (seen.has(key)) return [];
    seen.add(key);
    return [pending];
  });
}

/** Absent `kind` defaults to `"terminal"`, for the same reason tabs do. */
function parsePendingKill(value: unknown): LandingPanelPendingKill | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.hostId) || !isNonEmptyString(value.sessionId)) {
    return null;
  }
  if (value.kind === "browser") {
    if (!isNonEmptyString(value.tabId)) return null;
    return {
      kind: "browser",
      hostId: value.hostId,
      sessionId: value.sessionId,
      tabId: value.tabId,
    };
  }
  // Back-compat, and the two fields are conservative in OPPOSITE directions.
  //
  // `hostAuthorityAcknowledged` is conservative at `false`: it withholds the
  // clear-on-absent-projection shortcut and routes the record through
  // `terminal.kill`, which reports "already gone" as data instead of
  // rejecting.
  //
  // `pendingCreate` is conservative at `TRUE`. It is what buys the reprieve on
  // a `killed: false` answer, so defaulting it to `false` would resolve the
  // uncertainty in the leaking direction: a record persisted by an older build
  // while its `terminal.plain.create` was still in flight would be cleared by
  // the first "already gone" answer after the update, and the create landing
  // afterwards would leave a live PTY with nothing owed against it.
  //
  // So ABSENCE of the field means "possibly pending" while an explicit
  // `false` is believed. Costing a genuinely dead legacy record the answer
  // budget (~4.25 minutes of the host saying "no such session") is the safe
  // side of that trade, and it terminates because the budget is bounded -
  // which is precisely what makes preserving the uncertainty affordable here.
  return {
    kind: "terminal",
    hostId: value.hostId,
    sessionId: value.sessionId,
    hostAuthorityAcknowledged: value.hostAuthorityAcknowledged === true,
    pendingCreate:
      "pendingCreate" in value ? value.pendingCreate === true : true,
  };
}

/**
 * The first tab's instance id, or `null` for an empty list.
 *
 * `at(0)` rather than `[0]`: the index signature types a miss as a hit, so
 * `tabs[0]?.` reads as an unnecessary optional chain to the linter while still
 * being the only thing standing between an empty list and a crash.
 */
function firstTabInstanceId(
  tabs: ReadonlyArray<LandingPanelTabRef>,
): string | null {
  const first = tabs.at(0);
  return first === undefined ? null : first.instanceId;
}

function parseActiveInstanceId(
  value: unknown,
  tabs: ReadonlyArray<LandingPanelTabRef>,
): string | null {
  if (
    typeof value === "string" &&
    tabs.some((tab) => tab.instanceId === value)
  ) {
    return value;
  }
  return firstTabInstanceId(tabs);
}

function parseTitleSource(value: unknown): LandingPanelTitleSource {
  return value === "manual" ? "manual" : "default";
}

/**
 * The tab that keeps (or takes) activation after the list changed.
 *
 * The placeholder is a candidate on both sides: it holds activation when it had
 * it, and it takes it when the last real tab goes - a panel showing the chooser
 * must not report a `null` active row while a row is on screen.
 */
function nextActiveInstanceId(
  tabs: ReadonlyArray<LandingPanelTabRef>,
  placeholder: LandingPanelPlaceholder | null,
  current: string | null,
): string | null {
  if (
    current !== null &&
    (tabs.some((tab) => tab.instanceId === current) ||
      placeholder?.instanceId === current)
  ) {
    return current;
  }
  return firstTabInstanceId(tabs) ?? placeholder?.instanceId ?? null;
}

function hasPendingKill(
  pendingKills: ReadonlyArray<LandingPanelPendingKill>,
  identity: LandingPanelTabIdentity,
): boolean {
  const key = landingTabRefKey(identity);
  return pendingKills.some((pending) => landingTabRefKey(pending) === key);
}

export function hostAcknowledgedTab(
  tab: LandingTerminalTabRef,
  terminal: PlainTerminalProjection,
): LandingTerminalTabRef {
  const view = selectPlainTerminalViewModel(terminal);
  return {
    ...tab,
    sessionId: terminal.record.terminalId,
    hostId: terminal.record.hostId,
    cwd: terminal.record.launch.cwd,
    name: view.displayTitle,
    titleSource: terminal.record.manualTitle === null ? "default" : "manual",
    hostAuthorityAcknowledged: true,
    pendingCreate: false,
    sourceStoreVersion:
      tab.sourceStoreVersion ?? LANDING_TERMINAL_SOURCE_STORE_VERSION,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
