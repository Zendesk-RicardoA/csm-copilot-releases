import Native from './approved-native-contract.js';
import crypto from 'node:crypto';
import { BetaError } from './core.mjs';
import { REQUIRED_FIELDS } from './approved-recovery-design.mjs';
import { assertRendererCompatibility } from './release-compatibility.mjs';

export function validateMeetingPrepMasterPreflight(inventory) {
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)
    || inventory.slide_count !== 23 || typeof inventory.provider_revision !== 'string' || !inventory.provider_revision.trim()
    || !inventory.native_fields || typeof inventory.native_fields !== 'object'
    || !inventory.supporting_templates || typeof inventory.supporting_templates !== 'object') {
    throw new BetaError('MEETING_PREP_MASTER_INVENTORY_INVALID', 'Read the current approved v3 master inventory before slide-wording review.');
  }
  const hasIdentifier = (value) => value && typeof value === 'object' && Object.entries(value).some(([key, child]) =>
    /(?:_id$|^(?:id|objectId|presentationId|slideId|fileId|sourceId|url)$)/i.test(key) || hasIdentifier(child));
  if (hasIdentifier(inventory)) throw new BetaError('MEETING_PREP_MASTER_INVENTORY_INVALID', 'The master preflight must not include deck, slide, file or source identifiers.');
  if (!inventory.renderer_components || typeof inventory.renderer_components !== 'object') {
    throw new BetaError('MEETING_PREP_MASTER_RECEIPT_REQUIRED', 'Opening the sidebar does not verify the current renderer. Capture its exact component receipt.');
  }
  assertRendererCompatibility('meeting_prep', inventory.renderer_components);
  return {
    state: 'renderer_verified',
    inventory_digest: crypto.createHash('sha256').update(Native.canonicalSourceJson(inventory)).digest('hex'),
    renderer_components: { ...inventory.renderer_components },
    slide_count: inventory.slide_count,
    provider_revision: inventory.provider_revision,
  };
}

const messages = {
  MISSING_SEMANTIC_VALUE: 'Complete the exact native slide field before requesting wording approval.',
  INVALID_LINK: 'Use a resource label and valid HTTPS link before requesting wording approval.',
  INVALID_TREND_VALUE: 'Use a normalized 0–1 bar fraction, keeping missing periods distinct from measured zero.',
  INVALID_SERIES_VALUE: 'Supply measured monthly data or a structured native series, never a text substitute.',
  CONTENT_FIT_RISK: 'The wording exceeds the approved native field. Shorten that wording without dropping meaning, then review it.',
};
export function validateNativeField(role, field, value) {
  const code = Native.valueIssue(role, field, value);
  if (code) throw new BetaError(code, messages[code], { role, field, max_characters: Native.maxCharacters(role, field) });
}
function requireGeometry(geometry,details) {
  if (!geometry || ['widthPt','heightPt','fontSizePt'].some(key=>typeof geometry[key]!=='number' || !Number.isFinite(geometry[key]) || geometry[key]<=0)) {
    throw new BetaError('NATIVE_FIELD_INVENTORY_REQUIRED','Capture this field from the current approved master before wording approval; a character limit alone does not verify fit.',details);
  }
  return geometry;
}
function requireInvestigationArea(role,field,geometry,details) {
  if(role!=='investigation_focus' || field!=='investigation_focus') return geometry;
  if(Native.investigationAreaIssue(geometry?.investigationArea,geometry) || geometry.textInsetPt!==geometry.investigationArea.textInsetPt) {
    throw new BetaError('INVESTIGATION_LAYOUT_REVIEW_REQUIRED','Capture the focus area inside the current template card before reviewing its wording; the oversized source frame is not its usable space.',details);
  }
  return geometry;
}
export function nativeBuildRequirements() {
  return { contract: Native.version, required_renderer_contract: Native.phaseStoryContract, output_name_required: true,
    peer_takeaway_layout_contract: Native.peerTakeawayLayoutContract,
    investigation_layout_contract: Native.investigationLayoutContract,
    narrative_selection_contract: Native.narrativeSelectionContract, metric_trend_contract:Native.metricTrendContract,
    supporting_narrative_choices:Native.narrativeTemplates,
    metric_policy:'Include a metric only with current evidence references and a reason linked to the reviewed recommendation; availability alone is not a reason.',
    selected_primary_trend:{runtime_key:'primary',native_role:'volume_trend',contract:Native.metricTrendContract,value_types:['count','duration','percentage'],monthly_capacity:{minimum:2,maximum:12},percentage_values:'Declare percent or fraction explicitly; never infer scale from the values.'},
    agenda_summary_required: true, existing_footer_policy: 'renumber_in_final_order_without_adding_or_rewriting_customer_copy',
    unavailable_metric_fields: 'explicit_null_removes_the_field_and_captured_companions',
    supporting_templates: Object.fromEntries(Object.entries(Native.supportingTemplates).map(([number,template])=>[number,{
      ...template,fields:template.nativeText?null:REQUIRED_FIELDS[template.role],title_field:Native.titleField(template.role),
      native_field_inventory_required:true, field_purposes:Native.fieldPurposes(template.role),
    }])),
    fields: Object.fromEntries(Object.entries(REQUIRED_FIELDS).map(([role,fields])=>[role,Object.fromEntries(fields.map(field=>[field,{
      type:Native.renderer(field),max_characters:Native.maxCharacters(role,field),
    }]))])),
    source_fingerprint: { contract:"native-source-sha256-v1", algorithm:"SHA-256 of UTF-8 canonical JSON",
      sorted_object_keys:true,ordered_arrays:true,omitted_object_values:["null","undefined"],ignored_keys:["objectId","contentUrl","thumbnailUrl","sourceUrl"] },
    creates_artifact:false,reads_customer_sources:false };
}
export function validateNativePreflight(input, order, masterInventory = {}) {
  if (typeof input.output?.name !== 'string' || !input.output.name.trim()) throw new BetaError('MISSING_OUTPUT', 'Name the private draft before requesting wording approval.');
  for (const item of order) {
    const [role, variant] = item.split(':');
    if (!REQUIRED_FIELDS[role]) continue;
    const phase = variant && input.customerContent.phases.find(p => p.order === Number(variant.slice(6)));
    const fields = variant ? input.projection.phaseTemplateFields?.[phase?.order]?.[role] : input.projection.templateFields?.[role];
    if(Native.optionalMetricOmissionIssue(role,fields,REQUIRED_FIELDS[role]))throw new BetaError('PARTIAL_METRIC_REMOVAL','Omit the entire unavailable metric card or row before wording approval.',{role});
    for (const field of REQUIRED_FIELDS[role]) {
      if (Native.renderer(field) === 'series' && input.projection.runtimeTrendData) continue; // build contract verifies the measured source; native hydration verifies geometry.
      const bar = /^baseline_bar_([1-6])$/.exec(field);
      if (bar && input.projection.baselineTrend?.periods?.[Number(bar[1])-1]?.missing) continue;
      const value = role === 'cover' ? field === 'cover_title' ? Native.coverTitle(input.projection.customerDisplayName) : input.projection.presentationPeriod
        : role === 'phase_detail' && field === 'phase_title' ? phase.title
        : role === 'phase_detail' && field === 'phase_objective' ? phase.objective : fields?.[field];
      validateNativeField(role, field, value);
      const text = typeof value === 'string' ? value : Native.renderer(field)==='link' ? value?.text : null;
      let geometry=text ? requireGeometry(masterInventory.native_fields?.[item]?.[field],{role,field}) : null;
      if(text) geometry=requireInvestigationArea(role,field,geometry,{role,field});
      if (role==='peer_comparison' && field==='peer_insight_1' && geometry) {
        try { geometry=Native.peerTakeawayGeometry(fields,geometry); }
        catch (error) { throw new BetaError(error.code,error.message,{role,field}); }
      }
      if (text && Native.textFitIssue(text,geometry)) {
        throw new BetaError('CONTENT_FIT_RISK', 'Shorten this exact field before approval; the native renderer will not rewrite it.', {role, field});
      }
    }
  }
  for (const decision of Object.values(input.phaseSlidePlan || {})) for (const module of decision.generatedModules || []) {
    const template = Native.supportingTemplate(module.templateNumber);
    if (!template) throw new BetaError('SUPPORTING_TEMPLATE_NOT_APPROVED','Supporting slides may use only numbered templates 8, 11, 12, 14, 16 and 17 in the approved v3 master.');
    const captured = masterInventory.supporting_templates?.[module.templateNumber];
    const schema = template.nativeText ? input.supportingTemplateInventory?.[module.templateNumber] : captured;
    if (!schema) throw new BetaError('SUPPORTING_TEMPLATE_INVENTORY_REQUIRED','Read this supporting template from the approved master before reviewing its content.',{template_number:module.templateNumber});
    if (template.nativeText && Native.canonicalSourceJson(schema) !== Native.canonicalSourceJson(captured)) {
      throw new BetaError('SUPPORTING_TEMPLATE_INVENTORY_REQUIRED','Read the exact editable fields from the approved master before reviewing custom content for this supporting template.');
    }
    for (const field of template.nativeText ? Object.keys(schema.fields) : REQUIRED_FIELDS[template.role]) {
      validateNativeField(template.role, field, module.fields?.[field]);
      const geometry=requireInvestigationArea(template.role,field,requireGeometry(schema?.fields?.[field]?.fit,{template_number:module.templateNumber,field}),{template_number:module.templateNumber,field});
      if (Native.textFitIssue(module.fields?.[field], geometry)) throw new BetaError('CONTENT_FIT_RISK', 'This supporting-slide text does not fit the captured master field. Use its reviewed layout purposes, then re-review the copy; the renderer cannot relocate or shorten it.', {template_number:module.templateNumber,field});
      const limit = schema?.fields?.[field]?.max_characters;
      if (template.nativeText && (!Number.isInteger(limit) || limit < 1 || module.fields[field].length > limit)) {
        throw new BetaError('CONTENT_FIT_RISK','Shorten this supporting-template field to its captured native text capacity before approval.',{template_number:module.templateNumber,field,max_characters:limit});
      }
    }
  }
  if (input.metricSlidePlan?.speed_quality_trend?.include && input.projection.runtimeTrendData) {
    const series=[input.projection.runtimeTrendData.frt,input.projection.runtimeTrendData.csat].filter(Boolean);
    const labels=input.projection.templateFields.speed_quality_trend || {};
    if (/\b(peer|benchmark|versus|vs\.?)\b/i.test(`${labels.speed_quality_trend_title} ${labels.speed_quality_trend_subtitle}`)
      && !series.some(s=>typeof s.average==="number" && Number.isFinite(s.average) || typeof s.topPerformer==="number" && Number.isFinite(s.topPerformer))) {
      throw new BetaError("UNSUPPORTED_COMPARISON_LABEL","This chart contains only the account series. Review a trend title or supply the verified comparison; do not label it a peer comparison.");
    }
  }
  return { contract: Native.version, source_fingerprint_contract: 'native-source-sha256-v1' };
}
