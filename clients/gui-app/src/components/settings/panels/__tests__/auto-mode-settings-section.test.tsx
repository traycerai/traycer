import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoPolicyGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import { AutoModeSettingsSection } from "@/components/settings/panels/auto-mode-settings-section";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";

vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () =>
    hostScopeFixture({ status: "following", hostId: "host-a" }),
}));

// Whether `autoJudge.get` / `autoPolicy.get` are advertised, toggled per test
// below. Defaults to neither, which is the negative-half suite's own state
// (a host that predates auto mode, or one this window has not handshaken
// with yet) and keeps that suite's assertions accurate without its own mock.
let supportsPolicy = false;

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (_hostId: string | null, method: string) =>
    method === "autoPolicy.get" && supportsPolicy,
}));

// The section re-provides `HostRuntimeContext` off this binding, but nothing
// downstream reads through it: the judge row never mounts (only
// `autoPolicy.get` is ever advertised below) and the policy row's own RPC
// hooks are stubbed outright. A fixed, minimally-typed object is enough to
// clear the section's `binding === null` gate without standing up a real
// `HostClient`.
const scopedHostBindingFixture: { hostId: string | null } = {
  hostId: "host-a",
};
vi.mock("@/components/settings/host-scope/use-scoped-host-binding", () => ({
  useScopedHostBinding: () => scopedHostBindingFixture,
}));

// The policy row's own read, set per test. `let` at module scope rather than
// inline in the mock factory: `vi.mock` factories are hoisted above imports,
// so this has to be a binding the returned function closes over and reads
// lazily, not a value it captures at declaration time.
let policy: AutoPolicyGetResponse | undefined;

vi.mock("@/hooks/auto-mode/use-auto-policy-query", () => ({
  useAutoPolicyQuery: () => ({ data: policy, isError: false }),
}));
vi.mock("@/hooks/auto-mode/use-auto-policy-set-mutation", () => ({
  useAutoPolicySetMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

beforeEach(() => {
  supportsPolicy = false;
  policy = undefined;
});

afterEach(() => {
  cleanup();
});

describe("<AutoModeSettingsSection />", () => {
  it("renders nothing when the host advertises neither autoJudge.get nor autoPolicy.get", () => {
    // `supportsPolicy` is false here, which is the state a host that predates
    // auto mode leaves the window in: both methods are optional capabilities
    // with an `unsupported` degrade, so neither is advertised.
    //
    // One thing this case no longer covers, and the loss is deliberate: before
    // `readState`, `useHostSupportsMethod` was left as the REAL hook reading an
    // empty negotiated-manifest registry, so this test incidentally pinned that
    // hook failing closed too. The positive half below needs the answer to vary
    // PER METHOD, so the hook is faked now and what is left here is the
    // SECTION's behaviour alone. The hook's own fail-closed default belongs in
    // its own suite.
    render(<AutoModeSettingsSection />);

    // Not nothing: the section is the whole Permissions page, and an empty
    // page reads as a broken one. One sentence, and no control that would
    // silently do nothing on a host with no notion of auto mode.
    expect(screen.getByTestId("auto-mode-unsupported").textContent).toContain(
      "predates Auto mode",
    );
    expect(screen.queryByTestId("auto-judge-picker")).toBeNull();
    expect(screen.queryByText("Auto mode policy")).toBeNull();
    // The judge row's label as SHIPPED. It was "Auto mode judge" until the
    // Providers panel gained a row of the same name; left at the old string
    // this line kept passing while guarding nothing, since no rendered row
    // could ever have produced it.
    expect(screen.queryByText("Traycer's auto mode judge")).toBeNull();
    expect(screen.queryByText("Auto mode")).toBeNull();
  });

  describe("when the host advertises autoPolicy.get", () => {
    beforeEach(() => {
      supportsPolicy = true;
    });

    it("on an unreadable read: never claims the policy is unset, disables editing without inviting a write, and names the state", () => {
      policy = {
        body: null,
        updatedAt: null,
        source: "account",
        readState: "unreadable",
        shippedDefaults: "## Allow exceptions\n\n- Something allowed.\n",
      };
      render(<AutoModeSettingsSection />);

      // `body: null` here means "could not look", not "never saved" - the row
      // must not say "Not set", which would assert the opposite.
      expect(screen.queryByText("Not set")).toBeNull();

      const editButton = screen.getByTestId(
        "auto-policy-edit",
      ) as HTMLButtonElement;
      // Not "Write a policy": that label invites writing over a record this
      // window has not seen. It IS "Edit policy" - what makes Save actually
      // unreachable is the button being disabled, not its label.
      expect(editButton.textContent).not.toBe("Write a policy");
      expect(editButton.textContent).toBe("Edit policy");
      expect(editButton.disabled).toBe(true);

      expect(screen.getByText("Couldn't read your policy")).toBeTruthy();
    });

    it("on a fresh read with a saved body: shows the saved summary and an enabled Edit policy button", () => {
      policy = {
        body: "## Environment\nA laptop running the desktop app.",
        updatedAt: "2026-09-10T00:00:00.000Z",
        source: "account",
        readState: "fresh",
      };
      render(<AutoModeSettingsSection />);

      expect(screen.getByText(/^Saved /)).toBeTruthy();

      const editButton = screen.getByTestId(
        "auto-policy-edit",
      ) as HTMLButtonElement;
      expect(editButton.textContent).toBe("Edit policy");
      expect(editButton.disabled).toBe(false);
    });

    it("shows the shipped-rules row when the response carries a parseable shippedDefaults", () => {
      policy = {
        body: null,
        updatedAt: null,
        source: "account",
        readState: "fresh",
        shippedDefaults:
          "## Allow exceptions\n\n- Read files in the workspace.\n",
      };
      render(<AutoModeSettingsSection />);

      expect(screen.getByTestId("auto-policy-shipped-open")).toBeTruthy();
    });

    it("hides the shipped-rules row when the response carries no shippedDefaults (the older-host case)", () => {
      // Not an empty string - genuinely ABSENT, exactly what an older host's
      // response looks like on the wire (the field rode into `1.0` in place,
      // so nothing else distinguishes that host from this one).
      policy = {
        body: null,
        updatedAt: null,
        source: "account",
      };
      render(<AutoModeSettingsSection />);

      expect(screen.queryByTestId("auto-policy-shipped-open")).toBeNull();
      // And the row above still reads the pre-`readState` behaviour: absent
      // `readState` falls back to `fresh`, and an empty body reads "Not set".
      expect(screen.getByText("Not set")).toBeTruthy();
      const editButton = screen.getByTestId(
        "auto-policy-edit",
      ) as HTMLButtonElement;
      expect(editButton.textContent).toBe("Write a policy");
      expect(editButton.disabled).toBe(false);
    });
  });
});
