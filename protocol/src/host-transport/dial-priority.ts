/**
 * Which host sockets the dial gate lets through first.
 *
 * Two values rather than a numeric rank: the gate's only decision is which
 * queue to drain next, and a number invites per-call-site tuning that nothing
 * can verify. `"background"` is a claim about the METHOD - "no rendered
 * surface is waiting on this call" - not about the moment it happens to be
 * issued in.
 *
 * The TYPE lives here because it parameterizes `IWebSocketFactory` and
 * `IStreamWebSocketFactory` (`./websocket.ts`, `./stream-websocket.ts`), which
 * the runtime-neutral remote session core dials through. The POLICY - which
 * method names are background, and the gate that acts on the answer - is a
 * renderer-boot concern and stays in `clients/shared/host-transport`
 * (`dial-priority.ts`, `ws-dial-gate.ts`), which is also the only side that
 * may grow a table of client method names.
 */
export type DialPriority = "interactive" | "background";
