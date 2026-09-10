/**
 * "The host runtime has started" as a subscribable fact, published once per
 * renderer load.
 *
 * WHY IT EXISTS AT ALL. The launch mark has to tell "auth has not answered yet"
 * apart from "auth answered, and the answer is signed-out", and the auth store
 * cannot say: its initial state is literally `status: "signed-out"` with
 * `signedOutCause: "retired"`, so a launch that has read nothing is
 * indistinguishable from a launch that read a signed-out session. Waiting on
 * the wrong one of those shows the mark for 2.5s to somebody whose auth is
 * still settling, or drops it instantly on somebody who is genuinely signed
 * out.
 *
 * WHY THIS IS THE RIGHT FACT. `HostRuntimeProvider`'s startup awaits
 * `auth.start()` BEFORE it sets its binding, so by the time the binding exists
 * auth has necessarily resolved. That ordering is the guarantee this signal
 * borrows, and it is why the flag is raised beside `setBinding` rather than
 * anywhere else - the two are the same instant, and separating them would
 * reintroduce the ambiguity above.
 *
 * WHY NOT REACT CONTEXT. The consumer is mounted ABOVE `HostRuntimeProvider`,
 * because the mark has to survive the provider swapping its fallback for its
 * children - a context read from up there is always `null`, and a consumer
 * moved down there would remount at exactly the moment it exists to bridge.
 *
 * Renderer-scoped and deliberately not resettable in production: a launch
 * happens once per page load. {@link resetLaunchRuntimeSignalForTest} exists
 * because a test file drives several launches through one module instance.
 */
let hostRuntimeStarted = false;
const listeners = new Set<() => void>();

export function markHostRuntimeStarted(): void {
  if (hostRuntimeStarted) return;
  hostRuntimeStarted = true;
  for (const listener of listeners) listener();
}

export function hasHostRuntimeStarted(): boolean {
  return hostRuntimeStarted;
}

export function subscribeHostRuntimeStarted(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetLaunchRuntimeSignalForTest(): void {
  hostRuntimeStarted = false;
  listeners.clear();
}
