import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareMeetingPrepDraftReview,requireFrozenMeetingPrepDraft} from '../mcp/meeting-prep-draft-review.mjs';
import {INVENTED_MASTER_INVENTORY} from './fixtures/meeting-prep-draft-input.mjs';
import {optionalMetricRecord as record,optionalMetricInput,missingMetricFields} from './fixtures/optional-metric-review.mjs';

for(const role of ['baseline','peer_comparison','measurement_plan']) {
  test(`an unavailable complete ${role} metric is omitted without blocking exact content review`,()=>{
    const input=optionalMetricInput(role),before=structuredClone(input);
    const reviewed=prepareMeetingPrepDraftReview(record,input,INVENTED_MASTER_INVENTORY,'invented-owner');
    assert.equal(reviewed.revision,1);assert.ok(reviewed.draft_review.slide_order.includes(role));
    assert.deepEqual(input,before);assert.deepEqual(reviewed.approvals,record.approvals);
    assert.equal(reviewed.private_draft_authorization,undefined);assert.equal(reviewed.artifact,undefined);
    requireFrozenMeetingPrepDraft(reviewed,input);
    const changed=structuredClone(input);changed.projection.templateFields[role][missingMetricFields[role][1]]='0%';
    assert.throws(()=>requireFrozenMeetingPrepDraft(reviewed,changed),{code:'APPROVED_DRAFT_CHANGED'});
  });
  test(`a partial ${role} omission cannot leave a sample label or value on the slide`,()=>{
    const input=optionalMetricInput(role);input.projection.templateFields[role][missingMetricFields[role][0]]='CSAT';
    assert.throws(()=>prepareMeetingPrepDraftReview(record,input,INVENTED_MASTER_INVENTORY,'invented-owner'),{code:'PARTIAL_METRIC_REMOVAL'});
  });
}
test('undefined optional input and missing required copy are not interpreted as an approved omission',()=>{
  for(const mutate of [input=>{delete input.projection.templateFields.baseline.baseline_metric_3_value;},input=>{input.projection.templateFields.baseline.baseline_title=null;}]) {
    const input=optionalMetricInput('baseline');mutate(input);
    assert.throws(()=>prepareMeetingPrepDraftReview(record,input,INVENTED_MASTER_INVENTORY,'invented-owner'),{code:'DRAFT_PROJECTION_INCOMPLETE'});
  }
});
