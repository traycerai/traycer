export type PersonalLeaveAccountState =
  | { readonly kind: "skip" }
  | { readonly kind: "signed-in"; readonly admissionId: string }
  | {
      readonly kind: "account-mismatch" | "account-unproven";
    };

export type PersonalLeaveAccountStates = ReadonlyMap<
  string,
  PersonalLeaveAccountState
>;

export function personalLeaveAddress(row: {
  readonly providerId: string;
  readonly profileId: string;
}): string {
  return JSON.stringify([row.providerId, row.profileId]);
}
