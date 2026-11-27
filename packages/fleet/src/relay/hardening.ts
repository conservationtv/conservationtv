import type { ComposeMapping } from '../core/contracts';

/**
 * What a relay container may do: read its mounted config and certificates, and bind ports below 1024 on the host's
 * network. Its root filesystem is read-only, every other capability is dropped, and nothing in it can gain privileges.
 * Both relay images run as root, so the dropped capabilities are what keeps a compromised relay from the rest of the
 * machine.
 */
export const RELAY_CONTAINER_HARDENING: ComposeMapping = {
  read_only: true,
  tmpfs: ['/tmp'],
  cap_drop: ['ALL'],
  cap_add: ['NET_BIND_SERVICE'],
  security_opt: ['no-new-privileges:true']
};
