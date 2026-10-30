import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSetupWizardStatus } from '../mcp/setup-wizard.mjs';

test('the wizard displays a complete dependency checklist instead of treating installed software as connected', () => {
  const result = buildSetupWizardStatus({ core: { status: 'ready', next_action: null },
    salesforce: { state: 'skipped' }, presenter: { status: 'ready' }, renderer: { state: 'ready' },
    sharedSources: {}, dependencyChecklist: { workflow: 'outreach', rows: [
      { dependency: 'gmail', title: 'Gmail', state: 'sign_in_needed', required: true },
      { dependency: 'cerebro', title: 'Cerebro', state: 'optional', required: false },
    ] } });
  assert.equal(result.dependency_checklist.rows.length, 2);
  assert.equal(result.dependency_checklist.rows[0].state, 'sign_in_needed');
  assert.equal(result.dependency_checklist.rows[1].state, 'optional');
});
