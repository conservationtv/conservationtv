import * as cloudflare from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';
import type { DnsZone } from './contracts';

export interface AddressRecordsArgs {
  zone: DnsZone;
  hostname: string;
  address: pulumi.Input<string>;
  addressV6?: pulumi.Input<string>;
}

/** Unproxied A (and optional AAAA) records pointing a hostname at a machine. */
export class AddressRecords extends pulumi.ComponentResource {
  public constructor(name: string, args: AddressRecordsArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:AddressRecords', name, {}, opts);
    const record = (type: 'A' | 'AAAA', content: pulumi.Input<string>) =>
      new cloudflare.DnsRecord(
        `${name}-${type.toLowerCase()}`,
        { zoneId: args.zone.zoneId, name: args.hostname, type, content, proxied: false, ttl: args.zone.ttl ?? 60 },
        { parent: this }
      );
    record('A', args.address);
    if (args.addressV6 !== undefined) record('AAAA', args.addressV6);
    this.registerOutputs();
  }
}
