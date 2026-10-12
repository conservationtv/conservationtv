import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import type { AddressRecordArgs, DnsRegistrar } from './types';
import { preflightCloudflare, type PreflightOptions } from '../preflight';

export interface CloudflareDnsRegistrarArgs {
  zoneId: pulumi.Input<string>;
  ttl?: number;
  preflight?: PreflightOptions;
}

export class CloudflareDnsRegistrar extends pulumi.ComponentResource implements DnsRegistrar {
  private readonly zoneId: pulumi.Input<string>;
  private readonly defaultTtl: number;

  public constructor(name: string, args: CloudflareDnsRegistrarArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:CloudflareDnsRegistrar', name, {}, opts);
    if (!opts?.providers) preflightCloudflare(args.preflight);
    this.zoneId = args.zoneId;
    this.defaultTtl = args.ttl ?? 60;
    this.registerOutputs();
  }

  // Create an unproxied A record and an optional AAAA record, inheriting the parent and TTL defaults.
  public createAddressRecords(
    name: string,
    args: AddressRecordArgs,
    opts?: pulumi.CustomResourceOptions
  ): pulumi.Resource[] {
    const resourceOpts = { ...opts, parent: opts?.parent ?? this };
    const records: pulumi.Resource[] = [
      new cloudflare.DnsRecord(
        `${name}-a`,
        {
          zoneId: this.zoneId,
          name: args.hostname,
          type: 'A',
          content: args.address,
          proxied: false,
          ttl: args.ttl ?? this.defaultTtl
        },
        resourceOpts
      )
    ];
    if (args.addressV6 !== undefined) {
      records.push(
        new cloudflare.DnsRecord(
          `${name}-aaaa`,
          {
            zoneId: this.zoneId,
            name: args.hostname,
            type: 'AAAA',
            content: args.addressV6,
            proxied: false,
            ttl: args.ttl ?? this.defaultTtl
          },
          resourceOpts
        )
      );
    }
    return records;
  }
}
