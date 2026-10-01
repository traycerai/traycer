export const portForwardMutationKeys = {
  stop: () => ["portForward.stop"] as const,
  cutLease: () => ["portForward.cutLease"] as const,
};
