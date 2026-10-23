import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOW_CATALOG, validateWorkflowRegistration } from '../mcp/workflow-catalog.mjs';
import { summarizeWorkflowReadiness } from '../mcp/workflow-readiness.mjs';
import { BOOK_OF_BUSINESS_READ_TIMEOUT_MS, BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS } from '../mcp/book-of-business-read-session.mjs';
import { CTA_QUEUE_READ_TIMEOUT_MS } from '../mcp/journey-a-cta-queue.mjs';
import Native from '../mcp/approved-native-contract.js';
import { checkRendererCompatibility } from '../mcp/release-compatibility.mjs';

const names = [...new Set(Object.values(WORKFLOW_CATALOG.workflows).flatMap(w => w.steps.flatMap(s => s.tools)))];
test('independent workflow catalogue requires exactly the five agreed workflows and source-specific deadlines', () => {
  assert.deepEqual(Object.keys(WORKFLOW_CATALOG.workflows), ['daily_focus', 'book_analysis', 'outreach', 'renewal_preparation', 'meeting_prep']);
  assert.equal(WORKFLOW_CATALOG.feature_freeze, true);
  assert.equal(CTA_QUEUE_READ_TIMEOUT_MS, 25000);
  assert.equal(BOOK_OF_BUSINESS_READ_TIMEOUT_MS, 120000);
  assert.equal(BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS, 300000);
  assert.equal(WORKFLOW_CATALOG.workflows.book_analysis.timeout_policy.first_attempt_ms, 120000);
});
test('fault injection: a missing selected transcript tool is detected before meeting prep; book analysis remains available', () => {
  const availableTools = names.filter(name => name !== 'beta_bind_converge_call_evidence');
  assert.deepEqual(validateWorkflowRegistration(availableTools), [{ workflow: 'meeting_prep', step: 'selected_transcript', missing_tool: 'beta_bind_converge_call_evidence' }]);
  const common = { availableTools, setupStatus: 'ready', packageStatus: { state: 'matched' } };
  assert.equal(summarizeWorkflowReadiness({ ...common, workflow: 'meeting_prep' }).state, 'blocked');
  assert.equal(summarizeWorkflowReadiness({ ...common, workflow: 'portfolio_analytics' }).state, 'available_unverified');
});
test('fault injection: narrow-template overflow and an invalid chart update cannot pass the shared contract', () => {
  assert.equal(Native.valueIssue('supporting_metric', 'metric_1_value', 'very long invented interpretation instead of a metric'), 'CONTENT_FIT_RISK');
  assert.equal(Native.valueIssue('speed_quality_trend', 'frt_series', { updates: { point_1: { topPt: NaN } } }), 'INVALID_SERIES_VALUE');
});
test('fault injection: a missing or incompatible renderer blocks only its draft workflow, not book analysis',()=>{
  const expected={native_contract:'native-review-v3',renderer_baseline:'recovery-v3',master_contract_sha256:'a'.repeat(64),renderers:{meeting_prep:{implementation_sha256:'b'.repeat(64)}},approved_master_bindings:{meeting_prep:'c'.repeat(64)}};
  const matched={implementation_sha256:'b'.repeat(64),native_contract:'native-review-v3',renderer_baseline:'recovery-v3',master_contract_sha256:'a'.repeat(64),approved_master_binding_fingerprint:'c'.repeat(64)};
  assert.equal(checkRendererCompatibility('meeting_prep',matched,expected).state,'matched');
  for(const receipt of [null,{...matched,native_contract:'obsolete'},{...matched,approved_master_binding_fingerprint:'d'.repeat(64)}]) {
    const rendererCompatibility=checkRendererCompatibility('meeting_prep',receipt,expected);
    assert.equal(rendererCompatibility.state,'component_mismatch');
    const common={availableTools:names,setupStatus:'ready',packageStatus:{state:'matched'},rendererCompatibility};
    assert.equal(summarizeWorkflowReadiness({...common,workflow:'meeting_prep'}).state,'blocked');
    assert.equal(summarizeWorkflowReadiness({...common,workflow:'portfolio_analytics'}).state,'available_unverified');
  }
});
