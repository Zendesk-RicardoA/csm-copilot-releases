import { REQUIRED_FIELDS } from '../../mcp/approved-recovery-design.mjs';
import { inventedMeetingPrepDraft } from './meeting-prep-draft-input.mjs';

// Fixed invented inputs, not customer exports or production-derived expectations.
export const optionalMetricRecord = {
  tester_id:'invented-owner',case_id:'invented-optional-metrics',revision:1,account_ref_digest:'a'.repeat(64),
  account_intelligence_core:{content_digest:'b'.repeat(64),account_ref_digest:'a'.repeat(64)},
  derived_evidence:{digest:'c'.repeat(64)},status:'in_review',
  approvals:['identity','evidence','recommendations'].map(gate=>({gate,revision:1})),
  recommendation_review_package:{revision:1,recommendation_refs:[1,2,3,4].map(n=>'recommendation:'+n)},
};
export const missingMetricFields={
  baseline:['baseline_metric_3_label','baseline_metric_3_value'],
  peer_comparison:['peer_metric_3','peer_current_3','peer_average_3','peer_top_performer_3','peer_delta_3'],
  measurement_plan:['measurement_metric_3','measurement_baseline_3','measurement_target_3','measurement_cadence_3'],
};
export function optionalMetricInput(role) {
  const input=inventedMeetingPrepDraft(optionalMetricRecord);
  input.metricSlidePlan[role]={include:true,reason:'available_relevant'};
  const fields=input.projection.templateFields[role]=Object.fromEntries(REQUIRED_FIELDS[role].map(field=>[field,
    /^baseline_bar_/.test(field) ? .5 : 'Invented '+field.replaceAll('_',' ')]));
  if(role==='baseline') {
    fields.baseline_metric_1_value='120';fields.baseline_metric_2_value='12';fields.baseline_metric_4_value='4%';
    input.projection.baselineTrend={title:'Monthly solved tickets',footnote:'Invented measured monthly totals.',periods:[4,5,6,7,8,9].map(month=>({periodKey:`2026-${String(month).padStart(2,'0')}`,label:`Month ${month}`,value:120,display:'120',fraction:.5}))};
  }
  if(role==='measurement_plan') {
    input.customerContent.successMeasures=[{measureId:'measure:reply',name:'First reply time'}];
    for(const phase of input.customerContent.phases)phase.measureRefIds=['measure:reply'];
    fields.measurement_metric_1='First reply time';fields.measurement_baseline_1='4 hours';
    fields.measurement_target_1='Review a proposed target';fields.measurement_cadence_1='Monthly';
  }
  for(const field of missingMetricFields[role])fields[field]=null;
  return input;
}
