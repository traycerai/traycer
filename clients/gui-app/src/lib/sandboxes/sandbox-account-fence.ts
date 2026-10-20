import { useAuthStore } from "@/stores/auth/auth-store";

/** The account signed in now, as a sandbox mutation or wake records it. */
export function signedInUserId(): string | null {
  return useAuthStore.getState().contextMetadata?.userId ?? null;
}

/**
 * Whether the account that started a sandbox mutation is still the one signed
 * in when it ends. A create, a destroy, a lifecycle verb or a wake can run
 * for minutes and outlive a sign-out and a sign-in as someone else. Its
 * outcome then belongs to the first account, so the second sees no toast and
 * none of its caches move. The first account's lists catch up on its next
 * sign-in, through the ordinary first read.
 */
export function settledForStartingAccount<
  Context extends { readonly userId: string | null },
>(context: Context | undefined): context is Context {
  return context !== undefined && signedInUserId() === context.userId;
}
