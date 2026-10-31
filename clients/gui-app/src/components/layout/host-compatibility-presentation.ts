import type { DefaultHostReadinessPresentation } from "@/components/layout/host-readiness-controller-context";
import type { HostCompatibility } from "@/lib/host/compatibility-state";

/**
 * The probe verdict, reduced to what a pre-filled REPORT needs (D13, P3.2).
 *
 * It used to carry the copy and the recovery action too - `errorMessage`,
 * `retry`, `retrying` - because two surfaces narrated compatibility from it.
 * Both are gone: the verdict reaches the user through the lease's
 * `incompatible` arm now, and the probe's own `retry` stays where it always
 * lived, on the compat context, for whoever genuinely needs to re-ask.
 *
 * EXTRACTED FROM `host-readiness-controller.tsx` FOR ITS OWN TEST, and the
 * extraction is the point. Sealed probe R6 (P3.2) mutated this function and
 * SURVIVED TWICE: the pin meant to cover it asserted on `describeCompatHealth`
 * - a different function, one layer downstream - so the re-fire measured the
 * same hole a second time rather than closing it. The harness that would have
 * caught it needed a component P3.4 was in the middle of deleting, which is
 * why the residual travelled to P4.3 as a named rider.
 *
 * It lives in its own module rather than as an export beside the controller
 * because that file exports three COMPONENTS, and a non-component export
 * alongside them trips `react-refresh/only-export-components` - the rule whose
 * whole purpose is to stop a module mixing the two, since Fast Refresh cannot
 * safely re-run a module that does. The same split `tile-host-load-copy.ts`
 * made for the same reason, and it has the same happy side effect: the mapping
 * can be asserted without mounting anything.
 */
export function compatibilityPresentation(
  compatibility: HostCompatibility,
): DefaultHostReadinessPresentation["compatibility"] {
  if (compatibility.status === "failed") {
    return {
      status: "failed",
      degraded: false,
      unreachable: compatibility.unreachable,
      hostStatus: null,
    };
  }
  if (compatibility.status === "incompatible") {
    return {
      status: "incompatible",
      degraded: false,
      unreachable: false,
      hostStatus: null,
    };
  }
  if (compatibility.status === "checking") {
    return {
      status: "checking",
      degraded: false,
      unreachable: false,
      hostStatus: null,
    };
  }
  return {
    status: "compatible",
    degraded: compatibility.degraded,
    unreachable: false,
    hostStatus: compatibility.hostStatus,
  };
}
