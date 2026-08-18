import { TransportEvidenceRelay } from "@traycer-clients/shared/host-selection/transport-evidence";

/**
 * This window's one transport-evidence relay (redesign P1.3).
 *
 * Module-scoped DELIBERATELY, and the reason is a scope-matching rule rather
 * than convenience: the relay's lifetime must equal the lifetime of the
 * transports that report through it, and the remote-session pool
 * (`host-transport/remote/active-remote-sessions.ts`) is itself module-scoped.
 * A session built by one host-runtime generation is handed to the next one
 * straight out of that cache without its factory re-running, so a relay owned
 * by the runtime effect would leave every warm session reporting into a
 * disposed kernel - whose evidence the authority drops at the incarnation
 * gate. Silent evidence loss, in exactly the window (a remount, an account
 * switch) where the engine most needs to hear from the sockets.
 *
 * One window is one renderer is one kernel (connection registry §1b), so a
 * single relay per module is also exactly one relay per kernel. The
 * composition root (`host-runtime-provider`) binds the live kernel and unbinds
 * on teardown; until something is bound every report is a no-op, which is the
 * correct answer for a transport that dials before the authority has attached.
 */
export const transportEvidenceRelay = new TransportEvidenceRelay();
