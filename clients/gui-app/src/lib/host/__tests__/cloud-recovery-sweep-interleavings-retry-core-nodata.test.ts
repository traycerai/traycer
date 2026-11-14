import { VARIANTS } from "@/lib/host/test-support/cloud-recovery-interleavings";
import { describeInterleavings } from "@/lib/host/test-support/cloud-recovery-interleavings-suite";

/** See `cloud-recovery-interleavings.ts` for the events and the invariants. */
describeInterleavings({
  retry: "app",
  variants: [VARIANTS[1]],
  passes: ["core", "lifecycle"],
  slice: "all",
});
