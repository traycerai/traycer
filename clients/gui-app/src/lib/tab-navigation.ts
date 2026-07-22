import { v4 as uuidv4 } from "uuid";
import type {
  NavigateOptions,
  UseNavigateResult,
} from "@tanstack/react-router";
import {
  draftPathname,
  readActiveEpicIdFromPath,
  readActiveEpicTabIdFromPath,
} from "@/lib/routes";
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/lib/settings-sections";
import {
  draftTabIntent,
  existingEpicTabIntent,
  existingEpicTabIntentWithNestedFocus,
  historyTabIntent,
  openEpicTabIntent,
  settingsTabIntent,
  type EpicPostResolvePreparation,
  type EpicRouteFocus,
  type TabActivationIntent,
  type TabNavigationIntent,
} from "@/lib/tab-navigation/intents";
import { parseNestedFocusTargetFromSearch } from "@/lib/epic-nested-focus-route";
import { hasRestoredTabs } from "@/lib/has-restored-tabs";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import {
  resolveTabIdForEpic,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { tabRouteOptions } from "@/stores/tabs/registry";
import {
  tabCommandCoordinator,
  type CoordinatedTabActivation,
  type CoordinatedTabActivationTarget,
} from "@/stores/tabs/tab-command-coordinator";
import { useTabsStore } from "@/stores/tabs/store";
import {
  findStripItemForRef,
  flattenStripItemRefs,
  tabRefKey,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import type { TabRef } from "@/stores/tabs/types";
import { normalizeEpicFocusSearch } from "@/routes/epic-route-search";

export {
  completeEpicMigrationIntent,
  draftTabIntent,
  existingEpicTabIntent,
  existingEpicTabIntentWithNestedFocus,
  historyTabIntent,
  newDraftTabIntent,
  openEpicFromListIntent,
  openExactEpicTabIntent,
  openEpicTabIntent,
  openPhaseMigrationIntent,
  resourceEpicTabIntent,
  settingsTabIntent,
  type EpicPostResolvePreparation,
  type EpicRouteFocus,
  type TabActivationIntent,
  type TabNavigationIntent,
} from "@/lib/tab-navigation/intents";

type NavigateFn = UseNavigateResult<string>;
type HistoryAction = "PUSH" | "REPLACE" | "BACK" | "FORWARD" | "GO";
type CorrectionKind = "repair-replace" | "external-replace" | "landing-replace";

export type TabNavigationDestination =
  | { readonly kind: "tab"; readonly refKey: string }
  | { readonly kind: "route"; readonly pathname: string };

export interface TabNavigationEnvelope {
  readonly sessionId: string;
  readonly token: string;
  readonly serial: number;
  readonly destination: TabNavigationDestination;
  /** Compatibility projection for diagnostics and older entry-shape assertions. */
  readonly targetRefKey: string;
  readonly intentKind:
    | "activate-push"
    | "focus-replace"
    | "repair-replace"
    | "external-replace"
    | "landing-replace";
}

export interface TabNavigationLocation {
  readonly pathname: string;
  readonly state: unknown;
  readonly search: Readonly<Record<string, unknown>> | undefined;
}

export type TabNavigationOptions = Pick<NavigateOptions, "replace" | "search">;

export interface TabNavigationDiagnostics {
  readonly pendingTokenCount: number;
  readonly repairCount: number;
  readonly authoritySerial: number;
  readonly sessionId: string;
  readonly resolutionFailure: boolean;
}

export interface TabNavigationResolutionFailure {
  readonly key: string | null;
  readonly pathname: string;
}

export type TabNavigationLocationReader = () => TabNavigationLocation;

interface RepairRoute {
  readonly intent: TabNavigationIntent;
  readonly committedSearch: Readonly<Record<string, unknown>> | undefined;
}

interface PreparedDraftSwap {
  readonly draftId: string;
  readonly epicId: string;
  readonly epicTabId: string;
  readonly epicName: string | undefined;
}

interface PendingNavigation {
  readonly envelope: TabNavigationEnvelope;
  readonly destination: TabNavigationDestination;
  readonly expectedRef: TabRef | null;
  readonly intent: TabNavigationIntent | null;
  readonly routeOptions: NavigateOptions;
  readonly activation: CoordinatedTabActivation | null;
  readonly preparedSwap: PreparedDraftSwap | null;
  readonly correctionKind: CorrectionKind | null;
  readonly correctionAttempt: 0 | 1;
  readonly correctionKey: string | null;
  placementCommitted: boolean;
}

interface QueuedActivation {
  readonly navigate: NavigateFn;
  readonly intent: TabActivationIntent;
  readonly options: TabNavigationOptions | undefined;
}

interface QueuedExternal {
  readonly location: TabNavigationLocation;
  readonly key: string | null;
  readonly preserveStartupFocus: boolean;
  readonly navigate: NavigateFn;
}

interface RoutedTabTarget {
  readonly ref: TabRef;
  readonly epicId: string | null;
}

interface BackingNavigation {
  readonly destination: TabNavigationDestination;
  readonly intent: TabNavigationIntent | null;
  readonly ref: TabRef | null;
  readonly options: NavigateOptions;
}

interface CorrectionRequest {
  readonly navigation: BackingNavigation;
  readonly kind: CorrectionKind;
  readonly attempt: 0 | 1;
  readonly correctionKey: string;
}

const HISTORY_ENVELOPE_KEY = "__traycerTabNavigation";
const DEFAULT_HISTORY_TAB_NAME = "History";
const DEFAULT_SETTINGS_TAB_NAME = "Settings";
const SETTINGS_PATH_PREFIX = "/settings";
const LEGACY_SERVICE_PATH = "/settings/service";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function locationKey(state: unknown): string | null {
  if (!isRecord(state)) return null;
  const routerKey = state.__TSR_key;
  if (typeof routerKey === "string") return routerKey;
  const legacyKey = state.key;
  return typeof legacyKey === "string" ? legacyKey : null;
}

function destinationFromValue(value: unknown): TabNavigationDestination | null {
  if (!isRecord(value)) return null;
  if (value.kind === "tab") {
    const refKey = value.refKey;
    return typeof refKey === "string" && refKey.length > 0
      ? { kind: "tab", refKey }
      : null;
  }
  if (value.kind === "route") {
    const pathname = value.pathname;
    return typeof pathname === "string" && pathname.startsWith("/")
      ? { kind: "route", pathname }
      : null;
  }
  return null;
}

function intentKindFromValue(
  value: unknown,
): TabNavigationEnvelope["intentKind"] | null {
  switch (value) {
    case "activate-push":
    case "focus-replace":
    case "repair-replace":
    case "external-replace":
    case "landing-replace":
      return value;
    default:
      return null;
  }
}

function envelopeFromState(state: unknown): TabNavigationEnvelope | null {
  if (!isRecord(state)) return null;
  const value = state[HISTORY_ENVELOPE_KEY];
  if (!isRecord(value)) return null;
  const sessionId = value.sessionId;
  const token = value.token;
  const serial = value.serial;
  const destination = destinationFromValue(value.destination);
  const targetRefKey = value.targetRefKey;
  const intentKind = intentKindFromValue(value.intentKind);
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof token !== "string" || token.length === 0) return null;
  if (!Number.isSafeInteger(serial) || Number(serial) < 0) return null;
  if (destination === null) return null;
  if (typeof targetRefKey !== "string" || targetRefKey.length === 0) {
    return null;
  }
  if (intentKind === null) return null;
  return {
    sessionId,
    token,
    serial: Number(serial),
    destination,
    targetRefKey,
    intentKind,
  };
}

function intentRef(intent: TabNavigationIntent): TabRef {
  switch (intent.kind) {
    case "epic":
      return { kind: "epic", id: intent.tabId };
    case "draft":
      return { kind: "draft", id: intent.draftId };
    case "history":
      return { kind: "history", id: "history" };
    case "settings":
      return { kind: "settings", id: "settings" };
  }
}

function refsEqual(left: TabRef | null, right: TabRef): boolean {
  return left !== null && tabRefKey(left) === tabRefKey(right);
}

function currentLayout(): PersistedTabStripLayout {
  const state = useTabsStore.getState();
  return {
    version: 2,
    items: state.items,
    activeItemId: state.activeItemId,
    systemTabs: state.systemTabs,
  };
}

function backingRefOfLayout(layout: PersistedTabStripLayout): TabRef | null {
  const active = layout.items.find((item) => item.id === layout.activeItemId);
  if (active === undefined) return null;
  if (active.kind === "tab") return active.ref;
  const side = active.routeBackingSide === "left" ? active.left : active.right;
  return side.kind === "tab" ? side.ref : null;
}

function activeItemContainsRef(
  layout: PersistedTabStripLayout,
  ref: TabRef,
): boolean {
  const active = layout.items.find((item) => item.id === layout.activeItemId);
  if (active === undefined) return false;
  if (active.kind === "tab") return refsEqual(active.ref, ref);
  return flattenStripItemRefs(active).some((candidate) =>
    refsEqual(candidate, ref),
  );
}

function activeEmptyFocusKeepsBackingRef(ref: TabRef): boolean {
  const layout = currentLayout();
  const active = layout.items.find((item) => item.id === layout.activeItemId);
  if (active?.kind !== "split") return false;
  const focused = active.focusedSide === "left" ? active.left : active.right;
  if (focused.kind === "tab") return false;
  return refsEqual(backingRefOfLayout(layout), ref);
}

function readDraftId(pathname: string): string | null {
  const prefix = "/draft/";
  if (!pathname.startsWith(prefix)) return null;
  const id = pathname.slice(prefix.length).replace(/\/$/, "");
  return id.length > 0 && draftPathname(id) === pathname.replace(/\/$/, "")
    ? id
    : null;
}

function isSettingsPath(pathname: string): boolean {
  return (
    pathname === SETTINGS_PATH_PREFIX ||
    pathname === `${SETTINGS_PATH_PREFIX}/` ||
    pathname.startsWith(`${SETTINGS_PATH_PREFIX}/`)
  );
}

function isHistoryPath(pathname: string): boolean {
  return pathname === "/epics" || pathname === "/epics/";
}

function isLandingPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/onboarding";
}

export function settingsSectionFromPath(
  pathname: string | null,
): SettingsSectionId {
  if (pathname === null) return "general";
  if (pathname === LEGACY_SERVICE_PATH) return "host";
  const match = SETTINGS_SECTIONS.find(
    (section) => `${SETTINGS_PATH_PREFIX}/${section.id}` === pathname,
  );
  return match === undefined ? "general" : match.id;
}

function routedTabTarget(pathname: string): RoutedTabTarget | null {
  const epicId = readActiveEpicIdFromPath(pathname);
  const epicTabId = readActiveEpicTabIdFromPath(pathname);
  if (epicId !== null && epicTabId !== null) {
    return { ref: { kind: "epic", id: epicTabId }, epicId };
  }
  const draftId = readDraftId(pathname);
  if (draftId !== null) {
    return { ref: { kind: "draft", id: draftId }, epicId: null };
  }
  if (isSettingsPath(pathname)) {
    return { ref: { kind: "settings", id: "settings" }, epicId: null };
  }
  if (isHistoryPath(pathname)) {
    return { ref: { kind: "history", id: "history" }, epicId: null };
  }
  return null;
}

function intentForRef(
  ref: TabRef,
  pathname: string,
  search: Readonly<Record<string, unknown>> | undefined,
): TabNavigationIntent | null {
  if (ref.kind === "epic") {
    const tab = useEpicCanvasStore.getState().tabsById[ref.id];
    if (tab === undefined || tab.epicId.length === 0) return null;
    const normalizedSearch = normalizeEpicFocusSearch(search ?? {});
    return existingEpicTabIntentWithNestedFocus({
      epicId: tab.epicId,
      tabId: tab.tabId,
      focus: {
        focusedAt: normalizedSearch.focusedAt,
        focusArtifactId: normalizedSearch.focusArtifactId,
        focusThreadId: normalizedSearch.focusThreadId,
        migrationSource: normalizedSearch.migrationSource,
      },
      nestedFocus: parseNestedFocusTargetFromSearch(search ?? {}),
    });
  }
  if (ref.kind === "draft") {
    const exists = useLandingDraftStore
      .getState()
      .drafts.some((draft) => draft.id === ref.id);
    return exists ? draftTabIntent(ref.id) : null;
  }
  if (ref.kind === "history") return historyTabIntent();
  return settingsTabIntent(settingsSectionFromPath(pathname));
}

function destinationForRef(ref: TabRef): TabNavigationDestination {
  return { kind: "tab", refKey: tabRefKey(ref) };
}

function destinationKey(destination: TabNavigationDestination): string {
  return destination.kind === "tab"
    ? destination.refKey
    : `route:${destination.pathname}`;
}

function destinationMatches(
  destination: TabNavigationDestination,
  location: TabNavigationLocation,
): boolean {
  if (destination.kind === "route") {
    return location.pathname === destination.pathname;
  }
  const target = routedTabTarget(location.pathname);
  if (target === null || tabRefKey(target.ref) !== destination.refKey) {
    return false;
  }
  if (target.ref.kind !== "epic") return true;
  const tab = useEpicCanvasStore.getState().tabsById[target.ref.id];
  return tab === undefined || tab.epicId === target.epicId;
}

function refIsMaterialized(ref: TabRef): boolean {
  if (ref.kind === "epic") {
    return useEpicCanvasStore.getState().tabsById[ref.id] !== undefined;
  }
  if (ref.kind === "draft") {
    return useLandingDraftStore
      .getState()
      .drafts.some((draft) => draft.id === ref.id);
  }
  return useTabsStore.getState().systemTabs[ref.kind] !== null;
}

function pendingDestinationMatches(
  pending: PendingNavigation,
  location: TabNavigationLocation,
): boolean {
  if (!destinationMatches(pending.destination, location)) return false;
  if (pending.expectedRef === null || pending.preparedSwap !== null)
    return true;
  return refIsMaterialized(pending.expectedRef);
}

function currentBackingMatches(destination: TabNavigationDestination): boolean {
  if (destination.kind === "route") return isLandingPath(destination.pathname);
  const ref = backingRefOfLayout(currentLayout());
  return ref !== null && tabRefKey(ref) === destination.refKey;
}

function applyEnvelope(
  options: NavigateOptions,
  envelope: TabNavigationEnvelope,
): NavigateOptions {
  return {
    ...options,
    state: (previous) => ({
      ...previous,
      [HISTORY_ENVELOPE_KEY]: envelope,
    }),
  };
}

function locationIdentity(location: TabNavigationLocation): string {
  return locationKey(location.state) ?? `path:${location.pathname}`;
}

function sameQueuedLocation(
  queued: QueuedExternal,
  current: TabNavigationLocation,
): boolean {
  const currentKey = locationKey(current.state);
  if (queued.key !== null || currentKey !== null)
    return queued.key === currentKey;
  return queued.location.pathname === current.pathname;
}

function systemActivationTarget(
  intent: Extract<TabNavigationIntent, { kind: "history" | "settings" }>,
): CoordinatedTabActivationTarget {
  if (intent.kind === "history") {
    return {
      kind: "system",
      systemKind: "history",
      name: DEFAULT_HISTORY_TAB_NAME,
      lastPath: "/epics",
    };
  }
  return {
    kind: "system",
    systemKind: "settings",
    name: DEFAULT_SETTINGS_TAB_NAME,
    lastPath: `/settings/${intent.section}`,
  };
}

export function openOrFocusEpicIntent(input: {
  readonly epicId: string;
  readonly focus: EpicRouteFocus | undefined;
}): Extract<TabActivationIntent, { kind: "open-epic" }> {
  return openEpicTabIntent(input);
}

export class TabNavigationController {
  private sessionId = uuidv4();
  private clock = 0;
  private authoritySerial = 0;
  private repairCount = 0;
  private hydrationReady = false;
  private currentLocation: TabNavigationLocation | null = null;
  private lastObservedKey: string | null = null;
  private locationReader: TabNavigationLocationReader | null = null;
  private navigator: NavigateFn | null = null;
  private queuedActivation: QueuedActivation | null = null;
  private queuedExternal: QueuedExternal | null = null;
  private resolutionFailure: TabNavigationResolutionFailure | null = null;
  private readonly pending = new Map<string, PendingNavigation>();
  private readonly latestRouteByRef = new Map<string, RepairRoute>();
  private readonly correctionKeys = new Set<string>();
  private readonly failureListeners = new Set<() => void>();

  activate(
    navigate: NavigateFn,
    intent: TabActivationIntent,
    options: TabNavigationOptions | undefined,
  ): boolean {
    this.navigator = navigate;
    if (!this.hydrationReady) {
      this.queuedActivation = { navigate, intent, options };
      return true;
    }
    return this.executeActivation(navigate, intent, options);
  }

  observeLocation(
    location: TabNavigationLocation,
    action: HistoryAction,
    navigate: NavigateFn,
  ): void {
    this.navigator = navigate;
    this.currentLocation = location;
    this.clearResolutionFailureFor(location);
    const key = locationKey(location.state);
    this.lastObservedKey = key;

    if (!this.hydrationReady) {
      this.establishExternalAuthority();
      this.queuedExternal = {
        location,
        key,
        preserveStartupFocus: false,
        navigate,
      };
      return;
    }

    if (action === "BACK" || action === "FORWARD" || action === "GO") {
      this.establishExternalAuthority();
      this.resolveExternalLocation(location, false, navigate);
      return;
    }

    const envelope = envelopeFromState(location.state);
    if (envelope === null || envelope.sessionId !== this.sessionId) {
      this.establishExternalAuthority();
      this.resolveExternalLocation(location, false, navigate);
      return;
    }

    const pending = this.pending.get(envelope.token);
    if (pending !== undefined) {
      if (pendingDestinationMatches(pending, location)) {
        this.acknowledge(pending, location, navigate);
        return;
      }
      this.establishExternalAuthority();
      this.resolveExternalLocation(location, false, navigate);
      return;
    }

    if (envelope.serial < this.authoritySerial) {
      this.repairStaleLocation(location, navigate);
      return;
    }
    if (envelope.serial === this.authoritySerial) {
      if (
        destinationMatches(envelope.destination, location) &&
        currentBackingMatches(envelope.destination)
      ) {
        this.refreshCurrentAuthorityRoute(location, envelope.destination);
        return;
      }
      this.establishExternalAuthority();
      this.resolveExternalLocation(location, false, navigate);
      return;
    }

    this.establishExternalAuthority();
    this.resolveExternalLocation(location, false, navigate);
  }

  synchronizeInitialLocation(): void {
    const location = this.readCurrentLocation();
    const navigate = this.navigator;
    if (location === null || navigate === null) return;
    const key = locationKey(location.state);
    const previousKey = this.lastObservedKey;
    const synchronizationOnly =
      previousKey !== null && key !== null && previousKey === key;
    const preserveStartupFocus = previousKey === null || synchronizationOnly;
    this.currentLocation = location;
    this.lastObservedKey = key;
    if (!this.hydrationReady) {
      if (!synchronizationOnly) this.establishExternalAuthority();
      this.queuedExternal = {
        location,
        key,
        preserveStartupFocus,
        navigate,
      };
      return;
    }
    const envelope = envelopeFromState(location.state);
    if (
      synchronizationOnly &&
      (envelope === null || envelope.sessionId !== this.sessionId)
    ) {
      this.resolveExternalLocation(location, true, navigate);
      return;
    }
    this.classifySynchronizedLocation(location, preserveStartupFocus, navigate);
  }

  setHydrationReady(ready: boolean, navigate: NavigateFn): void {
    this.navigator = navigate;
    if (!ready || this.hydrationReady) return;
    this.hydrationReady = true;
    const current = this.readCurrentLocation();
    const queuedExternal = this.queuedExternal;
    this.queuedExternal = null;
    if (current !== null && queuedExternal !== null) {
      if (sameQueuedLocation(queuedExternal, current)) {
        this.resolveExternalLocation(
          current,
          queuedExternal.preserveStartupFocus,
          navigate,
        );
      } else {
        this.establishExternalAuthority();
        this.resolveExternalLocation(current, false, navigate);
      }
    }
    const queuedActivation = this.queuedActivation;
    this.queuedActivation = null;
    if (queuedActivation !== null) {
      this.executeActivation(
        queuedActivation.navigate,
        queuedActivation.intent,
        queuedActivation.options,
      );
    }
  }

  setLocationReader(reader: TabNavigationLocationReader | null): void {
    this.locationReader = reader;
  }

  setNavigator(navigate: NavigateFn | null): void {
    this.navigator = navigate;
  }

  subscribeResolutionFailure(listener: () => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  hasResolutionFailure(state: unknown): boolean {
    if (this.resolutionFailure === null) return false;
    const key = locationKey(state);
    return this.resolutionFailure.key === key;
  }

  getDiagnostics(): TabNavigationDiagnostics {
    const pending = [...this.pending.values()];
    return {
      pendingTokenCount: pending.length,
      repairCount: this.repairCount,
      authoritySerial: this.authoritySerial,
      sessionId: this.sessionId,
      resolutionFailure: this.resolutionFailure !== null,
    };
  }

  resetForTesting(): void {
    this.sessionId = uuidv4();
    this.clock = 0;
    this.authoritySerial = 0;
    this.repairCount = 0;
    this.hydrationReady = true;
    this.currentLocation = null;
    this.lastObservedKey = null;
    this.locationReader = null;
    this.navigator = null;
    this.queuedActivation = null;
    this.queuedExternal = null;
    this.resolutionFailure = null;
    this.pending.clear();
    this.latestRouteByRef.clear();
    this.correctionKeys.clear();
    this.notifyFailureListeners();
  }

  resetHydrationForTesting(): void {
    this.hydrationReady = false;
    this.queuedActivation = null;
    this.queuedExternal = null;
  }

  private executeActivation(
    navigate: NavigateFn,
    requestedIntent: TabActivationIntent,
    options: TabNavigationOptions | undefined,
  ): boolean {
    const layoutBefore = currentLayout();
    if (requestedIntent.kind === "open-epic") {
      const prepared = this.prepareDraftSwap(requestedIntent, layoutBefore);
      if (prepared !== null) {
        this.issuePreparedSwap(navigate, requestedIntent, prepared, options);
        return true;
      }
    }

    const activationTarget = this.activationTarget(requestedIntent);
    const activation = tabCommandCoordinator.activateTab(activationTarget);
    if (activation === null) return false;
    const intent = this.canonicalIntent(requestedIntent, activation.ref);
    if (intent === null) {
      tabCommandCoordinator.restoreTabActivation(activation);
      return false;
    }
    const replace =
      options?.replace === true ||
      activeItemContainsRef(layoutBefore, activation.ref);
    this.supersedeAll();
    const envelope = this.createAuthorityEnvelope(
      destinationForRef(activation.ref),
      replace ? "focus-replace" : "activate-push",
    );
    const routeOptions = {
      ...tabRouteOptions(intent),
      ...(options?.search === undefined ? {} : { search: options.search }),
      replace,
    } satisfies NavigateOptions;
    const pending: PendingNavigation = {
      envelope,
      destination: envelope.destination,
      expectedRef: activation.ref,
      intent,
      routeOptions,
      activation,
      preparedSwap: null,
      correctionKind: null,
      correctionAttempt: 0,
      correctionKey: null,
      placementCommitted: true,
    };
    this.issueUserNavigation(navigate, pending);
    return true;
  }

  private activationTarget(
    intent: TabActivationIntent,
  ): CoordinatedTabActivationTarget {
    if (intent.kind === "complete-epic-migration") {
      return {
        kind: "migrated-epic",
        sourceEpicId: intent.sourceEpicId,
        epicId: intent.epicId,
        tabId: intent.tabId,
      };
    }
    if (intent.kind === "new-draft") {
      return {
        kind: "draft",
        draftId: null,
        settings: intent.settings,
        create: true,
      };
    }
    if (intent.kind === "open-epic") {
      return {
        kind: "epic",
        epicId: intent.epicId,
        tabId: intent.tabId,
        name: intent.name,
      };
    }
    if (intent.kind === "open-phase-migration") {
      return {
        kind: "phase-migration",
        phaseId: intent.phaseId,
        name: intent.name,
      };
    }
    if (intent.kind === "history" || intent.kind === "settings") {
      return systemActivationTarget(intent);
    }
    return { kind: "ref", ref: intentRef(intent) };
  }

  private canonicalIntent(
    requested: TabActivationIntent,
    ref: TabRef,
  ): TabNavigationIntent | null {
    if (requested.kind === "complete-epic-migration") {
      return ref.kind === "epic" && ref.id === requested.tabId
        ? existingEpicTabIntentWithNestedFocus({
            epicId: requested.epicId,
            tabId: requested.tabId,
            focus: requested.focus,
            nestedFocus: requested.nestedFocus,
          })
        : null;
    }
    if (requested.kind === "new-draft") {
      return ref.kind === "draft" ? draftTabIntent(ref.id) : null;
    }
    if (requested.kind === "open-epic") {
      if (ref.kind !== "epic") return null;
      const nestedFocus = this.prepareEpicTarget(ref.id, requested.preparation);
      return existingEpicTabIntentWithNestedFocus({
        epicId: requested.epicId,
        tabId: ref.id,
        focus: requested.focus,
        nestedFocus: requested.includeNestedFocus ? nestedFocus : null,
      });
    }
    if (requested.kind === "open-phase-migration") {
      if (ref.kind !== "epic") return null;
      return existingEpicTabIntentWithNestedFocus({
        epicId: requested.phaseId,
        tabId: ref.id,
        focus: requested.focus ?? {
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          migrationSource: "phase",
        },
        nestedFocus: null,
      });
    }
    return requested;
  }

  private prepareEpicTarget(
    tabId: string,
    preparation: EpicPostResolvePreparation | null,
  ) {
    if (preparation === null) return null;
    const canvas = useEpicCanvasStore.getState();
    if (preparation.kind === "open-tile") {
      return canvas.prepareOpenTileInTabFocusTarget(tabId, preparation.node);
    }
    return canvas.prepareSetActiveTileTabFocusTarget(
      tabId,
      preparation.paneId,
      preparation.tileTabId,
    );
  }

  private prepareDraftSwap(
    intent: Extract<TabActivationIntent, { kind: "open-epic" }>,
    layout: PersistedTabStripLayout,
  ): PreparedDraftSwap | null {
    const draftId = intent.replaceEmptyDraftId;
    if (draftId === null) return null;
    const draftRef: TabRef = { kind: "draft", id: draftId };
    if (findStripItemForRef(layout, draftRef) === null) return null;
    const canvas = useEpicCanvasStore.getState();
    const existingId = resolveTabIdForEpic(canvas, intent.epicId);
    if (
      existingId !== null &&
      findStripItemForRef(layout, { kind: "epic", id: existingId }) !== null
    ) {
      return null;
    }
    return {
      draftId,
      epicId: intent.epicId,
      epicTabId: existingId ?? uuidv4(),
      epicName: intent.name,
    };
  }

  private issuePreparedSwap(
    navigate: NavigateFn,
    requested: Extract<TabActivationIntent, { kind: "open-epic" }>,
    swap: PreparedDraftSwap,
    options: TabNavigationOptions | undefined,
  ): void {
    const intent = existingEpicTabIntent({
      epicId: swap.epicId,
      tabId: swap.epicTabId,
      focus: requested.focus,
    });
    this.supersedeAll();
    const ref: TabRef = { kind: "epic", id: swap.epicTabId };
    const envelope = this.createAuthorityEnvelope(
      destinationForRef(ref),
      "focus-replace",
    );
    const routeOptions = {
      ...tabRouteOptions(intent),
      ...(options?.search === undefined ? {} : { search: options.search }),
      replace: true,
    } satisfies NavigateOptions;
    const pending: PendingNavigation = {
      envelope,
      destination: envelope.destination,
      expectedRef: ref,
      intent,
      routeOptions,
      activation: null,
      preparedSwap: swap,
      correctionKind: null,
      correctionAttempt: 0,
      correctionKey: null,
      placementCommitted: false,
    };
    this.issueUserNavigation(navigate, pending);
  }

  private issueUserNavigation(
    navigate: NavigateFn,
    pending: PendingNavigation,
  ): void {
    this.pending.set(pending.envelope.token, pending);
    try {
      void navigate(applyEnvelope(pending.routeOptions, pending.envelope)).then(
        () => this.settle(pending.envelope.token, navigate),
        () => this.cancelUserNavigation(pending.envelope.token, navigate),
      );
    } catch {
      this.cancelUserNavigation(pending.envelope.token, navigate);
    }
  }

  private createAuthorityEnvelope(
    destination: TabNavigationDestination,
    intentKind: TabNavigationEnvelope["intentKind"],
  ): TabNavigationEnvelope {
    const serial = this.nextAuthoritySerial();
    return {
      sessionId: this.sessionId,
      token: uuidv4(),
      serial,
      destination,
      targetRefKey: destinationKey(destination),
      intentKind,
    };
  }

  private nextAuthoritySerial(): number {
    this.clock += 1;
    this.authoritySerial = this.clock;
    return this.authoritySerial;
  }

  private establishExternalAuthority(): void {
    this.supersedeAll();
    this.nextAuthoritySerial();
  }

  private classifySynchronizedLocation(
    location: TabNavigationLocation,
    preserveStartupFocus: boolean,
    navigate: NavigateFn,
  ): void {
    const envelope = envelopeFromState(location.state);
    if (envelope !== null && envelope.sessionId === this.sessionId) {
      this.observeLocation(location, "REPLACE", navigate);
      return;
    }
    this.establishExternalAuthority();
    this.resolveExternalLocation(location, preserveStartupFocus, navigate);
  }

  private acknowledge(
    pending: PendingNavigation,
    location: TabNavigationLocation,
    navigate: NavigateFn,
  ): void {
    this.authoritySerial = Math.max(
      this.authoritySerial,
      pending.envelope.serial,
    );
    if (pending.correctionKey !== null) {
      this.correctionKeys.delete(pending.correctionKey);
      this.clearResolutionFailureFor(location);
    }
    if (pending.preparedSwap !== null && !pending.placementCommitted) {
      pending.placementCommitted = true;
      const swap = pending.preparedSwap;
      let replaced: TabRef | null = null;
      try {
        replaced = tabCommandCoordinator.replaceDraftWithEpic({
          draftId: swap.draftId,
          epicId: swap.epicId,
          epicTabId: swap.epicTabId,
          epicName: swap.epicName,
        });
      } catch {
        replaced = null;
      }
      if (replaced === null) {
        const backing = this.backingNavigation();
        this.issueCorrection(navigate, {
          navigation: backing,
          kind: "repair-replace",
          attempt: 0,
          correctionKey: locationIdentity(location),
        });
        return;
      }
    }
    this.rememberAcknowledgedRoute(pending, location);
    // Once the exact entry is acknowledged, rollback and one-shot placement
    // are complete. The session+serial envelope classifies any later delivery,
    // so the full record can compact even if TanStack's promise settles later.
    this.pending.delete(pending.envelope.token);
  }

  private rememberAcknowledgedRoute(
    pending: PendingNavigation,
    location: TabNavigationLocation,
  ): void {
    const ref = pending.expectedRef;
    if (ref === null) return;
    const intent =
      intentForRef(ref, location.pathname, location.search) ?? pending.intent;
    if (intent !== null) this.rememberRoute(ref, intent, location.search);
    if (ref.kind === "history" || ref.kind === "settings") {
      useTabsStore
        .getState()
        .rememberSystemTabPath(ref.kind, location.pathname);
    }
  }

  private settle(token: string, navigate: NavigateFn): void {
    const pending = this.pending.get(token);
    if (pending === undefined) return;
    const location = this.readCurrentLocation();
    if (
      location !== null &&
      envelopeFromState(location.state)?.token === token &&
      pendingDestinationMatches(pending, location)
    ) {
      this.acknowledge(pending, location, navigate);
    }
  }

  private cancelUserNavigation(token: string, navigate: NavigateFn): void {
    const pending = this.pending.get(token);
    if (pending === undefined) return;
    if (pending.correctionKind !== null) {
      this.handleCorrectionFailure(pending, navigate);
      return;
    }
    this.pending.delete(token);
    if (pending.activation !== null) {
      tabCommandCoordinator.restoreTabActivation(pending.activation);
    }
    this.nextAuthoritySerial();
    const current = this.readCurrentLocation();
    const backing = this.backingNavigation();
    if (current !== null && !destinationMatches(backing.destination, current)) {
      this.issueCorrection(navigate, {
        navigation: backing,
        kind: "repair-replace",
        attempt: 0,
        correctionKey: locationIdentity(current),
      });
    }
  }

  private supersedeAll(): void {
    this.pending.forEach((pending, token) => {
      if (pending.correctionKey !== null) {
        this.correctionKeys.delete(pending.correctionKey);
      }
      this.pending.delete(token);
    });
  }

  private repairStaleLocation(
    location: TabNavigationLocation,
    navigate: NavigateFn,
  ): void {
    const key = locationIdentity(location);
    if (this.correctionKeys.has(key)) return;
    const backing = this.backingNavigation();
    this.issueCorrection(navigate, {
      navigation: backing,
      kind: "repair-replace",
      attempt: 0,
      correctionKey: key,
    });
  }

  private backingNavigation(): BackingNavigation {
    const ref = backingRefOfLayout(currentLayout());
    if (ref === null) {
      return {
        destination: { kind: "route", pathname: "/" },
        intent: null,
        ref: null,
        options: { to: "/", replace: true },
      };
    }
    const route = this.latestRouteByRef.get(tabRefKey(ref));
    const pendingRoute = [...this.pending.values()].find(
      (entry) =>
        entry.expectedRef !== null && refsEqual(entry.expectedRef, ref),
    );
    const intent =
      pendingRoute?.intent ??
      route?.intent ??
      intentForRef(
        ref,
        this.currentLocation?.pathname ?? "/",
        this.currentLocation?.search,
      );
    if (intent === null) {
      return {
        destination: { kind: "route", pathname: "/" },
        intent: null,
        ref: null,
        options: { to: "/", replace: true },
      };
    }
    const base = pendingRoute?.routeOptions ?? tabRouteOptions(intent);
    const options =
      pendingRoute === undefined && route?.committedSearch !== undefined
        ? { ...base, search: route.committedSearch, replace: true }
        : { ...base, replace: true };
    return {
      destination: destinationForRef(ref),
      intent,
      ref,
      options,
    };
  }

  private issueCorrection(
    navigate: NavigateFn,
    request: CorrectionRequest,
  ): void {
    const { navigation, kind, attempt, correctionKey } = request;
    if (this.correctionKeys.has(correctionKey)) return;
    this.supersedeAll();
    this.correctionKeys.add(correctionKey);
    const envelope = this.createAuthorityEnvelope(navigation.destination, kind);
    const routeOptions = {
      ...navigation.options,
      replace: true,
      ignoreBlocker: true,
    } satisfies NavigateOptions;
    const pending: PendingNavigation = {
      envelope,
      destination: navigation.destination,
      expectedRef: navigation.ref,
      intent: navigation.intent,
      routeOptions,
      activation: null,
      preparedSwap: null,
      correctionKind: kind,
      correctionAttempt: attempt,
      correctionKey,
      placementCommitted: true,
    };
    this.pending.set(envelope.token, pending);
    if (kind === "repair-replace") this.repairCount += 1;
    try {
      void navigate(applyEnvelope(routeOptions, envelope)).then(
        () => this.settle(envelope.token, navigate),
        () => this.handleCorrectionFailure(pending, navigate),
      );
    } catch {
      this.handleCorrectionFailure(pending, navigate);
    }
  }

  private handleCorrectionFailure(
    pending: PendingNavigation,
    navigate: NavigateFn,
  ): void {
    const live = this.pending.get(pending.envelope.token);
    if (live === undefined) return;
    this.pending.delete(live.envelope.token);
    const correctionKey = live.correctionKey;
    if (correctionKey !== null) this.correctionKeys.delete(correctionKey);
    if (live.correctionAttempt === 0 && live.correctionKind !== null) {
      this.issueCorrection(navigate, {
        navigation: {
          destination: live.destination,
          intent: live.intent,
          ref: live.expectedRef,
          options: live.routeOptions,
        },
        kind: live.correctionKind,
        attempt: 1,
        correctionKey:
          correctionKey ?? locationIdentity(this.currentLocationOrLanding()),
      });
      return;
    }
    const current = this.currentLocationOrLanding();
    this.resolutionFailure = {
      key: locationKey(current.state),
      pathname: current.pathname,
    };
    this.notifyFailureListeners();
  }

  private resolveExternalLocation(
    location: TabNavigationLocation,
    preserveStartupFocus: boolean,
    navigate: NavigateFn,
  ): void {
    if (location.pathname === "/draft/new") {
      this.resolveDraftEntry(location, navigate);
      return;
    }
    const routed = routedTabTarget(location.pathname);
    if (routed === null) {
      if (isLandingPath(location.pathname)) return;
      this.issueLandingCorrection(location, navigate);
      return;
    }
    const ref = routed.ref;
    if (preserveStartupFocus && activeEmptyFocusKeepsBackingRef(ref)) {
      const intent = intentForRef(ref, location.pathname, location.search);
      if (intent !== null) this.rememberRoute(ref, intent, location.search);
      return;
    }

    switch (ref.kind) {
      case "epic":
        this.resolveExternalEpic(location, routed, navigate);
        return;
      case "draft":
        this.resolveExternalDraft(location, ref.id, navigate);
        return;
      case "history":
      case "settings":
        this.resolveExternalSystem(location, ref.kind, navigate);
    }
  }

  private resolveExternalEpic(
    location: TabNavigationLocation,
    routed: RoutedTabTarget,
    navigate: NavigateFn,
  ): void {
    const ref = routed.ref;
    if (ref.kind !== "epic") return;
    const tab = useEpicCanvasStore.getState().tabsById[ref.id];
    if (tab !== undefined && tab.epicId === routed.epicId) {
      const activation = this.activateExternalTarget({ kind: "ref", ref });
      if (activation === null) {
        this.issueLandingCorrection(location, navigate);
        return;
      }
      const intent = intentForRef(ref, location.pathname, location.search);
      if (intent !== null) this.rememberRoute(ref, intent, location.search);
      return;
    }
    if (routed.epicId === null) {
      this.issueLandingCorrection(location, navigate);
      return;
    }
    const activation = this.activateExternalTarget({
      kind: "epic",
      epicId: routed.epicId,
      tabId: null,
      name: undefined,
    });
    if (activation === null || activation.ref.kind !== "epic") {
      this.issueLandingCorrection(location, navigate);
      return;
    }
    const search = normalizeEpicFocusSearch(location.search ?? {});
    const intent = existingEpicTabIntent({
      epicId: routed.epicId,
      tabId: activation.ref.id,
      focus: {
        focusedAt: search.focusedAt,
        focusArtifactId: search.focusArtifactId,
        focusThreadId: search.focusThreadId,
        migrationSource: search.migrationSource,
      },
    });
    if (activation.ref.id === ref.id) {
      this.rememberRoute(activation.ref, intent, location.search);
      return;
    }
    this.issueCorrection(navigate, {
      navigation: {
        destination: destinationForRef(activation.ref),
        intent,
        ref: activation.ref,
        options: {
          ...tabRouteOptions(intent),
          search: location.search,
          replace: true,
        },
      },
      kind: "external-replace",
      attempt: 0,
      correctionKey: locationIdentity(location),
    });
  }

  private resolveExternalDraft(
    location: TabNavigationLocation,
    draftId: string,
    navigate: NavigateFn,
  ): void {
    const ref: TabRef = { kind: "draft", id: draftId };
    const exists = useLandingDraftStore
      .getState()
      .drafts.some((draft) => draft.id === draftId);
    if (!exists) {
      this.issueLandingCorrection(location, navigate);
      return;
    }
    const activation = this.activateExternalTarget({ kind: "ref", ref });
    if (activation === null) this.issueLandingCorrection(location, navigate);
    else this.rememberRoute(ref, draftTabIntent(draftId), location.search);
  }

  private resolveExternalSystem(
    location: TabNavigationLocation,
    kind: "history" | "settings",
    navigate: NavigateFn,
  ): void {
    const ref: TabRef = { kind, id: kind };
    const systemIntent =
      kind === "history"
        ? historyTabIntent()
        : settingsTabIntent(settingsSectionFromPath(location.pathname));
    const activation = this.activateExternalTarget(
      systemActivationTarget(systemIntent),
    );
    if (activation === null) {
      this.issueLandingCorrection(location, navigate);
      return;
    }
    this.rememberRoute(ref, systemIntent, location.search);
    useTabsStore.getState().rememberSystemTabPath(kind, location.pathname);
  }

  private resolveDraftEntry(
    location: TabNavigationLocation,
    navigate: NavigateFn,
  ): void {
    if (hasRestoredTabs()) {
      this.issueLandingCorrection(location, navigate);
      return;
    }
    const activation = this.activateExternalTarget({
      kind: "draft",
      draftId: null,
      settings: useComposerRunSettingsStore.getState().globalLastRunSettings,
      create: true,
    });
    if (activation === null || activation.ref.kind !== "draft") {
      this.issueLandingCorrection(location, navigate);
      return;
    }
    const intent = draftTabIntent(activation.ref.id);
    this.issueCorrection(navigate, {
      navigation: {
        destination: destinationForRef(activation.ref),
        intent,
        ref: activation.ref,
        options: { ...tabRouteOptions(intent), replace: true },
      },
      kind: "external-replace",
      attempt: 0,
      correctionKey: locationIdentity(location),
    });
  }

  private activateExternalTarget(
    target: CoordinatedTabActivationTarget,
  ): CoordinatedTabActivation | null {
    try {
      return tabCommandCoordinator.activateTab(target);
    } catch {
      return null;
    }
  }

  private issueLandingCorrection(
    location: TabNavigationLocation,
    navigate: NavigateFn,
  ): void {
    this.issueCorrection(navigate, {
      navigation: {
        destination: { kind: "route", pathname: "/" },
        intent: null,
        ref: null,
        options: { to: "/", replace: true },
      },
      kind: "landing-replace",
      attempt: 0,
      correctionKey: locationIdentity(location),
    });
  }

  private refreshCurrentAuthorityRoute(
    location: TabNavigationLocation,
    destination: TabNavigationDestination,
  ): void {
    if (destination.kind !== "tab") return;
    const routed = routedTabTarget(location.pathname);
    if (routed === null || tabRefKey(routed.ref) !== destination.refKey) return;
    const intent = intentForRef(routed.ref, location.pathname, location.search);
    if (intent !== null)
      this.rememberRoute(routed.ref, intent, location.search);
  }

  private rememberRoute(
    ref: TabRef,
    intent: TabNavigationIntent,
    committedSearch: Readonly<Record<string, unknown>> | undefined,
  ): void {
    this.latestRouteByRef.set(tabRefKey(ref), { intent, committedSearch });
  }

  private currentLocationOrLanding(): TabNavigationLocation {
    return (
      this.readCurrentLocation() ?? {
        pathname: "/",
        state: {},
        search: undefined,
      }
    );
  }

  private readCurrentLocation(): TabNavigationLocation | null {
    if (this.locationReader !== null) {
      this.currentLocation = this.locationReader();
    }
    return this.currentLocation;
  }

  private clearResolutionFailureFor(location: TabNavigationLocation): void {
    const failure = this.resolutionFailure;
    if (failure === null) return;
    if (
      failure.key === locationKey(location.state) &&
      failure.pathname === location.pathname
    ) {
      return;
    }
    this.resolutionFailure = null;
    this.notifyFailureListeners();
  }

  private notifyFailureListeners(): void {
    this.failureListeners.forEach((listener) => listener());
  }
}

export const tabNavigationController = new TabNavigationController();

export function activateTabIntent(
  navigate: NavigateFn,
  intent: TabActivationIntent,
  options: TabNavigationOptions | undefined,
): boolean {
  return tabNavigationController.activate(navigate, intent, options);
}

export function navigateToTabIntent(
  navigate: NavigateFn,
  intent: TabActivationIntent,
  options: Pick<NavigateOptions, "replace"> | undefined,
): void {
  activateTabIntent(navigate, intent, options);
}

export function __resetTabNavigationControllerForTesting(): void {
  tabNavigationController.resetForTesting();
}

export function __resetTabNavigationHydrationForTesting(): void {
  tabNavigationController.resetHydrationForTesting();
}

export function getTabNavigationDiagnostics(): TabNavigationDiagnostics {
  return tabNavigationController.getDiagnostics();
}

export function subscribeTabNavigationResolutionFailure(
  listener: () => void,
): () => void {
  return tabNavigationController.subscribeResolutionFailure(listener);
}

export function tabNavigationResolutionFailed(state: unknown): boolean {
  return tabNavigationController.hasResolutionFailure(state);
}
