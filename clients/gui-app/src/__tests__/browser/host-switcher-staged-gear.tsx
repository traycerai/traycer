import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * THE COMPOSER HOST CHIP WITH A STAGED PERSONAL SANDBOX, in a 330px row.
 *
 * The real `HostSwitcher`, staged the same way
 * `host-switcher-composer.test.tsx` stages a New Personal sandbox: a
 * composer mode whose `stagedConfigurationKey` is `personal` and whose
 * `stagedLabel` is the long shape name. No host runtime is mounted.
 * `useHostBinding` reads a null context here, which is the unbound picker
 * the composer test stubs.
 *
 * The row is 330px because that is narrower than the label plus the gear.
 * `browser-tests/host-switcher-staged-gear.spec.ts` measures the gear's box,
 * the trigger's truncation and the tooltip. The tooltip delay is 0 so that
 * spec waits on the tooltip, not on a timer.
 *
 * `data-staged-label` is the string the spec expects the trigger to carry
 * in full. It is the same value passed as `stagedLabel`.
 */
const STAGED_LABEL =
  "New Personal sandbox · extra large shape that names the region, the core count and the disk so the trigger has to cut it off";

const LAPTOP = hostScopeOptionFixture({
  hostId: "laptop",
  name: "Laptop",
  isActive: true,
});

export function Fixture(): ReactElement {
  return (
    <TooltipProvider delayDuration={0}>
      <div
        data-testid="host-switcher-staged-gear-stage"
        data-staged-label={STAGED_LABEL}
        className="mt-16"
        style={{ width: 330 }}
      >
        <HostSwitcher
          refusalByHostId={NO_HOST_OPTION_REFUSALS}
          inertExceptHostId={null}
          hosts={[LAPTOP]}
          selected={LAPTOP}
          activeHostId={LAPTOP.hostId}
          onSelect={() => undefined}
          action={null}
          surface="inline"
          intent="pin"
          consequence={null}
          disabled={false}
          isLoading={false}
          listsFailed={false}
          onRetryLists={() => undefined}
          updateViewForHost={null}
          environmentLabelForHost={null}
          composer={{
            viewerUserId: "user-me",
            inThisTask: null,
            subLinesFor: () => [],
            tagFor: () => null,
            newRows: [
              {
                configurationKey: "personal",
                label: "New Personal sandbox",
                subLine: "2 vCPU · 4 GB · $0.12/h · uses your credits",
                configuration: { kind: "personal" },
                disabled: false,
              },
            ],
            rememberedConfigurationKey: null,
            stagedConfigurationKey: "personal",
            stagedLabel: STAGED_LABEL,
            stagedBusy: false,
            onPickHost: () => undefined,
            onPickNew: () => undefined,
            onOpenShape: () => undefined,
            onManage: () => undefined,
          }}
        />
      </div>
    </TooltipProvider>
  );
}

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("host switcher staged gear fixture root missing");
}
createRoot(root).render(<Fixture />);
