import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePackagePreflight } from '../mcp/core.mjs';

const manifest = { package_name: 'isma', package_version: '0.3.0-invented', status: 'approved_for_invented_testing',
  expiration_policy: 'none', expires_at: null,
  constraints: { real_customer_data: false, external_reads: false, external_writes: false, generated_artifacts: false },
  integrity: { files: {} } };
test('ISMA has no package time limit only when its explicit approved policy says none', () => {
  const result = validatePackagePreflight({ manifest, packageRoot: '.', expectedPackageName: 'isma', expectedPackageVersion: manifest.package_version, now: new Date('2099-01-01') });
  assert.equal(result.expires_at, null); assert.equal(result.expiration_policy, 'none');
  for (const change of [{ package_name: 'legacy' }, { expiration_policy: undefined }, { expiration_policy: 'dated' }, { expires_at: 'invalid' }]) {
    assert.throws(() => validatePackagePreflight({ manifest: { ...manifest, ...change }, packageRoot: '.' }), /expired/);
  }
  assert.throws(() => validatePackagePreflight({ manifest: { ...manifest, status: 'revoked' }, packageRoot: '.' }), /not approved/);
  assert.throws(() => validatePackagePreflight({ manifest: { ...manifest, constraints: { ...manifest.constraints, external_reads: true } }, packageRoot: '.' }), /boundary/);
});
