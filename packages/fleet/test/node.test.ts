import { describe, expect, it } from 'vitest';
import { validateNodes } from '../src/core/node';

describe('node topology validation', () => {
  it('rejects duplicate ids and hostnames', () => {
    expect(() => validateNodes([{ id: 'one' }, { id: 'one' }])).toThrow(/Duplicate node id/);
    expect(() => validateNodes([{ id: 'one' }, { id: 'two' }], ['same.example.test', 'same.example.test'])).toThrow(
      /Duplicate resolved hostname/
    );
  });

  it('rejects empty workloads and invalid DNS-label ids', () => {
    expect(() => validateNodes([])).toThrow(/at least one/);
    expect(() => validateNodes([{ id: 'Not Valid' }])).toThrow(/DNS label/);
  });
});
