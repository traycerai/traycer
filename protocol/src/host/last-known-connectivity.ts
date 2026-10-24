import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { z } from "zod";

/**
 * What the answering side last observed about another host's reachability:
 * `known` with the connectivity and the epoch-milliseconds time it was
 * observed, or `unknown` when no source this side is authorized to read has
 * said.
 *
 * `unknown` is NEVER `offline`. A collaborator's host, or a host this side has
 * no presence feed for, reads `unknown`; folding that into `offline` would
 * report a reachable host as down.
 */
export type LastKnownConnectivity =
  | {
      readonly kind: "known";
      readonly connectivity: "connectable" | "offline";
      readonly observedAt: number;
    }
  | { readonly kind: "unknown" };

export const lastKnownConnectivitySchema: z.ZodType<LastKnownConnectivity> =
  lazySchema(() =>
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("known"),
        connectivity: z.enum(["connectable", "offline"]),
        observedAt: z.number().int().nonnegative(),
      }),
      z.object({ kind: z.literal("unknown") }),
    ]),
  );

/** The value every reader without an authorized source writes. */
export const UNKNOWN_CONNECTIVITY: LastKnownConnectivity = { kind: "unknown" };
