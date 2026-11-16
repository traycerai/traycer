import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT } from "@traycer/protocol/host/sandbox-control";
import { SandboxOperationFailure } from "@/components/hosts/sandbox-operation-failure";
import { SandboxOperationError } from "@/hooks/sandboxes/sandbox-failure-copy";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  installHostDirectoryRows,
  resetHostDirectoryRows,
  sandboxHostEntry,
  sandboxHostEntryWithoutOwner,
} from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";

const HOST_ID = "sandbox-host-failed";

afterEach(() => {
  cleanup();
  resetHostDirectoryRows();
});

/**
 * A failed Resume that the credit gate refused from the person's own balance,
 * on a surface that names no configuration, so whose sandbox it is comes only
 * from the person's host directory.
 */
function renderCreditFailureOn(rows: ReadonlyArray<HostDirectoryEntry>): void {
  installHostDirectoryRows(rows);
  render(
    <RunnerHostProvider runnerHost={createFakeRunnerHost({})}>
      <QueryClientProvider client={new QueryClient()}>
        <SandboxOperationFailure
          sandboxId="sbx-frozen"
          name="e2e-sbx"
          hostId={HOST_ID}
          operation={{
            kind: "failed",
            verb: "resume",
            error: new SandboxOperationError({
              kind: "refused",
              status: 402,
              code: SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
              reason: "denied",
              shortfallMc: 1_250,
              creditSource: "personal",
              newRateMcPerHour: null,
              currentAwakeBurnMcPerHour: null,
              message: null,
            }),
            code: SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT,
            reference: "SBX-0901",
            destroyRequest: undefined,
          }}
          busy={false}
          onRetry={null}
        />
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
}

describe("a failed operation's credit line reads whose sandbox it is from the directory", () => {
  it("names the person's own credits and offers the top-up when the row names them as the owner", () => {
    renderCreditFailureOn([sandboxHostEntry(HOST_ID, null)]);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(
      "Couldn't resume e2e-sbx · your credits are short $1.25. $1.25 more wakes it for an hour.",
    );
    expect(screen.getByRole("button", { name: "Add credits ↗" })).toBeTruthy();
  });

  it.each([
    ["no directory row for the host", [] as const],
    [
      "a directory row with no owner",
      [sandboxHostEntryWithoutOwner(HOST_ID)] as const,
    ],
  ])(
    "tells nothing as the person's own and offers no top-up with %s",
    (_state, rows) => {
      renderCreditFailureOn(rows);

      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(
        "Couldn't resume e2e-sbx · not enough credits to wake this sandbox for an hour.",
      );
      expect(alert.textContent).not.toContain("your credits");
      expect(
        screen.queryByRole("button", { name: "Add credits ↗" }),
      ).toBeNull();
    },
  );
});
