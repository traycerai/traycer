import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import {
  providersFallbackPolicyGetV11,
  providersFallbackPolicyPreviewTierGroupsV11,
} from "@traycer/protocol/host/fallback-policy";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

/**
 * Cold-review finding R3: the version gate `useFallbackPolicyPatternLines`
 * computes was untested - every suite that reaches it mocks the hook whole,
 * so `lineReaches` and the choice of which negotiated line feeds which
 * answer were never exercised. This drives the REAL registry and mocks only
 * `useAddressableHostId`, the one seam precedent
 * (`use-host-negotiated-method-version.test.ts`) leaves faked.
 */
const hostIdMock = vi.hoisted((): { value: string | null } => ({
  value: "host-a",
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => hostIdMock.value,
}));

import { useFallbackPolicyPatternLines } from "@/hooks/providers/use-fallback-policy-pattern-lines";

const HOST_ID = "host-a";
const GET_METHOD = providersFallbackPolicyGetV11.method;
const PREVIEW_METHOD = providersFallbackPolicyPreviewTierGroupsV11.method;

function renderLines() {
  return renderHook(() => useFallbackPolicyPatternLines());
}

beforeEach(() => {
  hostIdMock.value = HOST_ID;
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

describe("useFallbackPolicyPatternLines", () => {
  it("reads patterns:false when providers.fallbackPolicy.get negotiated at 1.0", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      [GET_METHOD]: { major: 1, minor: 0 },
      [PREVIEW_METHOD]: { major: 1, minor: 0 },
    });
    const { result } = renderLines();
    // Falsification: `>=` weakened to `>` in `lineReaches` - 1.1 exactly
    // would then read as unreached and this and the 1.1 case below would
    // both read `false`, so this alone would not distinguish the mutant; it
    // is the 1.1 case that catches it. This case pins the floor: an
    // unreached line reads false.
    expect(result.current.patterns).toBe(false);
  });

  it("reads patterns:true when providers.fallbackPolicy.get negotiated at exactly 1.1", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      [GET_METHOD]: { major: 1, minor: 1 },
      [PREVIEW_METHOD]: { major: 1, minor: 1 },
    });
    const { result } = renderLines();
    // Falsification: `>=` weakened to `>` in `lineReaches` - the exact wanted
    // minor would then read as unreached and this goes red.
    expect(result.current.patterns).toBe(true);
  });

  it("reads patterns:true when providers.fallbackPolicy.get negotiated at 1.2", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      [GET_METHOD]: { major: 1, minor: 2 },
      [PREVIEW_METHOD]: { major: 1, minor: 2 },
    });
    const { result } = renderLines();
    expect(result.current.patterns).toBe(true);
  });

  it("reads patterns:false when providers.fallbackPolicy.get negotiated at 2.0 (different major)", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      [GET_METHOD]: { major: 2, minor: 0 },
      [PREVIEW_METHOD]: { major: 2, minor: 0 },
    });
    const { result } = renderLines();
    expect(result.current.patterns).toBe(false);
  });

  it("reads patterns:false at major 2 even with a minor that would reach 1.1 if the major check were dropped", () => {
    // The 2.0 case above cannot alone falsify a dropped major check: minor 0
    // fails the minor comparison on its own. A higher minor under the wrong
    // major is the case that needs the major check specifically.
    recordNegotiatedHostManifest(HOST_ID, {
      [GET_METHOD]: { major: 2, minor: 5 },
      [PREVIEW_METHOD]: { major: 2, minor: 5 },
    });
    const { result } = renderLines();
    // Falsification: the `negotiated.major !== wanted.major` check dropped
    // from `lineReaches` - `5 >= 1` would then read as reached and this
    // would wrongly read `true`.
    expect(result.current).toEqual({
      patterns: false,
      blankPreviewRows: false,
    });
  });

  it("reads both lines false when no handshake has been recorded for the host", () => {
    const { result } = renderLines();
    // Falsification: `lineReaches` treating a `null` negotiated version as
    // reached (`true`) instead of failing closed - this would wrongly read
    // `true` on both lines with nothing recorded at all.
    expect(result.current).toEqual({
      patterns: false,
      blankPreviewRows: false,
    });
  });

  it("reads both lines false when useAddressableHostId answers null, even with another host fully negotiated", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      [GET_METHOD]: { major: 1, minor: 1 },
      [PREVIEW_METHOD]: { major: 1, minor: 1 },
    });
    hostIdMock.value = null;
    const { result } = renderLines();
    expect(result.current).toEqual({
      patterns: false,
      blankPreviewRows: false,
    });
  });

  it("drives blankPreviewRows off previewTierGroups independently: get at 1.1, preview at 1.0", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      [GET_METHOD]: { major: 1, minor: 1 },
      [PREVIEW_METHOD]: { major: 1, minor: 0 },
    });
    const { result } = renderLines();
    // Falsification: the `.get` and `previewTierGroups` lines swapped in
    // `useFallbackPolicyPatternLines` - this would read
    // `{ patterns: false, blankPreviewRows: true }` instead.
    expect(result.current).toEqual({ patterns: true, blankPreviewRows: false });
  });

  it("drives blankPreviewRows off previewTierGroups independently: get at 1.0, preview at 1.1", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      [GET_METHOD]: { major: 1, minor: 0 },
      [PREVIEW_METHOD]: { major: 1, minor: 1 },
    });
    const { result } = renderLines();
    // Falsification: the same swap, from the other side - this would read
    // `{ patterns: true, blankPreviewRows: false }` instead.
    expect(result.current).toEqual({ patterns: false, blankPreviewRows: true });
  });
});
