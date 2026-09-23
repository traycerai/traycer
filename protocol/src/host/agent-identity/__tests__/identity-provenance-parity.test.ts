import { describe, expect, it } from "vitest";
import { artifactVersionProvenanceSchema } from "@traycer/protocol/host/epic/artifact-versions";
import { agentIdentityVersionProvenanceSchema } from "@traycer/protocol/host/agent-identity/unary-schemas";
import { identityDocumentProvenanceKindSchema } from "@traycer/protocol/persistence/identity/schemas";

/**
 * The three places identity provenance is spelled must agree.
 *
 * There are three because each answers a different question and none can be
 * derived from the others at the layer it lives:
 *
 * 1. `artifactVersionProvenanceSchema` - the ten artifact-history variants, on a
 *    RELEASED line (`epic.artifactVersions.list`). Growing this enum is a
 *    breaking change, which is exactly why identity does not grow it.
 * 2. `agentIdentityVersionProvenanceSchema` - the identity history union,
 *    DERIVED from (1) plus an `evolution` arm.
 * 3. `identityDocumentProvenanceKindSchema` - the persisted kind on a
 *    `documents` entry. It restates the vocabulary because persistence must not
 *    import the host RPC surface.
 *
 * (2) cannot drift from (1) - it is built from its options - but (3) can, and
 * silently: a hand-written enum in a different package is the classic place for
 * a new variant to fail to arrive. So the assertion that matters is the one
 * binding (3) to (1).
 */

/**
 * The minimal structural view of a discriminated-union arm this file needs.
 *
 * Declared rather than inferred so the helper takes both unions without either
 * one's concrete option type leaking into the signature - and read off the
 * SCHEMA rather than a JSON-Schema dump, which renders a discriminated union as
 * `oneOf` and a plain union as `anyOf`, so a dump-based reader would break the
 * day one of these two changed shape for an unrelated reason.
 */
interface LiteralKindArm {
  readonly shape: { readonly kind: { readonly value: string } };
}

function discriminants(options: readonly LiteralKindArm[]): readonly string[] {
  return options.map((option) => option.shape.kind.value).sort();
}

describe("identity provenance parity", () => {
  it("carries every artifact provenance kind, plus evolution and nothing else", () => {
    const artifact = discriminants(artifactVersionProvenanceSchema.options);
    const identity = discriminants(
      agentIdentityVersionProvenanceSchema.options,
    );

    expect(identity).toEqual([...artifact, "evolution"].sort());
  });

  it("keeps the persisted kind enum in step with the history union", () => {
    // The one assertion that can actually fail. If an arm is added upstream and
    // this reddens, add the value to `identityDocumentProvenanceKindSchema` -
    // never delete the check, which is the only thing holding the two packages
    // together.
    expect([...identityDocumentProvenanceKindSchema.options].sort()).toEqual(
      discriminants(agentIdentityVersionProvenanceSchema.options),
    );
  });

  it("leaves the released artifact enum free of evolution", () => {
    // The whole reason for the split: `epic.artifactVersions.list` ships, and an
    // enum value added to a released response fails an old peer's strict parse
    // of the WHOLE response, not one field.
    expect(
      discriminants(artifactVersionProvenanceSchema.options),
    ).not.toContain("evolution");
  });
});
