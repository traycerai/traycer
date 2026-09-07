/**
 * Write keys for the host's own lifecycle and identity RPCs - the Overview page's buttons (`host.restart`, `host.identity.set`, `host.doctor`, `host.update.*`).
 */
export const hostMaintenanceMutationKeys = {
  restart: () => ["host.restart"] as const,
  identitySet: () => ["host.identity.set"] as const,
  doctorRun: () => ["host.doctor"] as const,
  // Its own key even though only the Doctor card issues it.
  // Tailing the log is a READ the user asks for after a Doctor verdict, not part of running one, and sharing `doctorRun()` would make any future `useIsMutating` on that key count a log fetch as a Doctor run - the same confusion the note above rules out for the.
  logsTail: () => ["host.diagnostics.logsTail"] as const,
  updateCheck: () => ["host.update.check"] as const,
  updateInstall: () => ["host.update.install"] as const,
  // The OS-service writes.
  // Two keys rather than one `serviceCycle()`: they are not two directions of one control - registering leaves a supervised host running, deregistering stops it and does not bring it back - and a shared key would let a pending Deregister grey out Re-register.
  serviceRegister: () => ["host.service.register"] as const,
  serviceDeregister: () => ["host.service.deregister"] as const,
};
