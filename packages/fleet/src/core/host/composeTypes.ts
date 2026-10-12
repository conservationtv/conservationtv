import type * as pulumi from '@pulumi/pulumi';
import type { ServiceEndpointDefinition } from '../endpoints';
import type { RemoteFileSpec } from './remote';

export interface DeployStep {
  name: string;
  script: pulumi.Input<string>;
  triggers: pulumi.Input<unknown>[];
  dependsOnSteps?: string[];
}

export interface SystemdUnitSpec {
  path: string;
  content: pulumi.Input<string>;
  permissions?: string;
}

export interface ComposeServiceDefinition {
  readonly [property: string]: ComposeField;
}

export type ComposeField =
  | string
  | number
  | boolean
  | null
  | pulumi.Input<string>
  | ComposeServiceDefinition
  | ComposeField[];

export type ComposeRecord = Record<string, ComposeServiceDefinition>;

export interface ComposeApp {
  name: string;
  dir: string;
  services: ComposeRecord;
  volumes?: ComposeRecord;
  files: RemoteFileSpec[];
  systemdUnits?: SystemdUnitSpec[];
  deploySteps: DeployStep[];
  endpoints?: Record<string, ServiceEndpointDefinition>;
  healthUrl?: string;
}
