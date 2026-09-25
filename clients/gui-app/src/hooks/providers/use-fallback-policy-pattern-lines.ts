import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  providersFallbackPolicyGetV11,
  providersFallbackPolicyPreviewTierGroupsV11,
} from "@traycer/protocol/host/fallback-policy";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";

/**
 * What the surface's host can do with a tier row, read off the NEGOTIATED
 * method lines rather than off whether a method exists.
 *
 * Both answers are version questions, and `useHostSupportsMethod` cannot ask
 * them: a 1.0 host advertises `providers.fallbackPolicy.get` and
 * `previewTierGroups` exactly as a 1.1 host does, so a presence check would
 * put a pattern editor in front of a host whose word matcher never matches
 * `*opus*`.
 *
 *  - `patterns` - `providers.fallbackPolicy.get` is on 1.1 or later, so the
 *    host reads a tier row's `modelFamily` as a pattern (`modelMatchesPattern`).
 *    The editor offers the pattern combobox and draws "one model, one tier"
 *    conflicts only then; below it the Model cell stays the select-only cell
 *    and nothing is judged by pattern rules the host does not apply.
 *  - `blankPreviewRows` - `previewTierGroups` is on 1.1 or later, so a draft
 *    row with a blank pattern may travel in the preview request and comes back
 *    as a skipped row. On 1.0 the client's own projection refuses such a
 *    request before it is sent, so the editor keeps its old gate there.
 *
 * Deliberately NOT inferred from the preview response: the 1.0 → 1.1 upgrade
 * synthesises `matches`, so a response always has it, and only the negotiated
 * line says what the host really is.
 *
 * Fails closed. No handshake yet reads as 1.0 on both lines - the select-only
 * cell and today's preview gate - which is the state every released host is in
 * anyway, and the page's own policy read completes a handshake before the
 * editor has anything to render.
 */
export interface FallbackPolicyPatternLines {
  readonly patterns: boolean;
  readonly blankPreviewRows: boolean;
}

export function useFallbackPolicyPatternLines(): FallbackPolicyPatternLines {
  // The surface's host - under Settings' re-provided binding this is the
  // scoped host, the one the policy is read from and saved to.
  const hostId = useAddressableHostId();
  const getLine = useHostMethodSchemaVersion(
    hostId,
    providersFallbackPolicyGetV11.method,
  );
  const previewLine = useHostMethodSchemaVersion(
    hostId,
    providersFallbackPolicyPreviewTierGroupsV11.method,
  );
  return {
    patterns: lineReaches(getLine, providersFallbackPolicyGetV11.schemaVersion),
    blankPreviewRows: lineReaches(
      previewLine,
      providersFallbackPolicyPreviewTierGroupsV11.schemaVersion,
    ),
  };
}

/**
 * Whether a negotiated line is on `wanted`'s major at or above its minor.
 *
 * A different major is a different contract, so it answers no rather than
 * comparing minors across it - the same rule `catalogLineKnowsAutoMode` applies.
 */
function lineReaches(
  negotiated: SchemaVersion | null,
  wanted: SchemaVersion,
): boolean {
  if (negotiated === null) return false;
  if (negotiated.major !== wanted.major) return false;
  return negotiated.minor >= wanted.minor;
}
