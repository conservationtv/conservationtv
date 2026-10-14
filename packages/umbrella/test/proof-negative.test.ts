import { describe, expect, it } from 'vitest';
import {
  assertHolds,
  assignmentsHidden,
  expiredGrantInert,
  grantsUnforgeable,
  insertConfined,
  misplacedGrantInert,
  noGrantsNoRows,
  noPrincipalNoRows,
  organisationGrantConfined,
  projectGrantConfined,
  revocationComplete,
  rowsStayInScope,
  staleGrantCannotRecreate,
  type Guarantee
} from './support/guarantees.js';
import { useHarness } from './support/harness.js';
import {
  assignmentsUnprotected,
  expiryCleared,
  grantsMovedToApollo,
  immutableTriggerDropped,
  keyFunctionReturnsAll,
  nonCanonicalScopeId,
  permissiveInsertPolicy,
  permissiveProjectInsertPolicy,
  permissiveReadPolicy,
  projectReparented,
  strayGlobalViewer,
  strayZeusEditor,
  tasksUnprotected,
  type Sabotage
} from './support/sabotage.js';

/** A sabotage and the guarantee it must break. */
interface Proof {
  readonly guarantee: Guarantee;
  readonly sabotage: Sabotage;
}
const proofs: Proof[] = [
  { guarantee: noGrantsNoRows, sabotage: strayGlobalViewer },
  { guarantee: noGrantsNoRows, sabotage: permissiveReadPolicy },
  { guarantee: noGrantsNoRows, sabotage: tasksUnprotected },
  { guarantee: projectGrantConfined, sabotage: strayGlobalViewer },
  { guarantee: projectGrantConfined, sabotage: keyFunctionReturnsAll },
  { guarantee: organisationGrantConfined, sabotage: projectReparented },
  { guarantee: misplacedGrantInert, sabotage: grantsMovedToApollo },
  { guarantee: expiredGrantInert, sabotage: expiryCleared },
  { guarantee: insertConfined, sabotage: permissiveInsertPolicy },
  { guarantee: insertConfined, sabotage: strayZeusEditor },
  { guarantee: rowsStayInScope, sabotage: immutableTriggerDropped },
  { guarantee: staleGrantCannotRecreate, sabotage: permissiveProjectInsertPolicy },
  { guarantee: revocationComplete, sabotage: nonCanonicalScopeId },
  { guarantee: assignmentsHidden, sabotage: assignmentsUnprotected },
  { guarantee: grantsUnforgeable, sabotage: assignmentsUnprotected },
  { guarantee: noPrincipalNoRows, sabotage: permissiveReadPolicy },
  { guarantee: noPrincipalNoRows, sabotage: tasksUnprotected }
];

/** Expects an assertion inside the guarantee to fail, rather than some unrelated error. */
async function expectViolation(check: Promise<void>): Promise<void> {
  const error = await check.then(
    () => undefined,
    (cause: unknown) => cause
  );
  expect(error, 'the guarantee still held on the damaged database').toBeInstanceOf(Error);
  expect(error instanceof Error ? error.name : undefined).toBe('AssertionError');
}

describe.each(proofs)('$guarantee.name, when $sabotage.name', ({ guarantee, sabotage }) => {
  const harness = useHarness();

  it('holds on a healthy database', async () => {
    await assertHolds(guarantee, harness());
  });

  it('fails once the database is damaged', async () => {
    const h = harness();
    await guarantee.given(h);
    await sabotage.apply(h);
    await expectViolation(guarantee.verify(h));
  });
});
