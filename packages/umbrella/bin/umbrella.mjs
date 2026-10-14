#!/usr/bin/env node
// The package is consumed from source inside this workspace, so the command runs its TypeScript through tsx.
import { register } from 'tsx/esm/api';

register();
await import('../src/cli.ts');
