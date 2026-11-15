import { resolveProfilePin } from "@/components/providers/provider-profile-model";
import { useMemo, type ReactNode } from "react";
import type { EnvironmentMovePersonalProfile } from "@traycer/protocol/host/environment/move-contracts";
import type { ProvidersListResponse } from "@traycer/protocol/host/provider-schemas";
import {
  differentAccountText,
  profileNotChangedText,
  SIGN_IN_TEXT,
  SIGN_IN_UNPROVEN_TEXT,
} from "@/components/providers/profile-sync-copy";
import {
  PERSONAL_LEAVE_ACCOUNTS,
  PERSONAL_LEAVE_NOT_NEEDED,
  PERSONAL_LEAVE_SIGNED_IN,
  personalLeaveSameAccount,
  personalLeaveSkipped,
} from "@/components/settings/move/personal-leave-copy";
import { Button } from "@/components/ui/button";
import { providerDisplayName } from "@/lib/provider-ordering";

import {
  personalLeaveAddress,
  type PersonalLeaveAccountState,
  type PersonalLeaveAccountStates,
} from "./personal-leave-model";

export function PersonalLeaveAccounts(props: {
  readonly rows: readonly EnvironmentMovePersonalProfile[];
  readonly providers: ProvidersListResponse["providers"];
  readonly states: PersonalLeaveAccountStates;
  readonly pending: boolean;
  readonly guidance: ReactNode;
  readonly onSignIn: (row: EnvironmentMovePersonalProfile) => void;
  readonly onChange: (
    row: EnvironmentMovePersonalProfile,
    state: PersonalLeaveAccountState | null,
  ) => void;
}): ReactNode {
  const sameAccounts = useMemo(() => {
    const providers = new Map(
      props.providers.map((provider) => [
        provider.providerId,
        provider.profiles,
      ]),
    );
    const first = new Map<string, string>();
    const same = new Map<string, string>();
    for (const row of props.rows) {
      const address = personalLeaveAddress(row);
      const pin = resolveProfilePin(
        providers.get(row.providerId) ?? [],
        [],
        row.profileId,
      );
      if (pin.kind !== "row") continue;
      const account = personalLeaveAddress({
        providerId: row.providerId,
        profileId: pin.profile.profileId,
      });
      const label = first.get(account);
      if (label === undefined) first.set(account, row.label);
      else same.set(address, label);
    }
    return same;
  }, [props.providers, props.rows]);

  if (props.rows.length === 0) return null;
  return (
    <section data-testid="personal-leave-accounts">
      <h3 className="mb-1 text-ui-sm font-medium text-foreground">
        {PERSONAL_LEAVE_ACCOUNTS}
      </h3>
      {props.guidance}
      <ul className="flex flex-col gap-3">
        {props.rows.map((row) => {
          const address = personalLeaveAddress(row);
          const state = props.states.get(address);
          const same = sameAccounts.get(address);
          const provider = providerDisplayName(row.providerId);
          return (
            <li
              key={address}
              className="flex flex-col gap-1.5"
              data-testid={`personal-leave-${row.providerId}-${row.profileId}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-ui-sm text-foreground">{row.label}</p>
                <p className="text-ui-xs text-muted-foreground">{provider}</p>
              </div>
              {same !== undefined ? (
                <p className="text-ui-xs text-muted-foreground">
                  {personalLeaveSameAccount(same)}
                </p>
              ) : null}
              <PersonalLeaveActions
                row={row}
                state={state}
                pending={props.pending}
                onSignIn={props.onSignIn}
                onChange={props.onChange}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PersonalLeaveActions(props: {
  readonly row: EnvironmentMovePersonalProfile;
  readonly state: PersonalLeaveAccountState | undefined;
  readonly pending: boolean;
  readonly onSignIn: (row: EnvironmentMovePersonalProfile) => void;
  readonly onChange: (
    row: EnvironmentMovePersonalProfile,
    state: PersonalLeaveAccountState | null,
  ) => void;
}): ReactNode {
  const { row, state } = props;
  if (row.signIn === "not-needed")
    return (
      <p className="text-ui-xs text-muted-foreground">
        {PERSONAL_LEAVE_NOT_NEEDED}
      </p>
    );
  if (state?.kind === "signed-in")
    return (
      <p className="text-ui-xs text-muted-foreground">
        {PERSONAL_LEAVE_SIGNED_IN}
      </p>
    );
  if (state?.kind === "skip")
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-ui-xs text-muted-foreground">
          {personalLeaveSkipped(providerDisplayName(row.providerId))}
        </p>
        <Button
          type="button"
          size="xs"
          variant="link"
          disabled={props.pending}
          onClick={() => props.onChange(row, null)}
        >
          Undo
        </Button>
      </div>
    );
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={props.pending}
          onClick={() => props.onSignIn(row)}
        >
          {SIGN_IN_TEXT}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={props.pending}
          onClick={() => props.onChange(row, { kind: "skip" })}
        >
          Skip
        </Button>
      </div>
      {state?.kind === "account-mismatch" ? (
        <p className="text-ui-xs text-muted-foreground">
          {differentAccountText(row.label)}
        </p>
      ) : null}
      {state?.kind === "account-unproven" ? (
        <>
          <p className="text-ui-xs text-muted-foreground">
            {SIGN_IN_UNPROVEN_TEXT}
          </p>
          <p className="text-ui-xs text-muted-foreground">
            {profileNotChangedText(row.label)}
          </p>
        </>
      ) : null}
    </>
  );
}
