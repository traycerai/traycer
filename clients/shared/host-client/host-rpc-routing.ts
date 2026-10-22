import type {
  HostRpcRegistry,
  HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import {
  isPoolHostDirectoryEntry,
  POOL_HOST_ID,
  type HostDirectoryEntry,
  type PoolHostDirectoryEntry,
} from "./host-directory";
import { isRemoteHostDirectoryEntry } from "./remote-fetcher";

/**
 * Which peer serves each RPC method: the routing rule as code.
 *
 * The rule (the user's ruling of 2026-10-20, amending "prefer the originating
 * host"): prefer the host that runs the target for host-local work, execution
 * and genuinely host-cached principal-scoped reads; the five account-wide
 * families always go to the server pool, independent of where the call came
 * from and of whether any host is reachable.
 *
 * - `target-host` - the host that runs the target: the chat's host, the
 *   workspace's host, the terminal's host. Whatever host the caller's
 *   requester names. `agent.list` and every exact task or chat resolve are
 *   here: they answer by key on the host the caller is on, never through
 *   History or a pool list.
 * - `sender-host` - `agent.sendMessage`: the host that runs the SENDING
 *   agent's chat. The send contract authorizes only a local sender, and
 *   cross-host delivery happens from there; the pool refuses it.
 * - `selected-host` - RPCs about the person's input devices (`speech.*`):
 *   the person's own selected single-tenant host, whatever the caller's
 *   target is. Never a sandbox and never the pool, so audio and on-device
 *   models never leave the person's machines.
 * - `pool-only` - the account-wide families: History (`epic.listTasks`),
 *   the notification cloud feed (`host.notifications.cloudFeed.*`),
 *   `environment.list` and `environment.binding.read`, `organization.*` and
 *   `autoPolicy.*`, the environment arm (`environment.chats.subscribe`,
 *   `.plainTerminals.subscribe`, `.communicationGraph.subscribe`), which no
 *   host serves, and the chat serving witness (`chat.serving.subscribe`),
 *   the server's published fact. A pool-only call never has a host fallback
 *   arm: a refusal or an outage is the caller's error.
 * - `addressed-peer` - `host.status` and `host.getRuntimeCapabilities`: the
 *   session-level floor every peer genuinely serves, the pool included, so
 *   they go to whichever peer the requester names.
 * - `target-host-live-pool-at-rest` - a chat's transcript: the team sandbox
 *   serves it while it is live, the pool at rest. Which one is the caller's
 *   choice ({@link chatServingHostId}); both are allowed here. The
 *   whole-download pair (`epic.resolveCloudChatHead`,
 *   `epic.readCloudChatPart`) too: the pool serves it for a chat at rest that
 *   its index cannot open.
 *
 * A `target-host` or `sender-host` method is never sent to the pool:
 * dispatching one on a pool requester is refused before anything leaves.
 *
 * THE "NO POOL" BRANCH IS A BUILD-CONFIGURATION FACT, NOT A FALLBACK. A build
 * carries a pool address or it does not (production until the pool's
 * production address is published, and every dev build without one). That is
 * read once, when the process builds its {@link HostRpcTierPlan}, and frozen:
 * a build with no pool serves the pool-only families from the caller's host,
 * as before this table existed, for the whole process life. Nothing at request
 * time - reachability, a refusal, an outage - ever moves a call between the
 * pool and a host.
 *
 * Exhaustive by type (`satisfies` over both registries rejects a missing and an
 * unknown name) and by test (`__tests__/host-rpc-routing.test.ts` walks the
 * released floor fixture and both registries).
 */
export type HostRpcRoute =
  | "target-host"
  | "sender-host"
  | "selected-host"
  | "pool-only"
  | "addressed-peer"
  | "target-host-live-pool-at-rest";

export type HostUnaryRpcMethod = keyof HostRpcRegistry & string;
export type HostStreamRpcMethod = keyof HostStreamRpcRegistry & string;

/** The route of `method`, unary or stream; `null` for a name neither knows. */
export function hostRpcRouteOf(method: string): HostRpcRoute | null {
  return ROUTE_BY_METHOD.get(method) ?? null;
}

/**
 * The serving tier of this process, decided once from build configuration
 * (see the module doc) and frozen.
 */
export interface HostRpcTierPlan {
  /** The build's server pool, or `null`: this build has none. */
  readonly pool: PoolHostDirectoryEntry | null;
}

/** The plan of a process with no pool, and of a client built without one. */
export const NO_POOL_HOST_RPC_TIER_PLAN: HostRpcTierPlan = Object.freeze({
  pool: null,
});

export function createHostRpcTierPlan(
  pool: HostDirectoryEntry | null,
): HostRpcTierPlan {
  return Object.freeze({
    pool: pool !== null && isPoolHostDirectoryEntry(pool) ? pool : null,
  });
}

let processTierPlan: HostRpcTierPlan | null = null;

/**
 * Settles this process's plan from the build's pool entry. The FIRST call
 * decides and every later call returns that same plan, whatever it is given:
 * the tier is a fact of the build, so nothing after load can move a family
 * between the pool and a host. `HostRuntime` settles it as it is built.
 */
export function settleProcessHostRpcTierPlan(
  pool: HostDirectoryEntry | null,
): HostRpcTierPlan {
  processTierPlan ??= createHostRpcTierPlan(pool);
  return processTierPlan;
}

/**
 * This process's plan, for readers with no client in hand (capability gates,
 * cache keys). The no-pool plan until `HostRuntime` settles it, which happens
 * before any surface that reads it renders.
 */
export function readProcessHostRpcTierPlan(): HostRpcTierPlan {
  return processTierPlan ?? NO_POOL_HOST_RPC_TIER_PLAN;
}

export type HostRpcDispatchDecision =
  | { readonly kind: "dispatch"; readonly entry: HostDirectoryEntry }
  | {
      readonly kind: "refuse";
      readonly code: RpcErrorCode;
      readonly message: string;
    };

/**
 * Where one unary call goes. `target` is the host the caller's requester
 * names; `selectedHost` is the person's selected host, for `selected-host`.
 */
export function decideHostRpcDispatch(
  route: HostRpcRoute,
  target: HostDirectoryEntry,
  plan: HostRpcTierPlan,
  selectedHost: HostDirectoryEntry | null,
): HostRpcDispatchDecision {
  switch (route) {
    case "pool-only":
      return { kind: "dispatch", entry: plan.pool ?? target };
    case "selected-host":
      if (selectedHost === null || !servesInputDevices(selectedHost)) {
        return {
          kind: "refuse",
          code: "E_HOST_UNSUPPORTED",
          message:
            "No host of your own is selected to serve input-device requests",
        };
      }
      return { kind: "dispatch", entry: selectedHost };
    case "target-host":
    case "sender-host":
      if (isPoolHostDirectoryEntry(target)) {
        return {
          kind: "refuse",
          code: "E_HOST_UNSUPPORTED",
          message: "The server pool does not serve this method",
        };
      }
      return { kind: "dispatch", entry: target };
    case "addressed-peer":
    case "target-host-live-pool-at-rest":
      return { kind: "dispatch", entry: target };
  }
}

/**
 * The host id that answers for `method` when a caller names `callerHostId`:
 * the serving tier. A pool-only answer is cached, and its capability read,
 * under the pool whichever host asked, so the key never flips; an
 * input-device answer under the person's selected host when the reader knows
 * it (`null` keeps the caller's). Follows the same frozen plan as dispatch.
 */
export function hostRpcServingTierHostId(
  method: string,
  callerHostId: string | null,
  plan: HostRpcTierPlan,
  selectedHostId: string | null,
): string | null {
  const route = hostRpcRouteOf(method);
  if (route === "pool-only" && plan.pool !== null) {
    return POOL_HOST_ID;
  }
  if (route === "selected-host" && selectedHostId !== null) {
    return selectedHostId;
  }
  return callerHostId;
}

/**
 * Whether a host may serve the person's input devices: a machine the person
 * holds. A sandbox is never one, whoever owns it, and neither is the pool.
 */
export function servesInputDevices(entry: HostDirectoryEntry): boolean {
  if (entry.kind === "local" || entry.kind === "mock") {
    return true;
  }
  return isRemoteHostDirectoryEntry(entry) && entry.sandbox === null;
}

/** Whether `entry` is a sandbox a team owns. */
export function isTeamSandboxHostDirectoryEntry(
  entry: HostDirectoryEntry,
): boolean {
  return (
    isRemoteHostDirectoryEntry(entry) &&
    entry.sandbox !== null &&
    entry.sandbox.ownerTeamId !== null
  );
}

/** One chat, as the readiness witness is asked about it. */
export interface ChatServingKey {
  /** The host that runs the chat (the tab's host). */
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
}

/**
 * - `live` - the chat's host is awake and serves it, live turn included.
 * - `at-rest` - the chat's history is published and the pool serves it.
 * - `unknown` - the witness has no answer yet; read as at rest.
 */
export type ChatServingVerdict = "live" | "at-rest" | "unknown";

/**
 * The per-chat readiness witness that chooses live versus at-rest serving.
 * Published by the readiness work (P8); this module only consumes it. Until a
 * witness is wired the binding passes `null` and every chat stays on its own
 * host.
 */
export interface ChatServingWitness {
  verdictFor(chat: ChatServingKey): ChatServingVerdict;
  /** Fires when any verdict may have changed. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/**
 * The peer a chat's transcript stream (`chat.subscribe`, `chat.locateRow`) is
 * opened on. A change of answer is a resubscribe to the other peer, as on a
 * reconnect.
 *
 * Only a TEAM SANDBOX's chat ever moves. A personal host's chat, local or
 * remote, and a personal sandbox's, is always served by its own host: that
 * host holds the chat (D8), and cross-host continuation is a clone, never a
 * move. That is an invariant, not a default, and holds whatever the witness
 * says.
 *
 * `verdict` is the witness's answer for `chat`, `null` with no witness. It is
 * the value and never the witness: a compiled caller memoizes on what it
 * passes, and the witness keeps one identity while its verdicts move, so a
 * caller handed the witness kept its first answer for good.
 */
export function chatServingHostId(
  chat: ChatServingKey,
  chatHost: HostDirectoryEntry | null,
  verdict: ChatServingVerdict | null,
  plan: HostRpcTierPlan,
): string {
  if (
    verdict === null ||
    plan.pool === null ||
    chatHost === null ||
    !isTeamSandboxHostDirectoryEntry(chatHost)
  ) {
    return chat.hostId;
  }
  return verdict === "live" ? chat.hostId : POOL_HOST_ID;
}

export const HOST_UNARY_RPC_ROUTES = {
  "agent.archive": "target-host",
  "agent.configure": "target-host",
  "agent.create": "target-host",
  "agent.fork": "target-host",
  "agent.getProviderProfileRateLimits": "target-host",
  "agent.getTranscript": "target-host",
  "agent.gui.getPlan": "target-host",
  "agent.gui.listCommands": "target-host",
  "agent.gui.listHarnesses": "target-host",
  "agent.gui.listModels": "target-host",
  "agent.inbox.ack": "target-host",
  "agent.inbox.read": "target-host",
  "agent.list": "target-host",
  "agent.listHarnessModels": "target-host",
  "agent.listProviderProfiles": "target-host",
  "agent.resolveMessagePeer": "target-host",
  "agent.roles.claim": "target-host",
  "agent.roles.list": "target-host",
  "agent.roles.relinquish": "target-host",
  "agent.selectionGuide": "target-host",
  "agent.selectionGuide.getGlobal": "target-host",
  "agent.selectionGuide.getGlobalOnboardingDraft": "target-host",
  "agent.selectionGuide.resetGlobalToDefault": "target-host",
  "agent.selectionGuide.setGlobal": "target-host",
  "agent.sendMessage": "sender-host",
  "agent.stop": "target-host",
  "agent.tui.generateTitle": "target-host",
  "agent.tui.listHarnesses": "target-host",
  "agent.tui.prepareLaunch": "target-host",
  "agent.tui.promptSubmitted": "target-host",
  "agent.tui.recordActivity": "target-host",
  "agent.tui.turnEnded": "target-host",
  "agent.tui.validateForkProfile": "target-host",
  "autoJudge.get": "target-host",
  "autoJudge.listRecent": "target-host",
  "autoJudge.set": "target-host",
  "autoPolicy.get": "pool-only",
  "autoPolicy.set": "pool-only",
  "bot.claimAuthority": "target-host",
  "bot.conversation.list": "target-host",
  "bot.conversation.send": "target-host",
  "bot.create": "target-host",
  "bot.delete": "target-host",
  "bot.list": "target-host",
  "bot.open": "target-host",
  "bot.read": "target-host",
  "bot.updateRunSettings": "target-host",
  "bot.updateTitle": "target-host",
  "browser.repl.releaseRealm": "target-host",
  "browser.repl.requestApproval": "target-host",
  "browser.repl.runCell": "target-host",
  "browser.repl.stopCell": "target-host",
  "browser.savedLoginSites": "target-host",
  // The sandbox host the person continues a removed sandbox's chat on.
  "chat.continueHere": "target-host",
  "chat.fallback.cancel": "target-host",
  "chat.fallback.chooseTarget": "target-host",
  "chat.fallback.listTargets": "target-host",
  "chat.fallback.proceed": "target-host",
  "chat.fallback.returnToPreferred": "target-host",
  "chat.fallback.runManualRung": "target-host",
  "chat.locateRow": "target-host-live-pool-at-rest",
  "chat.mcpApp.callTool": "target-host",
  "chat.mcpApp.describeTool": "target-host",
  "chat.mcpApp.readResource": "target-host",
  "chat.mcpApp.updateModelContext": "target-host",
  "chat.readAccumulatedFileChange": "target-host",
  "chat.search": "target-host",
  "chatAutoArchive.get": "target-host",
  "chatAutoArchive.set": "target-host",
  "comments.listThreads": "target-host",
  "comments.setThreadStatus": "target-host",
  "config.browser.get": "target-host",
  "config.browser.set": "target-host",
  "config.catalog.get": "target-host",
  "config.catalog.set": "target-host",
  "config.env.delete": "target-host",
  "config.env.list": "target-host",
  "config.env.localOverride.clear": "target-host",
  "config.env.localOverride.set": "target-host",
  "config.env.set": "target-host",
  "config.logLevels.get": "target-host",
  "config.logLevels.set": "target-host",
  "config.shell.add": "target-host",
  "config.shell.get": "target-host",
  "config.shell.listDetected": "target-host",
  "config.shell.probe": "target-host",
  "config.shell.remove": "target-host",
  "config.shell.reset": "target-host",
  "config.shell.revertArgs": "target-host",
  "config.shell.set": "target-host",
  "config.simulator.get": "target-host",
  "config.simulator.set": "target-host",
  "config.visualization.get": "target-host",
  "config.visualization.set": "target-host",
  "config.worktrees.get": "target-host",
  "config.worktrees.set": "target-host",
  "diagnostics.logs.list": "target-host",
  "diagnostics.logs.tail": "target-host",
  "drafts.delete": "target-host",
  "drafts.list": "target-host",
  "drafts.putBlob": "target-host",
  "drafts.readBlob": "target-host",
  "drafts.retract": "target-host",
  "drafts.upsert": "target-host",
  "editor.openPaths": "target-host",
  "environment.agentDefinitions.delete": "target-host",
  "environment.agentDefinitions.list": "target-host",
  "environment.agentDefinitions.put": "target-host",
  // A named host's binding from the account's records: Home's bot hosts, the
  // Settings host list and the host scope read every row's binding here,
  // without a connection to each host.
  "environment.binding.read": "pool-only",
  "environment.host.bind": "target-host",
  "environment.host.list": "target-host",
  // Host-local for good: its request names no host, and it answers "the
  // environment THIS host is bound to". The pool-served form is a separate
  // method naming the host (`environment.binding.read { hostId }`), which
  // the per-host-row readers use in a build with a pool.
  "environment.host.read": "target-host",
  "environment.list": "pool-only",
  "environment.localOverrides": "target-host",
  "environment.members": "target-host",
  "environment.notices": "target-host",
  "environment.reachDiagnostics": "target-host",
  "environment.review": "target-host",
  "environment.secrets.consent": "target-host",
  "environment.secrets.create": "target-host",
  "environment.secrets.destroy": "target-host",
  "environment.secrets.list": "target-host",
  "environment.secrets.replaceValue": "target-host",
  "environment.secrets.rotation": "target-host",
  "environment.secrets.undo": "target-host",
  "environment.secrets.verify": "target-host",
  "environment.secrets.versions": "target-host",
  "environment.setup.attempts": "target-host",
  "environment.setup.get": "target-host",
  "environment.setup.put": "target-host",
  "environment.setup.retry": "target-host",
  "environment.status": "target-host",
  "environment.undo": "target-host",
  "epic.artifactVersionSettings.clearHistory": "target-host",
  "epic.artifactVersionSettings.get": "target-host",
  "epic.artifactVersionSettings.setEnabled": "target-host",
  "epic.artifactVersionSettings.setRetentionPolicy": "target-host",
  "epic.artifactVersions.getBlob": "target-host",
  "epic.artifactVersions.list": "target-host",
  "epic.artifactVersions.restore": "target-host",
  "epic.attachEnvironment": "target-host",
  "epic.batchDelete": "target-host",
  "epic.batchUpdateRoles": "target-host",
  "epic.chatBackupStatus": "target-host",
  "epic.chatPublicationState": "target-host",
  "epic.chatReplicaRead": "target-host",
  "epic.continueSubagent": "target-host",
  "epic.create": "target-host",
  "epic.createArtifact": "target-host",
  "epic.createChat": "target-host",
  "epic.createCommentThread": "target-host",
  "epic.createTuiAgent": "target-host",
  "epic.deleteArtifact": "target-host",
  "epic.deleteChat": "target-host",
  "epic.deleteComment": "target-host",
  "epic.deleteCommentThread": "target-host",
  "epic.deleteTuiAgent": "target-host",
  "epic.deletedArtifacts.list": "target-host",
  "epic.deletedArtifacts.revive": "target-host",
  "epic.editArtboard": "target-host",
  "epic.editComment": "target-host",
  "epic.fetchArtifactAttachment": "target-host",
  "epic.finishArtifactImage": "target-host",
  "epic.getChatRunSettings": "target-host",
  "epic.getChatRunSettingsBatch": "target-host",
  "epic.getTaskContexts": "target-host",
  "epic.getWorkspaceContext": "target-host",
  "epic.grantAccess": "target-host",
  "epic.listChatPublicationTargets": "target-host",
  "epic.listChatRecords": "target-host",
  "epic.listCloudChatPayloads": "target-host",
  "epic.listCloudChats": "target-host",
  "epic.listCollaborators": "target-host",
  "epic.listCommentThreads": "target-host",
  "epic.listHtmlArtifactVersions": "target-host",
  "epic.listTaskHosts": "target-host",
  // History: the server pool's pages. What only a host knows - its
  // local-homed rows, preserved orphans and tombstones - comes from that
  // host's own `epic.localHistory.read`, and the app composes the two.
  "epic.listTasks": "pool-only",
  "epic.listTuiAgents": "target-host",
  // The host's local History contribution, from the host that holds it.
  "epic.localHistory.read": "target-host",
  "epic.mentionEpics": "target-host",
  "epic.mentionReviews": "target-host",
  "epic.mentionSpecs": "target-host",
  "epic.mentionStories": "target-host",
  "epic.mentionTickets": "target-host",
  "epic.prepareArtifactImage": "target-host",
  "epic.readArtifactObject": "target-host",
  "epic.readChatAttachment": "target-host",
  // The whole-download pair: a host the device holds reads them as a byte
  // pipe, and the pool serves them for a chat its index cannot open
  // (`CHAT_INDEX_UNAVAILABLE` on `chat.subscribe`).
  "epic.readCloudChatPart": "target-host-live-pool-at-rest",
  "epic.readCloudChatPayload": "target-host",
  "epic.recordViewed": "target-host",
  "epic.removeRepo": "target-host",
  "epic.renameArtifact": "target-host",
  "epic.renameChat": "target-host",
  "epic.renameTuiAgent": "target-host",
  "epic.reparentArtifact": "target-host",
  "epic.reparentChat": "target-host",
  "epic.replyToCommentThread": "target-host",
  "epic.resolveArtifactByPath": "target-host",
  "epic.resolveCloudChatHead": "target-host-live-pool-at-rest",
  "epic.retryMigration": "target-host",
  "epic.revokeCollaborator": "target-host",
  "epic.searchArtifacts": "target-host",
  "epic.setChatArchived": "target-host",
  "epic.setChatSharingDefault": "target-host",
  "epic.setCloudChatVisibility": "target-host",
  "epic.setCommentThreadResolved": "target-host",
  "epic.setPinned": "target-host",
  "epic.updateArtifactStatus": "target-host",
  "epic.updateChatProfile": "target-host",
  "epic.updateChatRunSettings": "target-host",
  "epic.updateTitle": "target-host",
  "git.getCapabilities": "target-host",
  "git.getFileContents": "target-host",
  "git.getFileDiff": "target-host",
  "git.getFileDiffs": "target-host",
  "git.listChangedFiles": "target-host",
  "host.agent.createFromRemoteSender": "target-host",
  "host.chatFork.get": "target-host",
  "host.doctor": "target-host",
  "host.fileCopy.cancel": "target-host",
  "host.fileCopy.start": "target-host",
  "host.fileCopy.status": "target-host",
  "host.fileTransfer.close": "target-host",
  "host.fileTransfer.enumerate": "target-host",
  "host.fileTransfer.open": "target-host",
  "host.fileTransfer.readChunk": "target-host",
  "host.getInstallationInfo": "target-host",
  "host.getRateLimitUsage": "target-host",
  "host.getRuntimeCapabilities": "addressed-peer",
  "host.identity.get": "target-host",
  "host.identity.set": "target-host",
  "host.notificationHooks.save": "target-host",
  "host.notificationHooks.status": "target-host",
  "host.notificationHooks.test": "target-host",
  "host.notifications.clearAll": "target-host",
  "host.notifications.cloudFeed.clear": "pool-only",
  "host.notifications.cloudFeed.clearAll": "pool-only",
  "host.notifications.cloudFeed.markAllRead": "pool-only",
  "host.notifications.cloudFeed.markRead": "pool-only",
  "host.notifications.cloudFeed.resolve": "pool-only",
  "host.notifications.getConfig": "target-host",
  "host.notifications.indicatorState": "target-host",
  "host.notifications.list": "target-host",
  "host.notifications.markAllRead": "target-host",
  "host.notifications.markRead": "target-host",
  "host.notifications.resolve": "target-host",
  "host.notifications.setConfig": "target-host",
  "host.oneOffShell.run": "target-host",
  "host.portForward.acquireLease": "target-host",
  "host.portForward.leaseEnded": "target-host",
  "host.portForward.releaseLease": "target-host",
  "host.profileSync.apply": "target-host",
  "host.profileSync.fetchCredential": "target-host",
  "host.profileSync.offerCredential": "target-host",
  "host.rebindLocalStore": "target-host",
  "host.remoteAccess.set": "target-host",
  "host.resolveRepoPaths": "target-host",
  "host.restart": "target-host",
  "host.sandbox.repairGuestConfiguration": "target-host",
  "host.service.deregister": "target-host",
  "host.service.register": "target-host",
  "host.service.status": "target-host",
  "host.status": "addressed-peer",
  "host.update.activate": "target-host",
  "host.update.check": "target-host",
  "host.update.continue": "target-host",
  "host.update.install": "target-host",
  "host.usage.summary": "target-host",
  "lifecycle.claimShutdown": "target-host",
  "lifecycle.commitShutdown": "target-host",
  "lifecycle.releaseShutdown": "target-host",
  "managedCommand.configure": "target-host",
  "managedCommand.configureAgentShell": "target-host",
  "managedCommand.create": "target-host",
  "managedCommand.delete": "target-host",
  "managedCommand.deliverHeld": "target-host",
  "managedCommand.list": "target-host",
  "managedCommand.restart": "target-host",
  "managedCommand.start": "target-host",
  "managedCommand.stop": "target-host",
  "managedCommand.view": "target-host",
  "mention.githubCatalog": "target-host",
  "mention.githubSearch": "target-host",
  "organization.command": "pool-only",
  "organization.history": "pool-only",
  "organization.read": "pool-only",
  "organization.refresh": "pool-only",
  "phase.migrateToEpic": "target-host",
  "portForward.cutLease": "target-host",
  "portForward.listForHost": "target-host",
  "portForward.stop": "target-host",
  "pr.getLocalDiff": "target-host",
  "pr.getLocalDiffSummary": "target-host",
  "pr.getLocalFileDiff": "target-host",
  "providers.addCustomPath": "target-host",
  "providers.awaitLogin": "target-host",
  "providers.awaitMcpAuth": "target-host",
  "providers.awaitModelProviderAuth": "target-host",
  "providers.cancelLogin": "target-host",
  "providers.cancelMcpAuth": "target-host",
  "providers.cancelModelProviderAuth": "target-host",
  "providers.clearApiKey": "target-host",
  "providers.clearProfileApiKey": "target-host",
  "providers.consumeRateLimitResetCredit": "target-host",
  "providers.deleteEnvOverride": "target-host",
  "providers.detectVersion": "target-host",
  "providers.ensurePack": "target-host",
  "providers.fallbackPolicy.get": "target-host",
  "providers.fallbackPolicy.previewTierGroups": "target-host",
  "providers.fallbackPolicy.reset": "target-host",
  "providers.fallbackPolicy.restoreTierGroups": "target-host",
  "providers.fallbackPolicy.set": "target-host",
  "providers.installPackVersion": "target-host",
  "providers.link": "target-host",
  "providers.linkComplete": "target-host",
  "providers.list": "target-host",
  "providers.listModelProviders": "target-host",
  "providers.mcpAuth": "target-host",
  "providers.modelProviderAuth": "target-host",
  "providers.nativeMutate": "target-host",
  "providers.profileSync.acceptAccount": "target-host",
  "providers.profileSync.overview": "target-host",
  "providers.profileSync.setKeepInSync": "target-host",
  "providers.profileSync.syncNow": "target-host",
  "providers.refreshPackDiscovery": "target-host",
  "providers.refreshProfileStatus": "target-host",
  "providers.removeCustomPath": "target-host",
  "providers.removePackVersion": "target-host",
  "providers.setApiKey": "target-host",
  "providers.setAutoJudge": "target-host",
  "providers.setEnabled": "target-host",
  "providers.setEnvOverride": "target-host",
  "providers.setNativeSubagents": "target-host",
  "providers.setPackPolicy": "target-host",
  "providers.setProfileApiKey": "target-host",
  "providers.setProfileEnabled": "target-host",
  "providers.setSelection": "target-host",
  "providers.setTerminalAgentArgs": "target-host",
  "providers.settingsFile.reset": "target-host",
  "providers.settingsFile.status": "target-host",
  "providers.startLogin": "target-host",
  "providers.startTerminalLogin": "target-host",
  "providers.submitLoginCode": "target-host",
  "providers.touchLogin": "target-host",
  "providers.usePackVersion": "target-host",
  "resources.kill": "target-host",
  "resources.listLocalServers": "target-host",
  "sessionImport.status": "target-host",
  "simulator.action": "target-host",
  "simulator.close": "target-host",
  "simulator.detail": "target-host",
  "simulator.list": "target-host",
  "simulator.open": "target-host",
  "simulator.removeTools": "target-host",
  "simulator.screenshot": "target-host",
  "simulator.shutdown": "target-host",
  "simulator.status": "target-host",
  "snapshots.clearLocalSnapshots": "target-host",
  "snapshots.getLocalStorageSize": "target-host",
  "snapshots.readSnapshotDiff": "target-host",
  "speech.ensureModel": "selected-host",
  "speech.getModelStatus": "selected-host",
  "terminal.create": "target-host",
  "terminal.kill": "target-host",
  "terminal.list": "target-host",
  "terminal.plain.close": "target-host",
  "terminal.plain.create": "target-host",
  "terminal.plain.ensureRunning": "target-host",
  "terminal.plain.importLegacy": "target-host",
  "terminal.plain.list": "target-host",
  "terminal.plain.rename": "target-host",
  "terminal.readOutput": "target-host",
  "terminal.rename": "target-host",
  "workspace.browseFolders": "target-host",
  "workspace.listDirectory": "target-host",
  "workspace.listFileTree": "target-host",
  "workspace.mentionFiles": "target-host",
  "workspace.mentionFolders": "target-host",
  "workspace.mentionGitBranches": "target-host",
  "workspace.mentionGitCommits": "target-host",
  "workspace.mentionGitRoot": "target-host",
  "workspace.mentionWorktrees": "target-host",
  "workspace.prepareFolders": "target-host",
  "workspace.readFile": "target-host",
  "workspace.resolvePathsByRepoIdentifiers": "target-host",
  "workspace.searchPaths": "target-host",
  "workspace.searchText": "target-host",
  "workspace.writeFile": "target-host",
  "workspaceBinding.removeEntry": "target-host",
  "worktree.create": "target-host",
  "worktree.createPaths": "target-host",
  "worktree.delete": "target-host",
  "worktree.getAutoCleanupPolicy": "target-host",
  "worktree.getAutoCleanupRun": "target-host",
  "worktree.getBinding": "target-host",
  "worktree.import": "target-host",
  "worktree.listAllForHost": "target-host",
  "worktree.listAutoCleanupRuns": "target-host",
  "worktree.listBindingsForEpic": "target-host",
  "worktree.listBranches": "target-host",
  "worktree.listByWorkspacePaths": "target-host",
  "worktree.listHolders": "target-host",
  "worktree.retrySetup": "target-host",
  "worktree.setAutoCleanupPolicy": "target-host",
  "worktree.setEntryMode": "target-host",
  "worktree.setRepoBranchPrefix": "target-host",
  "worktree.setRepoScripts": "target-host",
} as const satisfies { readonly [Method in HostUnaryRpcMethod]: HostRpcRoute };

export const HOST_STREAM_RPC_ROUTES = {
  "agent.activity.subscribe": "target-host",
  "agent.inbox.subscribe": "target-host",
  "artifact.subscribe": "target-host",
  "bot.listChanged": "target-host",
  "bot.subscribe": "target-host",
  "browser.screencast": "target-host",
  "browser.sessions": "target-host",
  "chat.serving.subscribe": "pool-only",
  "chat.subscribe": "target-host-live-pool-at-rest",
  "drafts.subscribe": "target-host",
  "epic.communicationGraph.subscribe": "target-host",
  "epic.state.subscribe": "target-host",
  "epic.status.subscribe": "target-host",
  "epic.subscribe": "target-host",
  // The environment arm: a team environment's own rows in one task, for a
  // member of it. Only the server pool serves them; the app composes them
  // with the viewer's own rows.
  "environment.chats.subscribe": "pool-only",
  "environment.communicationGraph.subscribe": "pool-only",
  "environment.plainTerminals.subscribe": "pool-only",
  "git.streamFileAsset": "target-host",
  "git.subscribeStatus": "target-host",
  "host.browserPreparation.subscribe": "target-host",
  "host.chatRecords.subscribe": "target-host",
  "host.communicationGraph.subscribe": "target-host",
  "host.hostInventory.subscribe": "target-host",
  "host.notifications.cloudFeed.subscribe": "pool-only",
  "host.notifications.feed.subscribe": "target-host",
  "host.notifications.subscribe": "target-host",
  "host.sandbox.egress.subscribe": "target-host",
  "host.tunnel.open": "target-host",
  "managedCommand.subscribeOutput": "target-host",
  "migration.run": "target-host",
  "notifications.subscribe": "target-host",
  "organization.subscribe": "pool-only",
  "pr.subscribeDetail": "target-host",
  "pr.subscribeListForEpic": "target-host",
  "providers.changed": "target-host",
  "resources.subscribe": "target-host",
  "sessionImport.run": "target-host",
  "sessionImport.scan": "target-host",
  "simulator.sessions": "target-host",
  "simulator.stream": "target-host",
  "speech.dictate": "selected-host",
  "terminal.plain.subscribeList": "target-host",
  "terminal.subscribe": "target-host",
  "workspace.streamAsset": "target-host",
  "workspace.subscribeFileList": "target-host",
  "worktree.changed": "target-host",
  "worktree.deleteBatchByPath": "target-host",
  "worktree.deleteByPath": "target-host",
} as const satisfies { readonly [Method in HostStreamRpcMethod]: HostRpcRoute };

const ROUTE_BY_METHOD: ReadonlyMap<string, HostRpcRoute> = new Map<
  string,
  HostRpcRoute
>([
  ...Object.entries(HOST_UNARY_RPC_ROUTES),
  ...Object.entries(HOST_STREAM_RPC_ROUTES),
]);
