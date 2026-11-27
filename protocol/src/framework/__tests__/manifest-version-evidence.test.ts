import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildConnectionManifest,
  selectConnectionManifestForPeer,
  SERVES_EVERY_INSTALLED_MAJOR,
  withoutSupportedVersions,
} from "../capability-manifest";
import {
  clientStreamOpenFrameSchema,
  hostStreamOpenAckFrameSchema,
} from "../stream-ws-protocol";
import {
  sessionOpenPayloadSchema,
  sessionOpenAckPayloadSchema,
} from "../../host-transport/mux";
import {
  prepareStreamSubscribeRequest,
  selectPinnedStreamVersions,
} from "../../host-transport/remote/stream-codec";
import { hostStreamRpcRegistry } from "../../host/registry";

// desktop-v1.5.4 / host-v1.5.4 (b7a5f5ca2), ws-protocol.ts:369–392.
const releasedEntry = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
  supportedMajors: z.array(z.number().int().nonnegative()).min(1).optional(),
});
const releasedManifest = z.record(z.string(), releasedEntry);
const releasedLocalOpen = z.object({ manifest: releasedManifest });
// The released local stream OPEN and OPEN_ACK both use connectionManifestSchema
// (stream-ws-protocol.ts:301 and :350). The relay uses this split (mux.ts:456–461).
const releasedRelayOpen = z.object({
  manifest: z.object({
    rpc: releasedManifest,
    optionalRpc: releasedManifest,
    stream: releasedManifest,
  }),
});

const method = "drafts.subscribe";
const activated = buildConnectionManifest(
  hostStreamRpcRegistry,
  SERVES_EVERY_INSTALLED_MAJOR,
)[method];
const releasedVersion = { major: 1, minor: 1 };
const legacyPin = { major: 1, minor: 0, maximumMinor: 1 };

describe("alternate stream version evidence", () => {
  it.each([
    {
      label: "local client OPEN",
      encode: (entry: typeof activated) =>
        clientStreamOpenFrameSchema.parse({
          kind: "open",
          token: "fixture-bearer",
          manifest: { [method]: entry },
        }),
      decode: releasedLocalOpen,
    },
    {
      label: "local host OPEN_ACK",
      encode: (entry: typeof activated) =>
        hostStreamOpenAckFrameSchema.parse({
          kind: "openAck",
          manifest: { [method]: entry },
        }),
      decode: releasedLocalOpen,
    },
    {
      label: "relay client OPEN",
      encode: (entry: typeof activated) =>
        sessionOpenPayloadSchema.parse({
          muxVersion: 1,
          bearer: "fixture-bearer",
          authz: null,
          resume: null,
          manifest: { rpc: {}, optionalRpc: {}, stream: { [method]: entry } },
        }),
      decode: releasedRelayOpen,
    },
    {
      label: "relay host OPEN_ACK",
      encode: (entry: typeof activated) =>
        sessionOpenAckPayloadSchema.parse({
          manifest: { rpc: {}, optionalRpc: {}, stream: { [method]: entry } },
          capabilities: [],
        }),
      decode: releasedRelayOpen,
    },
  ])(
    "preserves the released manifest bytes when decoding $label",
    ({ encode, decode }) => {
      const withEvidence = JSON.stringify(encode(activated));
      const priorBytes = JSON.stringify(
        encode(withoutSupportedVersions(activated)),
      );
      expect(withEvidence).toContain('"supportedVersions"');
      expect(JSON.stringify(decode.parse(JSON.parse(withEvidence)))).toBe(
        JSON.stringify(decode.parse(JSON.parse(priorBytes))),
      );
    },
  );

  it("keeps the exact advertised minors after canonical selection", () => {
    const selected = selectConnectionManifestForPeer(
      hostStreamRpcRegistry,
      { [method]: activated },
      { [method]: releasedVersion },
    );
    expect(selected[method]).toEqual({
      major: 1,
      minor: 1,
      supportedMajors: [1, 2],
      supportedVersions: [
        { major: 1, minor: 0 },
        { major: 1, minor: 1 },
        { major: 2, minor: 0 },
      ],
    });
  });

  it("refuses alternate support without exact minor evidence and caps the pinned line", () => {
    expect(
      selectPinnedStreamVersions(
        hostStreamRpcRegistry,
        method,
        legacyPin,
        activated,
        withoutSupportedVersions(activated),
      ),
    ).toBeUndefined();
    expect(
      selectPinnedStreamVersions(
        hostStreamRpcRegistry,
        method,
        legacyPin,
        activated,
        {
          ...activated,
          supportedVersions: [{ major: 1, minor: 2 }, releasedVersion],
        },
      ),
    ).toEqual({ caller: releasedVersion, peer: releasedVersion });
  });

  it("writes identical unpinned subscribe version and payload with or without evidence", () => {
    const manifest = { [method]: activated };
    const selected = selectConnectionManifestForPeer(
      hostStreamRpcRegistry,
      manifest,
      manifest,
    );
    const previous = withoutSupportedVersions(selected[method]);
    const params = { scopeId: "scope-fixture", afterSeq: 0 };
    const current = prepareStreamSubscribeRequest(
      hostStreamRpcRegistry,
      method,
      selected[method],
      activated,
      params,
    );
    const baseline = prepareStreamSubscribeRequest(
      hostStreamRpcRegistry,
      method,
      previous,
      withoutSupportedVersions(activated),
      params,
    );
    expect(JSON.stringify(current)).toBe(JSON.stringify(baseline));
    expect(current.onWireVersion).toMatchObject({ major: 2, minor: 0 });
  });
});
