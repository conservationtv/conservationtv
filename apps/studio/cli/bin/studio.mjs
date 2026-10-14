#!/usr/bin/env node
// The CLI and the SDK it calls are consumed from source, so the command runs its TypeScript through tsx.
import { register } from 'tsx/esm/api';

register();
await import('../src/index.ts');
