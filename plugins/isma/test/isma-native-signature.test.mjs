import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCapabilityReadiness } from '../mcp/core.mjs';
import { buildSetupWizardStatus } from '../mcp/setup-wizard.mjs';

test('a saved Gmail signature needs no separate local profile before an outreach draft', () => {
  const result = evaluateCapabilityReadiness({
    credentialState: { mode: 'limited_beta', identity: { state: 'connected', provider: 'snowflake_zdp_sso', subject: 'invented-owner', verified: true },
      snowflake: { state: 'connected', read_only_verified: true } },
    packageResult: { package_version: '0.0.0-test', renderer_baseline: 'recovery-v3' },
    workflow: 'outreach', signatureStatus: { state: 'not_configured' },
  });
  assert.equal(result.capabilities.gmail_draft, 'ready');
  assert.equal(result.signature_handling.mode, 'gmail_native');
  assert.equal(result.signature_handling.local_profile_required, false);
});

test('the setup wizard never requires signature capture or a signature test draft', () => {
  const result = buildSetupWizardStatus({ core: { status: 'ready', next_action: null },
    signature: { state: 'not_configured' }, salesforce: { state: 'skipped' },
    presenter: { status: 'ready', next_action: null }, renderer: { state: 'ready', next_action: null },
    sharedSources: { state: 'automatic_check_pending' } });
  assert.equal(result.status, 'ready');
  assert.equal(result.steps.gmail_signature, undefined);
  assert.equal(result.signature_handling.mode, 'gmail_native');
  assert.match(result.signature_handling.instruction, /Insert signature/);
});
