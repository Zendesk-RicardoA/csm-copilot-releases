import test from 'node:test';
import assert from 'node:assert/strict';
import Native from '../mcp/approved-native-contract.js';
import {validateMeetingPrepBuildContract,performanceCoverage} from '../mcp/meeting-prep-build-contract.mjs';
import {prepareMeetingPrepDraftReview} from '../mcp/meeting-prep-draft-review.mjs';
import {inventedMeetingPrepDraft,INVENTED_MASTER_INVENTORY,omitInventedLibrary,addInventedSupportingModule} from './fixtures/meeting-prep-draft-input.mjs';

const record={tester_id:'invented-owner',case_id:'invented-case',revision:1,account_ref_digest:'a'.repeat(64),account_intelligence_core:{account_ref_digest:'a'.repeat(64),content_digest:'b'.repeat(64)},derived_evidence:{digest:'c'.repeat(64)},recommendation_review_package:{revision:1,recommendation_refs:[1,2,3,4].map(n=>'recommendation:'+n)},approvals:['identity','evidence','recommendations'].map(gate=>({gate,revision:1})),status:'in_review'};
function draft(){
  const input=inventedMeetingPrepDraft(record);for(const n of [1,2,3,4])omitInventedLibrary(input,n);
  input.selectionPlan={contract:'narrative-selection-v1',metrics:{}};
  return input;
}
function decision(input,role,why='Explain the response gap that phase 1 will address.'){
  input.selectionPlan.metrics[role]={rationale:why,provenance:{evidenceIds:input.customerContent.recommendations[0].provenance.evidenceIds.slice(),meaningRefIds:['recommendation:1']}};
}
function metric(input,{id='resolution_time',label='Median resolution time',valueType='duration',unit='hours',values=[24,20,18,16,14,12]}={}){
  input.metricSlidePlan.volume_trend={include:true,reason:'available_relevant'};decision(input,'volume_trend');
  input.projection.runtimeTrendData={primary:{metric:id,unit,metricDefinition:{contract:'MetricTrendV1',id,label,valueType,unit,aggregation:valueType==='duration'?'median':valueType==='percentage'?'share':'sum'},periods:['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06'],values,insights:['A shorter wait lets customers get back to their work.']}};
  input.projection.volumeMetricLabel=label;
  if(valueType==='percentage')input.projection.runtimeTrendData.primary.metricDefinition.valueScale='percent';
  input.projection.templateFields.volume_trend={volume_trend_title:label,volume_trend_subtitle:'January to June 2026'};
  return input;
}

test('template selection follows the slide purpose instead of the phase number',()=>{
  assert.equal(Native.supportingTemplateForPurpose('metric_evidence'),11);
  assert.equal(Native.supportingTemplateForPurpose('knowledge_plan'),17);
  assert.equal(Native.supportingTemplateForPurpose('workflow_plan'),14);
  assert.equal(Native.supportingTemplateForPurpose('investigation'),8);
  assert.equal(Native.supportingTemplateForPurpose('reporting_baseline'),12);
  assert.equal(Native.supportingTemplateForPurpose('knowledge_plan',[11,16,17]),17);
  assert.equal(Native.supportingTemplateForPurpose('unknown'),null);
});
test('different supporting jobs cannot be sent through the same metric-card layout',()=>{
  const input=draft(),first=addInventedSupportingModule(input,1,11),third=addInventedSupportingModule(input,3,16);
  first.narrativeKind='metric_evidence';third.narrativeKind='knowledge_plan';
  assert.throws(()=>validateMeetingPrepBuildContract(input),{code:'SUPPORTING_TEMPLATE_PURPOSE_MISMATCH'});
  third.templateNumber=17;third.fields={native_text_title:'The first knowledge scope',native_text_body:'Choose common questions and assign an owner for each answer.'};third.titleField='native_text_title';
  assert.doesNotThrow(()=>validateMeetingPrepBuildContract(input));
});
test('an included metric needs a grounded narrative reason, even when the numbers exist',()=>{
  const input=metric(draft());delete input.selectionPlan.metrics.volume_trend;
  assert.throws(()=>validateMeetingPrepBuildContract(input),{code:'METRIC_NARRATIVE_REQUIRED'});
  decision(input,'volume_trend');assert.doesNotThrow(()=>validateMeetingPrepBuildContract(input));
  input.selectionPlan.metrics.volume_trend.provenance.meaningRefIds=['recommendation:99'];
  assert.throws(()=>validateMeetingPrepBuildContract(input),{code:'METRIC_NARRATIVE_REQUIRED'});
});
test('old phase-position flags cannot silently insert the twin evidence layouts',()=>{
  const input=draft();input.metricSlidePlan['supporting_metric:phase_1']={include:true,reason:'available_relevant'};
  decision(input,'supporting_metric:phase_1');
  assert.throws(()=>validateMeetingPrepBuildContract(input),{code:'AUTOMATIC_SUPPORTING_LAYOUT_REMOVED'});
});
test('irrelevant available metrics can be omitted without adding a substitute chart',()=>{
  const input=draft();input.metricSlidePlan.volume_trend={include:false,reason:'not_relevant'};input.metricExclusions={volume_trend:'Demand is stable and does not explain the knowledge recommendation.'};
  assert.doesNotThrow(()=>validateMeetingPrepBuildContract(input));
  assert.equal(input.metricSlidePlan.volume_trend.include,false);
});
test('the primary trend accepts grounded duration, percentage and non-ticket count metrics',()=>{
  for(const params of [undefined,{id:'zero_touch',label:'Self-service resolution rate',valueType:'percentage',unit:'percent',values:[20,22,25,null,28,30]},{id:'knowledge_views',label:'Knowledge views',valueType:'count',unit:'views',values:[100,140,null,160,190,200]}]){
    const input=metric(draft(),params),before=structuredClone(input);assert.doesNotThrow(()=>validateMeetingPrepBuildContract(input));assert.deepEqual(input,before);
  }
});
test('a non-ticket monthly source is available for the primary chart rather than hidden by ticket-only coverage',()=>{
  for(const unit of ['hours','percent','views']){
    const coverage=performanceCoverage({sections:{support_operations:{facts:{metric_table:[{unit,evidence_state:'measured',completed_month_trend:[{period:'2026-01',value:1},{period:'2026-02',value:2}]}]}}}});
    assert.equal(coverage.volume_trend,true);
  }
});
test('metric identity, labels, units, ranges and actual prior-year comparisons stay protected',()=>{
  for(const [mutate,code] of [
    [i=>{i.projection.runtimeTrendData.primary.unit='tickets';},'INVALID_TREND_UNIT'],
    [i=>{i.projection.runtimeTrendData.primary.metric='created';},'INVALID_METRIC_NAME'],
    [i=>{i.projection.volumeMetricLabel='Created tickets';},'INVALID_METRIC_LABEL'],
    [i=>{i.projection.runtimeTrendData.primary.periods[2]='2026-05';},'INVALID_TREND_PERIODS'],
    [i=>{i.projection.runtimeTrendData.primary.values[0]=-1;},'INVALID_TREND_VALUE'],
    [i=>{i.projection.runtimeTrendData.primary.summaryChange='Year-over-year improvement';},'MISSING_PRIOR_YEAR_EVIDENCE'],
  ]){const input=metric(draft());mutate(input);assert.throws(()=>validateMeetingPrepBuildContract(input),{code});}
  const percent=metric(draft(),{id:'zero_touch',label:'Self-service resolution rate',valueType:'percentage',unit:'percent',values:[120,22,25,27,28,30]});
  assert.throws(()=>validateMeetingPrepBuildContract(percent),{code:'INVALID_TREND_VALUE'});
});
test('a changed narrative or template choice invalidates the old content and selection approvals',()=>{
  const input=draft(),reviewed=prepareMeetingPrepDraftReview(record,input,INVENTED_MASTER_INVENTORY,record.tester_id);
  const approved={...reviewed,approvals:[...reviewed.approvals,...['customer_content','maintained_slides'].map(gate=>({gate,revision:1}))],private_draft_authorization:{revision:1}};
  const changed=structuredClone(input);changed.selectionPlan.metrics={volume_trend:{rationale:'A different narrative decision.',provenance:{evidenceIds:input.customerContent.recommendations[0].provenance.evidenceIds,meaningRefIds:['recommendation:1']}}};
  const updated=prepareMeetingPrepDraftReview(approved,changed,INVENTED_MASTER_INVENTORY,record.tester_id);
  assert.equal(updated.revision,2);assert.deepEqual(updated.approvals.map(a=>a.gate),['identity','evidence','recommendations']);assert.equal(updated.private_draft_authorization,undefined);
});
