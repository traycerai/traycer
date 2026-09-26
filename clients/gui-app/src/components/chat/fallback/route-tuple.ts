import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import {
  fallbackDestinationOfTuple,
  type FallbackIdentityResolvers,
} from "./fallback-identity";

/**
 * One end of a route line, named segment by segment.
 *
 * Built from {@link fallbackDestinationOfTuple} - the same description every
 * other routing surface names a tuple with - so a chip, the picker's footer and
 * the transcript announcer cannot call one place three things.
 */
export interface RouteTuple {
  readonly harnessId: GuiHarnessId;
  readonly providerLabel: string;
  readonly modelLabel: string;
  readonly effortLabel: string | null;
  readonly profileLabel: string;
}

export function routeTupleOf(
  tuple: ChatRunSettings,
  resolvers: FallbackIdentityResolvers,
): RouteTuple {
  const destination = fallbackDestinationOfTuple(
    tuple,
    resolvers.labelFor,
    resolvers.modelLabelFor,
  );
  return {
    harnessId: tuple.harnessId,
    providerLabel: destination.providerLabel,
    modelLabel: destination.modelLabel,
    effortLabel: destination.effortLabel,
    profileLabel: destination.profileLabel,
  };
}

/**
 * "Fable · high · Surya" as one string, for an accessible name and for the
 * sentence a trigger's label is read as. The provider is named only when the
 * route crosses providers, as on the chip itself.
 */
export function routeTupleText(
  tuple: RouteTuple,
  peer: RouteTuple | null,
): string {
  return routeTupleSegments(tuple, peer)
    .map((segment) => segment.text)
    .join(" · ");
}

export type RouteSegmentKind = "provider" | "model" | "effort" | "profile";

export interface RouteSegment {
  readonly kind: RouteSegmentKind;
  readonly text: string;
}

/**
 * The segments a chip names, in order. The provider appears only on a route
 * that crosses providers: within one provider it is the same word on both
 * ends, and the harness glyph at the head of the chip already says it.
 */
export function routeTupleSegments(
  tuple: RouteTuple,
  peer: RouteTuple | null,
): ReadonlyArray<RouteSegment> {
  const crossesProviders = peer !== null && peer.harnessId !== tuple.harnessId;
  const segments: RouteSegment[] = [];
  if (crossesProviders) {
    segments.push({ kind: "provider", text: tuple.providerLabel });
  }
  segments.push({ kind: "model", text: tuple.modelLabel });
  if (tuple.effortLabel !== null) {
    segments.push({ kind: "effort", text: tuple.effortLabel });
  }
  segments.push({ kind: "profile", text: tuple.profileLabel });
  return segments;
}

function peerSegmentText(
  peer: RouteTuple,
  kind: RouteSegmentKind,
): string | null {
  switch (kind) {
    case "provider":
      return peer.providerLabel;
    case "model":
      return peer.modelLabel;
    case "effort":
      return peer.effortLabel;
    case "profile":
      return peer.profileLabel;
  }
}

/**
 * How loud one segment is.
 *
 * On a PAIR, a segment that is the same on both ends is muted on both - it is
 * not what the route is about - and a segment that differs is plain on the
 * "from" end and bold on the "to" end, so the eye lands on what changes and
 * where it changes to. A lone tuple (a wait) has no "to": its account is the
 * subject and reads plain, and the model it runs is muted context.
 */
export function routeSegmentEmphasis(
  segment: RouteSegment,
  peer: RouteTuple | null,
  end: "from" | "to" | "single",
): "muted" | "plain" | "strong" {
  if (peer === null || end === "single") {
    return segment.kind === "profile" ? "plain" : "muted";
  }
  if (peerSegmentText(peer, segment.kind) === segment.text) return "muted";
  return end === "to" ? "strong" : "plain";
}
