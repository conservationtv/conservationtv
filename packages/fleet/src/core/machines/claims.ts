import type { HostClaimLedger, HostClaims } from '../contracts';

type ClaimKind = 'listener' | 'path' | 'container';

/**
 * Append-only record of host resources on one machine. A key may be claimed any number of times
 * by the same owner; a different owner claiming it rejects the program, whichever came first.
 */
export class MachineClaimLedger implements HostClaimLedger {
  private readonly owners = new Map<string, string>();

  public constructor(private readonly machineId: string) {}

  public claim(owner: string, claims: HostClaims): void {
    const entries: [ClaimKind, string][] = [
      ...claims.listeners.map(key => ['listener', key] as [ClaimKind, string]),
      ...claims.paths.map(key => ['path', key] as [ClaimKind, string]),
      ...claims.containerNames.map(key => ['container', key] as [ClaimKind, string])
    ];
    // Check everything before recording anything so a rejected claim leaves the ledger untouched.
    for (const [kind, key] of entries) {
      const existing = this.owners.get(`${kind}:${key}`);
      if (existing !== undefined && existing !== owner) {
        throw new Error(
          `Machine "${this.machineId}": ${kind} "${key}" is claimed by both "${existing}" and "${owner}".`
        );
      }
    }
    for (const [kind, key] of entries) this.owners.set(`${kind}:${key}`, owner);
  }
}
