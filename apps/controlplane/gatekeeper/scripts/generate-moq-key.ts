// Prints a MOQ_SIGNING_KEYS secret containing one new ES256 key. For a rotation, add the printed key to the existing
// set's `keys`, deploy, and only then switch `active_kid` to it.
import { exportJWK, generateKeyPair } from 'jose';
import { MOQ_SIGNING_ALGORITHM, type MoqSigningKeys, MoqSigningKeysSchema } from '../src/moq/keys.ts';

const kid = process.argv[2] ?? `controlplane-moq-${new Date().toISOString().slice(0, 10)}`;
const { privateKey } = await generateKeyPair(MOQ_SIGNING_ALGORITHM, { extractable: true });
const jwk = await exportJWK(privateKey);
const set: MoqSigningKeys = MoqSigningKeysSchema.parse({
  active_kid: kid,
  keys: [{ kty: jwk.kty, crv: jwk.crv, alg: MOQ_SIGNING_ALGORITHM, use: 'sig', kid, x: jwk.x, y: jwk.y, d: jwk.d }]
});
console.log(JSON.stringify(set));
