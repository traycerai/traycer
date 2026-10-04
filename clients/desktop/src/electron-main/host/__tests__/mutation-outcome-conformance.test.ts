import { describe, expectTypeOf, it } from "vitest";
import type { MutationOutcome as RendererMutationOutcome } from "@traycer-clients/shared/platform/runner-host";
import type { MutationOutcome as MainMutationOutcome } from "../host-controller-types";

// `MutationOutcome` is declared twice: here in Desktop main and in the shared
// renderer-facing `runner-host.ts`. Nothing generates one from the other, so
// a field added to one side and not the other type-checks in each package and
// only breaks at the IPC edge. The failed arm carries `errorCode` (the CLI's
// error code, `null` for a non-CLI error) which the banner reads to tell a
// store-format refusal from any other failure. Both declarations must carry
// it, required, with the same type. Enforced by `compile`; vitest only needs
// the file to load.
type FailedArm<T> = Extract<T, { readonly kind: "failed" }>;

describe("MutationOutcome duplicated declarations", () => {
  it("both failed arms carry a required errorCode: string | null", () => {
    expectTypeOf<FailedArm<MainMutationOutcome<null>>>().toEqualTypeOf<{
      readonly kind: "failed";
      readonly message: string;
      readonly errorCode: string | null;
    }>();
    expectTypeOf<FailedArm<RendererMutationOutcome<null>>>().toEqualTypeOf<{
      readonly kind: "failed";
      readonly message: string;
      readonly errorCode: string | null;
    }>();
  });

  it("the two declarations stay mutually assignable", () => {
    expectTypeOf<MainMutationOutcome<null>>().toEqualTypeOf<
      RendererMutationOutcome<null>
    >();
  });
});
