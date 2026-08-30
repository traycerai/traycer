import type {
  BrowserCdpFrameInfo,
  BrowserCdpTarget,
} from "@traycer/protocol/host/browser/contracts";
import type { BrowserViewDebugger } from "../browser-view-port";
import { describeLogError, log } from "../../app/logger";
import { recordValue, stringValue } from "../guards";

type ChildFrameRoute = {
  readonly kind: "unresolved" | "same-process";
  readonly parentFrameId: string;
};

type FrameRoute =
  | {
      readonly kind: "root";
      readonly parentFrameId: null;
    }
  | ChildFrameRoute;

interface ChildSession {
  readonly attachmentGeneration: number;
  readonly parentFrameId: string;
  route: FrameRoute;
  state: "attaching" | "ready" | "retiring";
  sessionId: string | null;
  readonly readiness: Promise<string>;
  readonly rejectReadiness: (reason: Error) => void;
  retirement: Promise<boolean> | null;
}

export interface ResolvedTargetRoute {
  readonly attachmentGeneration: number;
  readonly topologyRevision: number;
  readonly frameId: string | null;
  readonly frameRoute: FrameRoute | null;
  readonly childTargetId: string | null;
  readonly childSession: ChildSession | null;
  readonly sessionId: string | null;
}

/**
 * What the frame topology needs from the debug session that owns the
 * attachment: a way to send, and the generation the routes are valid against.
 */
export interface BrowserFrameRoutesPort {
  /** The attachment the routes dispatch through. */
  readonly browserDebugger: () => BrowserViewDebugger;
  /** False once the session is disposed or the debugger detached. */
  readonly isAttached: () => boolean;
  /** False until the domains are enabled; implies `isAttached`. */
  readonly isReady: () => boolean;
  /** Bumped by the session on every re-attach; recorded routes die with it. */
  readonly generation: () => number;
  /** The session's readiness-guarded `sendCommand`. */
  readonly send: (
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ) => Promise<unknown>;
  /** Rejects `work` with `message` once the attachment or session ends. */
  readonly raceWithSessionEnd: <T>(
    work: Promise<T>,
    message: string,
  ) => Promise<T>;
  /** Resolves when the current attachment ends. */
  readonly attachmentEnded: () => Promise<void>;
}

/**
 * OOPIF topology: which frame lives in which target, and the child debugger
 * sessions attached to the out-of-process ones.
 */
export class BrowserFrameRoutes {
  private readonly port: BrowserFrameRoutesPort;
  private readonly childSessionByTargetId = new Map<string, ChildSession>();
  private readonly frameRouteById = new Map<string, FrameRoute>();
  private readonly detachedChildSessionIds = new Set<string>();
  private topologyRevision = 0;
  private targetDiscovery: {
    readonly revision: number;
    readonly promise: Promise<ReadonlySet<string>>;
  } | null = null;

  constructor(port: BrowserFrameRoutesPort) {
    this.port = port;
  }

  resolveTarget(target: BrowserCdpTarget): Promise<ResolvedTargetRoute> {
    const attachmentGeneration = this.port.generation();
    if (target.kind === "root") {
      return Promise.resolve({
        attachmentGeneration,
        topologyRevision: this.topologyRevision,
        frameId: null,
        frameRoute: null,
        childTargetId: null,
        childSession: null,
        sessionId: null,
      });
    }
    return this.resolveFrameRoute(
      target.frameId,
      target.parentFrameId,
      attachmentGeneration,
    );
  }

  requireCurrentTargetRoute(
    route: ResolvedTargetRoute,
    requireTopologyRevision: boolean,
  ): void {
    if (
      !this.port.isReady() ||
      this.port.generation() !== route.attachmentGeneration ||
      (requireTopologyRevision &&
        this.topologyRevision !== route.topologyRevision) ||
      (route.frameId !== null &&
        this.frameRouteById.get(route.frameId) !== route.frameRoute) ||
      (route.childTargetId !== null &&
        (this.childSessionByTargetId.get(route.childTargetId) !==
          route.childSession ||
          route.childSession?.state !== "ready" ||
          route.childSession.sessionId !== route.sessionId))
    ) {
      throw new Error("Browser target route changed before command dispatch.");
    }
  }

  recordFrameTreeRoute(
    resolvedRoute: ResolvedTargetRoute,
    frames: readonly BrowserCdpFrameInfo[],
  ): void {
    if (
      resolvedRoute.childTargetId !== null &&
      resolvedRoute.childSession !== null
    ) {
      const currentRoute = this.frameRouteById.get(resolvedRoute.childTargetId);
      if (
        currentRoute === undefined ||
        this.childSessionByTargetId.get(resolvedRoute.childTargetId) !==
          resolvedRoute.childSession
      ) {
        throw new Error("Child frame route changed while recording its tree.");
      }
      this.mergeFrameSubtree(
        resolvedRoute.childTargetId,
        this.buildFrameRoutes(
          frames,
          resolvedRoute.childTargetId,
          currentRoute,
        ),
      );
      return;
    }

    const rootFrames = frames.filter((frame) => frame.parentFrameId === null);
    const rootFrame = rootFrames[0];
    if (rootFrame === undefined || rootFrames.length !== 1) {
      throw new Error(
        "Malformed CDP response: Page.getFrameTree must contain one root frame.",
      );
    }
    this.replaceFrameRoutes(
      this.buildFrameRoutes(frames, rootFrame.frameId, {
        kind: "root",
        parentFrameId: null,
      }),
    );
  }

  handleTargetDetached(params: Record<string, unknown>): void {
    const sessionId = stringValue(params.sessionId);
    if (sessionId !== null) {
      this.detachedChildSessionIds.add(sessionId);
      this.topologyRevision += 1;
      this.forgetChildSession(sessionId, stringValue(params.targetId));
    }
  }

  handleFrameAttached(
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    const frameId = stringValue(params.frameId);
    const parentFrameId = stringValue(params.parentFrameId);
    if (
      frameId === null ||
      parentFrameId === null ||
      frameId === parentFrameId ||
      !this.frameRouteById.has(parentFrameId) ||
      !this.isAuthorizedFrameEvent(parentFrameId, sessionId)
    ) {
      return;
    }
    const currentRoute = this.frameRouteById.get(frameId);
    if (currentRoute?.parentFrameId === parentFrameId) return;
    if (currentRoute !== undefined) this.forgetFrameBranch(frameId);
    this.frameRouteById.set(frameId, {
      kind: "unresolved",
      parentFrameId,
    });
    this.topologyRevision += 1;
  }

  handleFrameNavigated(
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    const frame = recordValue(params.frame);
    const frameId = stringValue(frame?.id);
    if (frameId === null) return;
    const parentFrameId = stringValue(frame?.parentId);
    if (sessionId === undefined && parentFrameId === null) {
      this.clear();
      this.frameRouteById.set(frameId, {
        kind: "root",
        parentFrameId: null,
      });
      return;
    }
    const currentRoute = this.frameRouteById.get(frameId);
    if (currentRoute === undefined) {
      if (
        parentFrameId !== null &&
        this.frameRouteById.has(parentFrameId) &&
        this.isAuthorizedFrameEvent(parentFrameId, sessionId)
      ) {
        this.frameRouteById.set(frameId, {
          kind: "unresolved",
          parentFrameId,
        });
        this.topologyRevision += 1;
      }
      return;
    }
    if (
      currentRoute.kind === "root" ||
      !this.isAuthorizedFrameEvent(frameId, sessionId)
    ) {
      return;
    }
    const recordedParentFrameId = parentFrameId ?? currentRoute.parentFrameId;
    if (
      this.collectFrameBranch(frameId).has(recordedParentFrameId) ||
      !this.frameRouteById.has(recordedParentFrameId)
    ) {
      this.forgetFrameBranch(frameId);
      return;
    }
    this.refreshFrameBranch(frameId, recordedParentFrameId, sessionId);
  }

  handleFrameDetached(
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    const frameId = stringValue(params.frameId);
    if (frameId !== null && this.isAuthorizedFrameEvent(frameId, sessionId)) {
      this.forgetFrameBranch(frameId);
    }
  }

  /** Drops every recorded route and retires the child sessions under them. */
  clear(): void {
    this.topologyRevision += 1;
    this.frameRouteById.clear();
    for (const [targetId, childSession] of this.childSessionByTargetId) {
      this.retireChildSessionRecord(targetId, childSession);
    }
  }

  rejectPending(message: string): void {
    const error = new Error(message);
    for (const childSession of this.childSessionByTargetId.values()) {
      childSession.rejectReadiness(error);
    }
  }

  /** Forgets everything the previous attachment recorded. */
  resetForNewAttachment(): void {
    this.topologyRevision += 1;
    this.targetDiscovery = null;
    this.detachedChildSessionIds.clear();
    this.frameRouteById.clear();
    this.childSessionByTargetId.clear();
  }

  private async resolveFrameRoute(
    frameId: string,
    parentFrameId: string,
    attachmentGeneration: number,
  ): Promise<ResolvedTargetRoute> {
    const route = this.requireCurrentFrameRoute(
      frameId,
      null,
      attachmentGeneration,
    );
    if (route.parentFrameId !== parentFrameId) {
      throw new Error(
        `Cannot resolve frame ${frameId}: expected parent ${route.parentFrameId ?? "<root>"}, received ${parentFrameId}.`,
      );
    }
    const resolved = await this.resolveRecordedFrameRoute(
      frameId,
      route,
      attachmentGeneration,
    );
    const currentRoute = this.requireCurrentFrameRoute(
      frameId,
      resolved.frameRoute,
      attachmentGeneration,
    );
    if (currentRoute.parentFrameId !== parentFrameId) {
      throw new Error(
        `Cannot resolve frame ${frameId}: expected parent ${currentRoute.parentFrameId ?? "<root>"}, received ${parentFrameId}.`,
      );
    }
    return resolved;
  }

  private async resolveRecordedFrameRoute(
    frameId: string,
    expectedRoute: FrameRoute,
    attachmentGeneration: number,
  ): Promise<ResolvedTargetRoute> {
    let route = this.requireCurrentFrameRoute(
      frameId,
      expectedRoute,
      attachmentGeneration,
    );
    const recorded = this.routeAfterRefresh(
      frameId,
      route,
      attachmentGeneration,
    );
    if (recorded !== null) return await recorded;

    const iframeTargetIds = await this.discoverIframeTargetIds();
    route = this.requireCurrentFrameRoute(frameId, route, attachmentGeneration);
    const discovered = this.routeAfterRefresh(
      frameId,
      route,
      attachmentGeneration,
    );
    if (discovered !== null) return await discovered;
    if (route.kind !== "unresolved") {
      // routeAfterRefresh resolves every other kind.
      throw new Error(`Frame routes changed while resolving frame ${frameId}.`);
    }
    if (iframeTargetIds.has(frameId)) {
      return this.ensureChildSession(frameId, route, attachmentGeneration);
    }

    const sameProcessRoute: FrameRoute = {
      kind: "same-process",
      parentFrameId: route.parentFrameId,
    };
    this.frameRouteById.set(frameId, sameProcessRoute);
    this.topologyRevision += 1;
    return this.resolveRecordedFrameRoute(
      frameId,
      sameProcessRoute,
      attachmentGeneration,
    );
  }

  /**
   * The decision a recorded route already answers: an attached child target,
   * the root, or a same-process parent to inherit. Null means only target
   * discovery can decide, and this same check runs again once it lands.
   */
  private routeAfterRefresh(
    frameId: string,
    route: FrameRoute,
    attachmentGeneration: number,
  ): Promise<ResolvedTargetRoute> | null {
    const childSession = this.childSessionByTargetId.get(frameId);
    if (childSession !== undefined) {
      return this.waitForChildSession(
        frameId,
        route,
        attachmentGeneration,
        childSession,
      );
    }
    if (route.kind === "root") {
      return Promise.resolve({
        attachmentGeneration,
        topologyRevision: this.topologyRevision,
        frameId,
        frameRoute: route,
        childTargetId: null,
        childSession: null,
        sessionId: null,
      });
    }
    if (route.kind === "same-process") {
      return this.inheritParentRoute(frameId, route, attachmentGeneration);
    }
    return null;
  }

  private async inheritParentRoute(
    frameId: string,
    route: ChildFrameRoute,
    attachmentGeneration: number,
  ): Promise<ResolvedTargetRoute> {
    const parentRoute = this.requireCurrentFrameRoute(
      route.parentFrameId,
      null,
      attachmentGeneration,
    );
    const parent = await this.resolveRecordedFrameRoute(
      route.parentFrameId,
      parentRoute,
      attachmentGeneration,
    );
    this.requireCurrentFrameRoute(frameId, route, attachmentGeneration);
    return { ...parent, frameId, frameRoute: route };
  }

  private async waitForChildSession(
    frameId: string,
    route: FrameRoute,
    attachmentGeneration: number,
    childSession: ChildSession,
  ): Promise<ResolvedTargetRoute> {
    if (childSession.state === "retiring") {
      const retirement = childSession.retirement;
      if (retirement === null) {
        throw new Error(`Child debugger session ${frameId} has no retirement.`);
      }
      if (!(await retirement)) {
        throw new Error(`Child debugger session ${frameId} could not retire.`);
      }
      const currentRoute = this.requireCurrentFrameRoute(
        frameId,
        route,
        attachmentGeneration,
      );
      return this.resolveRecordedFrameRoute(
        frameId,
        currentRoute,
        attachmentGeneration,
      );
    }
    if (childSession.parentFrameId !== route.parentFrameId) {
      throw new Error(
        `Cannot resolve frame ${frameId}: expected parent ${childSession.parentFrameId}, received ${route.parentFrameId ?? "<root>"}.`,
      );
    }
    const sessionId = await childSession.readiness;
    this.requireCurrentFrameRoute(frameId, route, attachmentGeneration);
    if (
      this.childSessionByTargetId.get(frameId) !== childSession ||
      childSession.state !== "ready" ||
      childSession.sessionId !== sessionId
    ) {
      throw new Error(
        `Child debugger session ${frameId} changed while enabling.`,
      );
    }
    return {
      attachmentGeneration,
      topologyRevision: this.topologyRevision,
      frameId,
      frameRoute: route,
      childTargetId: frameId,
      childSession,
      sessionId,
    };
  }

  private requireCurrentFrameRoute(
    frameId: string,
    expectedRoute: FrameRoute | null,
    attachmentGeneration: number,
  ): FrameRoute {
    if (
      !this.port.isReady() ||
      this.port.generation() !== attachmentGeneration
    ) {
      throw new Error(`Frame routes changed while resolving frame ${frameId}.`);
    }
    const route = this.frameRouteById.get(frameId);
    if (route === undefined) {
      throw new Error(
        `Cannot resolve frame ${frameId}: frame is not present in the recorded tree.`,
      );
    }
    if (expectedRoute !== null && route !== expectedRoute) {
      throw new Error(`Frame routes changed while resolving frame ${frameId}.`);
    }
    return route;
  }

  private ensureChildSession(
    targetId: string,
    route: ChildFrameRoute,
    attachmentGeneration: number,
  ): Promise<ResolvedTargetRoute> {
    const existing = this.childSessionByTargetId.get(targetId);
    if (existing !== undefined) {
      return this.waitForChildSession(
        targetId,
        route,
        attachmentGeneration,
        existing,
      );
    }

    const deferred = Promise.withResolvers<string>();
    const childSession: ChildSession = {
      attachmentGeneration,
      parentFrameId: route.parentFrameId,
      route,
      state: "attaching",
      sessionId: null,
      readiness: deferred.promise,
      rejectReadiness: deferred.reject,
      retirement: null,
    };
    this.childSessionByTargetId.set(targetId, childSession);
    void this.attachChildSession(targetId, childSession).then(
      deferred.resolve,
      deferred.reject,
    );
    return this.waitForChildSession(
      targetId,
      route,
      attachmentGeneration,
      childSession,
    );
  }

  private discoverIframeTargetIds(): Promise<ReadonlySet<string>> {
    const revision = this.topologyRevision;
    if (this.targetDiscovery?.revision === revision) {
      return this.targetDiscovery.promise;
    }
    const promise = this.port
      .send("Target.getTargets", {}, undefined)
      .then((value) => {
        const response = requireRecord(value, "Target.getTargets");
        const targetIds = new Set<string>();
        for (const value of requireArray(
          response.targetInfos,
          "Target.getTargets.targetInfos",
        )) {
          const target = recordValue(value);
          const targetId = stringValue(target?.targetId);
          if (targetId !== null && stringValue(target?.type) === "iframe") {
            targetIds.add(targetId);
          }
        }
        return targetIds;
      });
    this.targetDiscovery = { revision, promise };
    void promise.catch(() => {
      if (this.targetDiscovery?.promise === promise) {
        this.targetDiscovery = null;
      }
    });
    return promise;
  }

  private async attachChildSession(
    targetId: string,
    childSession: ChildSession,
  ): Promise<string> {
    let detachedBeforeAttachResponse = false;
    const browserDebugger = this.port.browserDebugger();
    try {
      const attached = requireRecord(
        await this.port.send(
          "Target.attachToTarget",
          { targetId, flatten: true },
          undefined,
        ),
        "Target.attachToTarget",
      );
      const sessionId = requireString(
        attached.sessionId,
        "Target.attachToTarget.sessionId",
      );
      detachedBeforeAttachResponse =
        this.detachedChildSessionIds.delete(sessionId);
      childSession.sessionId = sessionId;
      if (detachedBeforeAttachResponse) {
        throw new Error("Child debugger session ended while enabling");
      }
      this.assertChildSessionCurrent(targetId, childSession);
      await this.port.raceWithSessionEnd(
        Promise.all([
          browserDebugger.sendCommand("Page.enable", {}, sessionId),
          browserDebugger.sendCommand("Runtime.enable", {}, sessionId),
          browserDebugger.sendCommand("Log.enable", {}, sessionId),
          browserDebugger.sendCommand("Network.enable", {}, sessionId),
          browserDebugger.sendCommand("DOM.enable", {}, sessionId),
        ]).then(() => undefined),
        "Child debugger session ended while enabling",
      );
      this.assertChildSessionCurrent(targetId, childSession);
      childSession.state = "ready";
      return sessionId;
    } catch (err) {
      log.warn("[browser-view] child debugger domain enable failed", {
        error: describeLogError(err),
        sessionId: childSession.sessionId,
        targetId,
      });
      const retired =
        detachedBeforeAttachResponse ||
        childSession.sessionId === null ||
        childSession.attachmentGeneration !== this.port.generation()
          ? true
          : await this.retireChildSession(childSession.sessionId);
      if (
        !retired &&
        this.childSessionByTargetId.get(targetId) === childSession
      ) {
        childSession.state = "retiring";
        childSession.retirement = Promise.resolve(false);
      }
      if (
        retired &&
        this.childSessionByTargetId.get(targetId) === childSession
      ) {
        this.childSessionByTargetId.delete(targetId);
      }
      throw err;
    }
  }

  /** Throws unless this attaching child is still the one we started on. */
  private assertChildSessionCurrent(
    targetId: string,
    childSession: ChildSession,
  ): void {
    if (
      childSession.attachmentGeneration !== this.port.generation() ||
      !this.port.isAttached() ||
      childSession.state !== "attaching" ||
      this.childSessionByTargetId.get(targetId) !== childSession ||
      this.frameRouteById.get(targetId) !== childSession.route ||
      !this.frameRouteById.has(childSession.parentFrameId)
    ) {
      throw new Error("Child debugger session ended while enabling");
    }
  }

  private async retireChildSession(sessionId: string): Promise<boolean> {
    const browserDebugger = this.port.browserDebugger();
    if (!browserDebugger.isAttached()) return true;
    const attachmentGeneration = this.port.generation();
    try {
      await Promise.race([
        browserDebugger.sendCommand(
          "Target.detachFromTarget",
          { sessionId },
          undefined,
        ),
        this.port.attachmentEnded(),
      ]);
      return true;
    } catch (error) {
      if (
        !browserDebugger.isAttached() ||
        this.port.generation() !== attachmentGeneration
      ) {
        return true;
      }
      log.warn("[browser-view] failed to retire unusable child target", {
        error: describeLogError(error),
        sessionId,
      });
      return false;
    }
  }

  private isAuthorizedFrameEvent(
    frameId: string,
    sessionId: string | undefined,
  ): boolean {
    if (sessionId === undefined) return true;
    for (const [targetId, childSession] of this.childSessionByTargetId) {
      if (
        childSession.state !== "retiring" &&
        childSession.sessionId === sessionId &&
        this.collectFrameBranch(targetId).has(frameId)
      ) {
        return true;
      }
    }
    return false;
  }

  private forgetFrameBranch(rootFrameId: string): void {
    const removedFrameIds = this.collectFrameBranch(rootFrameId);
    if (
      !this.frameRouteById.has(rootFrameId) &&
      !this.childSessionByTargetId.has(rootFrameId)
    ) {
      return;
    }
    this.topologyRevision += 1;
    for (const frameId of removedFrameIds) {
      this.frameRouteById.delete(frameId);
      const childSession = this.childSessionByTargetId.get(frameId);
      if (childSession !== undefined) {
        this.retireChildSessionRecord(frameId, childSession);
      }
    }
  }

  private forgetChildSession(
    sessionId: string,
    detachedTargetId: string | null,
  ): void {
    // ponytail: OOPIFs are page-bounded; add a reverse index only if profiling
    // shows this detach-time scan matters.
    for (const [targetId, childSession] of this.childSessionByTargetId) {
      const matchesKnownSession = childSession.sessionId === sessionId;
      const matchesPendingTarget =
        childSession.state === "attaching" &&
        childSession.sessionId === null &&
        targetId === detachedTargetId;
      if (!matchesKnownSession && !matchesPendingTarget) {
        continue;
      }
      this.childSessionByTargetId.delete(targetId);
      if (matchesKnownSession) {
        this.detachedChildSessionIds.delete(sessionId);
      }
      const route = this.frameRouteById.get(targetId);
      if (route !== undefined && route.kind !== "root") {
        this.frameRouteById.set(targetId, {
          kind: "unresolved",
          parentFrameId: route.parentFrameId,
        });
      }
      return;
    }
  }

  private buildFrameRoutes(
    frames: readonly BrowserCdpFrameInfo[],
    rootFrameId: string,
    rootRoute: FrameRoute,
  ): ReadonlyMap<string, FrameRoute> {
    const routes = new Map<string, FrameRoute>();
    for (const frame of frames) {
      if (routes.has(frame.frameId)) {
        throw new Error(
          `Malformed CDP response: duplicate frame ${frame.frameId}.`,
        );
      }
      routes.set(
        frame.frameId,
        frame.frameId === rootFrameId
          ? rootRoute
          : {
              kind: "unresolved",
              parentFrameId: requireString(
                frame.parentFrameId,
                `Page.getFrameTree parent for ${frame.frameId}`,
              ),
            },
      );
    }
    if (!routes.has(rootFrameId)) {
      throw new Error(
        `Malformed CDP response: Page.getFrameTree omitted target frame ${rootFrameId}.`,
      );
    }
    // ponytail: Frame trees are small; a per-frame parent walk is clearer than
    // maintaining another graph index. Replace only if profiling proves otherwise.
    for (const frameId of routes.keys()) {
      const visited = new Set<string>();
      let currentFrameId = frameId;
      while (currentFrameId !== rootFrameId) {
        if (visited.has(currentFrameId)) {
          throw new Error(
            `Malformed CDP response: cyclic frame ancestry at ${currentFrameId}.`,
          );
        }
        visited.add(currentFrameId);
        const route = routes.get(currentFrameId);
        if (route === undefined || route.parentFrameId === null) {
          throw new Error(
            `Malformed CDP response: frame ${currentFrameId} is outside target subtree ${rootFrameId}.`,
          );
        }
        if (!routes.has(route.parentFrameId)) {
          throw new Error(
            `Malformed CDP response: frame ${currentFrameId} has unknown parent ${route.parentFrameId}.`,
          );
        }
        currentFrameId = route.parentFrameId;
      }
    }
    return routes;
  }

  private replaceFrameRoutes(
    nextRoutes: ReadonlyMap<string, FrameRoute>,
  ): void {
    const retainedRoutes = this.retainFrameRoutes(nextRoutes);
    if (!sameRouteMap(this.frameRouteById, retainedRoutes)) {
      this.topologyRevision += 1;
      this.frameRouteById.clear();
      for (const [frameId, route] of retainedRoutes) {
        this.frameRouteById.set(frameId, route);
      }
    }
    for (const [targetId, childSession] of this.childSessionByTargetId) {
      const route = retainedRoutes.get(targetId);
      if (
        childSession.state !== "retiring" &&
        route?.parentFrameId === childSession.parentFrameId
      ) {
        childSession.route = route;
        continue;
      }
      this.retireChildSessionRecord(targetId, childSession);
    }
  }

  private mergeFrameSubtree(
    rootFrameId: string,
    nextRoutes: ReadonlyMap<string, FrameRoute>,
  ): void {
    const previousFrameIds = this.collectFrameBranch(rootFrameId);
    const retainedRoutes = this.retainFrameRoutes(nextRoutes);
    if (
      !sameRouteBranch(previousFrameIds, this.frameRouteById, retainedRoutes)
    ) {
      this.topologyRevision += 1;
      for (const frameId of previousFrameIds) {
        this.frameRouteById.delete(frameId);
      }
      for (const [frameId, route] of retainedRoutes) {
        this.frameRouteById.set(frameId, route);
      }
    }
    for (const [targetId, childSession] of this.childSessionByTargetId) {
      if (!previousFrameIds.has(targetId) && !retainedRoutes.has(targetId)) {
        continue;
      }
      const route = retainedRoutes.get(targetId);
      if (
        childSession.state !== "retiring" &&
        route?.parentFrameId === childSession.parentFrameId
      ) {
        childSession.route = route;
        continue;
      }
      this.retireChildSessionRecord(targetId, childSession);
    }
  }

  private refreshFrameBranch(
    frameId: string,
    parentFrameId: string,
    eventSessionId: string | undefined,
  ): void {
    const descendantFrameIds = this.collectFrameBranch(frameId);
    descendantFrameIds.delete(frameId);
    this.topologyRevision += 1;
    for (const descendantFrameId of descendantFrameIds) {
      this.frameRouteById.delete(descendantFrameId);
      const childSession = this.childSessionByTargetId.get(descendantFrameId);
      if (childSession !== undefined) {
        this.retireChildSessionRecord(descendantFrameId, childSession);
      }
    }
    const nextRoute: FrameRoute = {
      kind: "unresolved",
      parentFrameId,
    };
    this.frameRouteById.set(frameId, nextRoute);
    const childSession = this.childSessionByTargetId.get(frameId);
    if (childSession === undefined || childSession.state === "retiring") {
      return;
    }
    if (
      childSession.parentFrameId === parentFrameId &&
      (eventSessionId === undefined ||
        childSession.sessionId === eventSessionId)
    ) {
      childSession.route = nextRoute;
      return;
    }
    this.retireChildSessionRecord(frameId, childSession);
  }

  private collectFrameBranch(rootFrameId: string): Set<string> {
    const frameIds = new Set([rootFrameId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [frameId, route] of this.frameRouteById) {
        if (
          route.parentFrameId !== null &&
          frameIds.has(route.parentFrameId) &&
          !frameIds.has(frameId)
        ) {
          frameIds.add(frameId);
          changed = true;
        }
      }
    }
    return frameIds;
  }

  private retainFrameRoutes(
    nextRoutes: ReadonlyMap<string, FrameRoute>,
  ): Map<string, FrameRoute> {
    const retainedRoutes = new Map(nextRoutes);
    for (const [frameId, nextRoute] of nextRoutes) {
      const currentRoute = this.frameRouteById.get(frameId);
      if (
        currentRoute !== undefined &&
        currentRoute.parentFrameId === nextRoute.parentFrameId &&
        (currentRoute.kind === nextRoute.kind ||
          (currentRoute.kind === "same-process" &&
            nextRoute.kind === "unresolved"))
      ) {
        retainedRoutes.set(frameId, currentRoute);
      }
    }
    return retainedRoutes;
  }

  private retireChildSessionRecord(
    targetId: string,
    childSession: ChildSession,
  ): void {
    if (
      this.childSessionByTargetId.get(targetId) !== childSession ||
      childSession.state === "retiring"
    ) {
      return;
    }
    const wasReady = childSession.state === "ready";
    childSession.state = "retiring";
    const retirement =
      wasReady && childSession.sessionId !== null
        ? this.retireChildSession(childSession.sessionId)
        : childSession.readiness.then(
            () => this.childSessionByTargetId.get(targetId) !== childSession,
            () => this.childSessionByTargetId.get(targetId) !== childSession,
          );
    childSession.retirement = retirement.then((retired) => {
      if (
        retired &&
        this.childSessionByTargetId.get(targetId) === childSession
      ) {
        this.childSessionByTargetId.delete(targetId);
      }
      return retired;
    });
  }
}

function sameRouteMap(
  current: ReadonlyMap<string, FrameRoute>,
  next: ReadonlyMap<string, FrameRoute>,
): boolean {
  if (current.size !== next.size) return false;
  for (const [frameId, route] of next) {
    if (current.get(frameId) !== route) return false;
  }
  return true;
}

function sameRouteBranch(
  currentFrameIds: ReadonlySet<string>,
  current: ReadonlyMap<string, FrameRoute>,
  next: ReadonlyMap<string, FrameRoute>,
): boolean {
  if (currentFrameIds.size !== next.size) return false;
  for (const [frameId, route] of next) {
    if (!currentFrameIds.has(frameId) || current.get(frameId) !== route) {
      return false;
    }
  }
  return true;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  const record = recordValue(value);
  if (record === null) throw invalidCdpResponse(field);
  return record;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw invalidCdpResponse(field);
  return value;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalidCdpResponse(field);
  return value;
}

function invalidCdpResponse(field: string): Error {
  return new Error(`Malformed CDP response: ${field}`);
}
