import type * as pulumi from '@pulumi/pulumi';

export interface AddressRecordArgs {
  hostname: string;
  address: pulumi.Input<string>;
  addressV6?: pulumi.Input<string>;
  ttl?: number;
}

export interface DnsRegistrar {
  createAddressRecords(name: string, args: AddressRecordArgs, opts?: pulumi.CustomResourceOptions): pulumi.Resource[];
}
