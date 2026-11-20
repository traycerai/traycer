/**
 * The host an opening asks a task's tab to open its session on. It is held
 * only for the synchronous activation that publishes the tab: the canvas
 * store announces the new membership inside that activation (`syncOpenTabs`),
 * so the session controller reads the request while it creates the entry, the
 * way it reads a create host (`sessionCreatedEpicHostId`), and nothing is left
 * once the activation returns.
 *
 * The binding reader answers the other half: the host a tab of this window
 * already holds the epic on, which an opening must not move. The session
 * controller installs it, so this module stays a leaf the navigation
 * controller imports without the session graph.
 */

interface TabHostRequest {
  readonly epicId: string;
  readonly hostId: string;
}

type TabBindingHostReader = (epicId: string) => string | null;

let pending: TabHostRequest | null = null;
let bindingReader: TabBindingHostReader | null = null;

export function requestedTabHostId(epicId: string): string | null {
  return pending !== null && pending.epicId === epicId ? pending.hostId : null;
}

export function withRequestedTabHost<T>(
  epicId: string,
  hostId: string,
  activate: () => T,
): T {
  const outer = pending;
  pending = { epicId, hostId };
  try {
    return activate();
  } finally {
    pending = outer;
  }
}

export function installTabBindingHostReader(
  reader: TabBindingHostReader | null,
): void {
  bindingReader = reader;
}

/** The host a tab of this window holds the epic on; `null` when no tab does. */
export function tabBindingHostId(epicId: string): string | null {
  return bindingReader === null ? null : bindingReader(epicId);
}
