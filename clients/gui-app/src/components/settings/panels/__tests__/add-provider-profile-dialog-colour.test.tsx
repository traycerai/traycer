import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_PROFILE_ACCENT_COLORS,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AuthService } from "@/lib/auth/auth-service";
import { unavailableSignInRequestAuthService } from "@/lib/auth/__tests__/provider-sign-in-request-test-support";
import { AddProviderProfileDialog } from "@/components/settings/panels/add-provider-profile-dialog";
import {
  profile,
  provider,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";

let authServiceForTest: AuthService | null = null;

function currentAuthService(): AuthService {
  if (authServiceForTest === null) {
    throw new Error("sign-in request AuthService was not set up");
  }
  return authServiceForTest;
}

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useAuthService: currentAuthService };
});
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return { ...actual, useAuthService: currentAuthService };
});
vi.mock("@/lib/links/open-link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/links/open-link")>();
  return { ...actual, useOpenLink: () => () => Promise.resolve() };
});

const [FIRST_COLOR, SECOND_COLOR] = PROVIDER_PROFILE_ACCENT_COLORS;

const WORK = {
  ...profile("work", "managed"),
  label: "Work",
  accentColor: FIRST_COLOR,
};

/** The row a sign-in creates: listed with the colour the dialog chose for it. */
const PERSONAL_3 = {
  ...profile("personal-3", "managed"),
  label: "Personal 3",
  accentColor: SECOND_COLOR,
};

const ALREADY_USES = /already uses this color/;

interface Mounted {
  readonly show: (state: ProviderCliState) => void;
}

/** The dialog open on `state`; `show` hands the same open dialog a newer provider row. */
function renderDialog(state: ProviderCliState): Mounted {
  const { client } = buildEnvironmentClient({
    hostId: "colour-warning",
    handlers: {
      "providers.list": () => ({ providers: [state], native: null }),
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const dialogFor = (current: ProviderCliState) => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AddProviderProfileDialog
          state={current}
          client={client}
          isLocalHost
          open
          target={null}
          targetResult={null}
          onOpenChange={vi.fn()}
          onFailedAttempt={vi.fn()}
          onProfileCreated={vi.fn()}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(dialogFor(state));
  return { show: (next) => view.rerender(dialogFor(next)) };
}

beforeEach(() => {
  authServiceForTest = unavailableSignInRequestAuthService();
});

afterEach(() => {
  cleanup();
  authServiceForTest?.dispose();
  authServiceForTest = null;
  resetNegotiatedManifests();
  vi.clearAllMocks();
});

describe("the Add dialog's duplicate-colour warning", () => {
  it("does not name the profile this dialog's own sign-in created", () => {
    const dialog = renderDialog(provider("claude-code", [WORK]));
    expect(screen.queryByText(ALREADY_USES)).toBeNull();

    dialog.show(provider("claude-code", [WORK, PERSONAL_3]));

    expect(
      screen
        .getByRole("button", { name: `Use color ${SECOND_COLOR}` })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByText(ALREADY_USES)).toBeNull();
  });

  it("still names a profile that was there when the dialog opened", () => {
    const dialog = renderDialog(provider("claude-code", [WORK]));
    dialog.show(provider("claude-code", [WORK, PERSONAL_3]));

    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${FIRST_COLOR}` }),
    );

    expect(screen.getByText(/Work already uses this color/)).toBeTruthy();
    expect(screen.queryByText(/Personal 3 already uses/)).toBeNull();
  });
});
