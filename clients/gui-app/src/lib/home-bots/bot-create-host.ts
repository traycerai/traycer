import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";

/**
 * Where a new bot is created (Tracy Bots). The person never picks: the app
 * walks this order and takes the first host that runs the bot's environment
 * (`environment.host.read` names it) and advertises `bot.create` -
 *
 * 1. this machine (the app's local host);
 * 2. the app's active host, which is "this machine" where the app has no
 *    local host (web, mobile);
 * 3. the environment's sandbox ({@link environmentSandboxForCreate}, level 2
 *    of the host-invisible revision: none until sandboxes exist);
 * 4. any other reachable host bound to the environment, by host id - a
 *    stable order, unlike labels, which can be renamed.
 *
 * A host whose environment is still being read holds the walk at its place:
 * the answer is `checking` until it is known whether that host qualifies, so
 * a later host never wins only because it answered first. A host whose read
 * failed is passed over.
 */
export type BotCreateHostChoice =
  | { readonly kind: "chosen"; readonly hostId: string }
  | { readonly kind: "checking" }
  | { readonly kind: "none" };

export function chooseBotCreateHost(input: {
  readonly environmentId: string;
  readonly localHostId: string | null;
  readonly effectiveHostId: string | null;
  /** Hosts this client can dial now; only these are asked. */
  readonly connectableHostIds: ReadonlyArray<string>;
  /** Each answered host's environment. */
  readonly bindings: ReadonlyMap<string, EnvironmentHostBinding>;
  /** Hosts whose environment read failed. */
  readonly failedHostIds: ReadonlyArray<string>;
  /** Hosts that advertise `bot.create`. */
  readonly creatingHostIds: ReadonlySet<string>;
}): BotCreateHostChoice {
  const connectable = new Set(input.connectableHostIds);
  const failed = new Set(input.failedHostIds);
  const ordered: string[] = [];
  const push = (hostId: string | null): void => {
    if (hostId === null || !connectable.has(hostId)) return;
    if (!ordered.includes(hostId)) ordered.push(hostId);
  };
  push(input.localHostId);
  push(input.effectiveHostId);
  push(environmentSandboxForCreate(input.environmentId));
  for (const hostId of [...input.connectableHostIds].sort()) push(hostId);

  for (const hostId of ordered) {
    const binding = input.bindings.get(hostId);
    if (binding === undefined) {
      if (failed.has(hostId)) continue;
      return { kind: "checking" };
    }
    if (
      binding.environment.environmentId === input.environmentId &&
      input.creatingHostIds.has(hostId)
    ) {
      return { kind: "chosen", hostId };
    }
  }
  return { kind: "none" };
}

/**
 * The environment's sandbox, when it should take a new bot: the level-2 arm
 * of the host choice (after the sandbox train), where a team bot defaults to
 * the team's sandbox so it outlives any member's laptop. No environment has
 * one yet.
 */
export function environmentSandboxForCreate(
  _environmentId: string,
): string | null {
  return null;
}
