#!/usr/bin/env node
// The package is consumed from source, and the commands import the API's contracts.config.ts and through it the
// Worker's TypeScript, so everything runs with tsx registered.
import { register } from 'tsx/esm/api';

register();
await import('../src/contracts/cli.ts');
