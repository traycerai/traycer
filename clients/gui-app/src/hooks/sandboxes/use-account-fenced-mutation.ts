import { useCallback, useMemo } from "react";
import type {
  MutateOptions,
  UseMutateAsyncFunction,
  UseMutateFunction,
  UseMutationResult,
} from "@tanstack/react-query";
import { settledForStartingAccount } from "@/lib/sandboxes/sandbox-account-fence";

/**
 * A caller's per-call `onSuccess` / `onError` / `onSettled`, run only when
 * the account that started the mutation is still signed in. The hook's own
 * callbacks already ask `settledForStartingAccount`; a caller's per-call ones
 * run beside them and asked nothing, so a card's toast for A's suspend
 * reached B.
 */
function fencedOptions<
  TData,
  TError,
  TVariables,
  TContext extends { readonly userId: string | null },
>(
  options: MutateOptions<TData, TError, TVariables, TContext> | undefined,
): MutateOptions<TData, TError, TVariables, TContext> | undefined {
  if (options === undefined) return undefined;
  const { onSuccess, onError, onSettled } = options;
  return {
    onSuccess: (data, variables, onMutateResult, context) => {
      if (!settledForStartingAccount(onMutateResult)) return;
      onSuccess?.(data, variables, onMutateResult, context);
    },
    onError: (error, variables, onMutateResult, context) => {
      if (!settledForStartingAccount(onMutateResult)) return;
      onError?.(error, variables, onMutateResult, context);
    },
    // TanStack's five arguments, passed through whole; the fourth is
    // `onMutate`'s result.
    onSettled: (...args) => {
      if (!settledForStartingAccount(args[3])) return;
      onSettled?.(...args);
    },
  };
}

/** `mutation` with `mutate` and `mutateAsync` fenced as {@link fencedOptions}. */
export function useAccountFencedMutation<
  TData,
  TError,
  TVariables,
  TContext extends { readonly userId: string | null },
>(
  mutation: UseMutationResult<TData, TError, TVariables, TContext>,
): UseMutationResult<TData, TError, TVariables, TContext> {
  const { mutate: unfencedMutate, mutateAsync: unfencedMutateAsync } = mutation;
  const mutate = useCallback<
    UseMutateFunction<TData, TError, TVariables, TContext>
  >(
    (variables, options) => {
      unfencedMutate(variables, fencedOptions(options));
    },
    [unfencedMutate],
  );
  const mutateAsync = useCallback<
    UseMutateAsyncFunction<TData, TError, TVariables, TContext>
  >(
    (variables, options) =>
      unfencedMutateAsync(variables, fencedOptions(options)),
    [unfencedMutateAsync],
  );
  return useMemo(
    () => ({ ...mutation, mutate, mutateAsync }),
    [mutation, mutate, mutateAsync],
  );
}
