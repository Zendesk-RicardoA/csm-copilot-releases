/* Portable contract shared by the packaged controls and bound native renderer.
 * No source identifiers, customer copy, network calls or platform dependencies. */
var CSMNativeContract = (function () {
  // These are numbered positions in the approved v3 master, not destination phases.
  var supportingTemplates = {
    8: { role: 'investigation_focus', variant: null },
    11: { role: 'supporting_metric', variant: 'phase_1' },
    12: { role: 'maintained_explore', variant: null, nativeText: true },
    14: { role: 'maintained_sla', variant: null, nativeText: true },
    16: { role: 'supporting_metric', variant: 'phase_3' },
    17: { role: 'maintained_knowledge', variant: null, nativeText: true }
  };
  var generatedRoles = ['investigation_focus', 'supporting_metric', 'maintained_explore', 'maintained_sla', 'maintained_knowledge'];
  var narrativeTemplates = { investigation:[8], metric_evidence:[11,16], reporting_baseline:[12], workflow_plan:[14], knowledge_plan:[17] };
  function supportingTemplateForPurpose(kind, preferred) {
    var choices=narrativeTemplates[kind];
    if (!choices) return null;
    return (preferred || []).concat(choices).filter(function (number) {return choices.indexOf(number)!==-1;})[0] || null;
  }
  function narrativeSelectionIssue(input) {
    var plan=input.selectionPlan, content=input.customerContent || {}, meanings=[], evidence=[];
    if (!plan || plan.contract!=='narrative-selection-v1' || !plan.metrics || typeof plan.metrics!=='object' || Array.isArray(plan.metrics)) return 'NARRATIVE_SELECTION_REQUIRED';
    (content.phases || []).concat(content.recommendations || [],content.successMeasures || []).forEach(function (item) {
      if(item.phaseRefId) meanings.push(item.phaseRefId); if(item.recommendationRefId) meanings.push(item.recommendationRefId);
      meanings=meanings.concat(item.provenance && item.provenance.meaningRefIds || []);
      evidence=evidence.concat(item.provenance && item.provenance.evidenceIds || []);
    });
    var roles=['baseline','volume_trend','speed_quality_trend','peer_comparison','measurement_plan','supporting_metric:phase_1','supporting_metric:phase_3'];
    if (['supporting_metric:phase_1','supporting_metric:phase_3'].some(function (role) {return input.metricSlidePlan && input.metricSlidePlan[role] && input.metricSlidePlan[role].include;})) return 'AUTOMATIC_SUPPORTING_LAYOUT_REMOVED';
    for (var role of Object.keys(plan.metrics)) {
      var decision=plan.metrics[role], refs=decision && decision.provenance;
      if (roles.indexOf(role)===-1 || !decision || typeof decision.rationale!=='string' || !decision.rationale.trim() || !refs ||
          !Array.isArray(refs.evidenceIds) || !refs.evidenceIds.length || refs.evidenceIds.some(function(ref){return evidence.indexOf(ref)===-1;}) ||
          !Array.isArray(refs.meaningRefIds) || !refs.meaningRefIds.length || refs.meaningRefIds.some(function(ref){return meanings.indexOf(ref)===-1;})) return 'METRIC_NARRATIVE_REQUIRED';
    }
    for (var metricRole of roles) if (input.metricSlidePlan && input.metricSlidePlan[metricRole] && input.metricSlidePlan[metricRole].include && !plan.metrics[metricRole]) return 'METRIC_NARRATIVE_REQUIRED';
    for (var phase of content.phases || []) {
      var phasePlan=input.phaseSlidePlan && input.phaseSlidePlan[phase.phaseRefId];
      for (var module of phasePlan && phasePlan.generatedModules || []) {
        if (!narrativeTemplates[module.narrativeKind]) return 'SUPPORTING_NARRATIVE_PURPOSE_REQUIRED';
        if (narrativeTemplates[module.narrativeKind].indexOf(module.templateNumber)===-1) return 'SUPPORTING_TEMPLATE_PURPOSE_MISMATCH';
      }
    }
    return null;
  }
  function metricDefinitionIssue(series) {
    var definition=series && series.metricDefinition;
    if (!definition || definition.contract!=='MetricTrendV1' || !/^[a-z][a-z0-9_]{1,80}$/.test(definition.id || '') ||
      typeof definition.label!=='string' || !definition.label.trim() || definition.label.length>100 ||
      ['count','duration','percentage'].indexOf(definition.valueType)===-1) return 'METRIC_DEFINITION_REQUIRED';
    if (series.unit!==definition.unit ||
      definition.valueType==='duration' && (definition.unit!=='hours' || ['median','mean'].indexOf(definition.aggregation)===-1) ||
      definition.valueType==='percentage' && (definition.unit!=='percent' || ['share','rate'].indexOf(definition.aggregation)===-1 || ['percent','fraction'].indexOf(definition.valueScale)===-1) ||
      definition.valueType==='count' && (!/^[a-z][a-z ]{1,29}$/.test(definition.unit || '') || ['hours','percent','fraction'].indexOf(definition.unit)!==-1 || definition.aggregation!=='sum')) return 'INVALID_TREND_UNIT';
    if (series.metric!==definition.id) return 'INVALID_METRIC_NAME';
    return null;
  }
  function normalizedTrendValues(series) {
    return series.values.map(function (value) {return value!==null && series.metricDefinition && series.metricDefinition.valueType==='percentage' && series.metricDefinition.valueScale==='fraction' ? value*100 : value;});
  }
  function renderer(field) {
    return /^baseline_bar_[1-6]$/.test(field) ? 'bar' : /_series$/.test(field) ? 'series' : /^summary_phase_[1-4]_resource$/.test(field) ? 'link' : 'text';
  }
  function maxCharacters(role, field) {
    if (role === 'investigation_focus') return field === 'investigation_scope' ? 180 : field === 'investigation_body' ? 80 : field === 'investigation_focus' ? 72 : 60;
    if (role === 'supporting_metric') return /^metric_[1-3]_value$/.test(field) ? 12 : /^metric_[1-3]_label$/.test(field) ? 38 : /^support_insight_/.test(field) ? 90 : 70;
    if (role === 'phase_detail') return field === 'phase_title' ? 60 : field === 'phase_number' ? 12 : 180;
    if (role === 'measurement_plan') return /^measurement_metric_[1-3]$/.test(field) ? 52 : /^measurement_(baseline|cadence)_[1-3]$/.test(field) ? 38 : 100;
    if (role === 'next_steps') return /^next_action_[1-4]_owner$/.test(field) ? 28 : 100;
    if (role !== 'closing_summary') return null;
    if (field === 'closing_summary_title') return 30;
    if (field === 'shared_direction_label') return 20;
    if (field === 'shared_direction') return 84;
    if (/^summary_phase_[1-4]_number$/.test(field)) return 1;
    if (/^summary_phase_[1-4]_title$/.test(field)) return 40;
    if (/^summary_phase_[1-4]_outcome$/.test(field)) return 46;
    if (/^summary_phase_[1-4]_resource$/.test(field)) return 24;
    if (/^summary_phase_[1-4]_timeframe$/.test(field)) return 28;
    return null;
  }
  // Deterministic risk estimate, not native rendering or human acceptance.
  // Native fields can be only one glyph high (for example a phase marker).
  // Do not invent padding or charge a second baseline to their first line.
  // Explicit breaks, word wrapping and captured paragraph spacing still count.
  function textHeightPt(text, geometry) {
    if (!geometry || !geometry.widthPt || !geometry.fontSizePt) return null;
    if (!String(text).length) return 0;
    var inset = typeof geometry.textInsetPt === 'number' ? geometry.textInsetPt : 0;
    var font = geometry.fontSizePt, width = geometry.widthPt - inset * 2, lines = 0;
    if (!(width > 0) || inset < 0) return Infinity;
    function advance(character) {
      var fraction = /\s/.test(character) ? 0.28 : /[ilI.,'!:;|]/.test(character) ? 0.27 :
        /[MWmw@]/.test(character) ? 0.85 : /[A-Z0-9]/.test(character) ? 0.6 : 0.52;
      return fraction * font;
    }
    function measure(value) { return Array.from(value).reduce(function (sum, character) { return sum + advance(character); }, 0); }
    var paragraphs = String(text).replace(/\r\n?/g, '\n').split('\n');
    paragraphs.forEach(function (paragraph) {
      var used = 0, paragraphLines = 1;
      (paragraph.match(/\s+|\S+/g) || []).forEach(function (word) {
        var span = measure(word), blank = /^\s+$/.test(word);
        if (blank) { if (used) used += span; return; }
        if (used && used + span > width) { paragraphLines++; used = 0; }
        if (span <= width) { used += span; return; }
        // Long unbroken tokens wrap in native text boxes too. Count the
        // actual glyph widths instead of treating a wide token as one line.
        Array.from(word).forEach(function (character) {
          var size = advance(character);
          if (size > width) { paragraphLines = Infinity; return; }
          if (used && used + size > width) { paragraphLines++; used = 0; }
          used += size;
        });
      });
      lines += paragraphLines;
    });
    var spacing = typeof geometry.lineSpacingPct === 'number' && geometry.lineSpacingPct > 0 ? Math.max(1,geometry.lineSpacingPct / 100) : 1.15;
    return inset * 2 + font * 0.9 + Math.max(0, lines - 1) * font * spacing +
      paragraphs.length * ((geometry.spaceAbovePt || 0) + (geometry.spaceBelowPt || 0));
  }
  function textFitIssue(text, geometry) {
    if (!geometry || !geometry.heightPt) return null;
    var height = textHeightPt(text, geometry);
    return height !== null && height > geometry.heightPt + 0.01 ? 'CONTENT_FIT_RISK' : null;
  }
  function investigationAreaIssue(area, geometry) {
    function bounds(value) { return value && ['leftPt','topPt','widthPt','heightPt'].every(function (key) {
      return typeof value[key] === 'number' && isFinite(value[key]) && value[key] >= 0;
    }) && value.widthPt > 0 && value.heightPt > 0; }
    function inside(value, box) { return value.leftPt >= box.leftPt && value.topPt >= box.topPt &&
      value.leftPt+value.widthPt <= box.leftPt+box.widthPt && value.topPt+value.heightPt <= box.topPt+box.heightPt; }
    if (!area || area.contract !== 'investigation-left-area-v1' || !bounds(area) || !bounds(area.panel) || !bounds(area.body) ||
      ['sourceWidthPt','sourceHeightPt','pageWidthPt','pageHeightPt','maxBottomPt'].some(function (key) {return typeof area[key] !== 'number' || !isFinite(area[key]) || area[key] <= 0;}) ||
      area.textInsetPt !== 8 || !geometry || geometry.widthPt !== area.widthPt || geometry.heightPt !== area.heightPt ||
      area.widthPt !== Math.min(area.sourceWidthPt,area.body.widthPt) || Math.abs(area.leftPt-area.body.leftPt) > 0.75 ||
      area.maxBottomPt !== area.body.topPt-8 || area.heightPt !== Math.min(area.sourceHeightPt,area.maxBottomPt-area.topPt) ||
      !inside(area,area.panel) || !inside(area.body,area.panel) || area.panel.leftPt+area.panel.widthPt > area.pageWidthPt ||
      area.panel.topPt+area.panel.heightPt > area.pageHeightPt) return 'INVESTIGATION_LAYOUT_REVIEW_REQUIRED';
    return null;
  }
  // Only one reviewed takeaway may use the vacant native rows. The proof is
  // captured from the sealed source; it cannot be supplied as customer copy.
  function singlePeerTakeaway(fields) {
    return !!fields && typeof fields.peer_insight_1 === 'string' && fields.peer_insight_1.trim().length > 0 &&
      [2,3,4,5].every(function (number) { return fields['peer_insight_' + number] === null; });
  }
  function peerTakeawayAreaIssue(area, geometry) {
    function bounds(value) {
      return value && ['leftPt','topPt','widthPt','heightPt'].every(function (key) { return typeof value[key] === 'number' && isFinite(value[key]) && value[key] >= 0; }) && value.widthPt > 0 && value.heightPt > 0;
    }
    if (!area || area.contract !== 'peer-takeaway-area-v1' || !bounds(area) || !bounds(area.panel) ||
        !geometry || !Array.isArray(area.rows) || area.rows.length !== 5 ||
        ['sourceHeightPt','maxBottomPt','pageWidthPt','pageHeightPt'].some(function (key) { return typeof area[key] !== 'number' || !isFinite(area[key]) || area[key] <= 0; })) return 'PEER_LAYOUT_REVIEW_REQUIRED';
    var rows = area.rows, panel = area.panel;
    if (rows.some(function (row,index) { return !bounds(row) || row.field !== 'peer_insight_' + (index + 1) ||
      row.leftPt !== area.leftPt || row.widthPt !== area.widthPt || row.heightPt !== area.sourceHeightPt ||
      index > 0 && row.topPt < rows[index-1].topPt + rows[index-1].heightPt ||
      row.leftPt < panel.leftPt || row.leftPt + row.widthPt > panel.leftPt + panel.widthPt ||
      row.topPt < panel.topPt || row.topPt + row.heightPt / 2 > panel.topPt + panel.heightPt ||
      row.topPt + row.heightPt > area.pageHeightPt;
    }) || rows[0].topPt !== area.topPt || geometry.widthPt !== area.widthPt || geometry.heightPt !== area.sourceHeightPt ||
      panel.leftPt + panel.widthPt > area.pageWidthPt || panel.topPt + panel.heightPt > area.pageHeightPt ||
      area.maxBottomPt !== Math.min(rows[4].topPt + rows[4].heightPt, panel.topPt + panel.heightPt - 8) ||
      area.heightPt !== area.maxBottomPt - area.topPt || area.heightPt < area.sourceHeightPt) return 'PEER_LAYOUT_REVIEW_REQUIRED';
    return null;
  }
  function peerTakeawayGeometry(fields, geometry) {
    if (!singlePeerTakeaway(fields) || !geometry || !geometry.singleTakeawayArea) return geometry;
    var code = peerTakeawayAreaIssue(geometry.singleTakeawayArea, geometry);
    if (code) { var error = new Error('Capture a safe single-takeaway area from the approved native master before approval.'); error.code = code; throw error; }
    var result = {};
    Object.keys(geometry).forEach(function (key) { result[key] = geometry[key]; });
    result.heightPt = geometry.singleTakeawayArea.heightPt;
    return result;
  }
  function fieldPurposes(role) {
    return role === 'investigation_focus' ? {
      investigation_title:'slide_title', investigation_subtitle:'slide_context',
      investigation_focus:'left_short_focus', investigation_body:'left_practical_action',
      investigation_scope:'right_explanation_and_customer_benefit', investigation_decision_note:'bottom_decision_or_next_step'
    } : {};
  }
  function trendIssue(series, metric) {
    if (!series || !Array.isArray(series.values) || !Array.isArray(series.periods) || series.values.length !== series.periods.length) return 'INVALID_TREND_VALUE';
    var values = series.values, periods = series.periods;
    if (new Set(periods).size !== periods.length || periods.some(function (p) { return typeof p !== 'string' || !p.trim(); })) return 'INVALID_TREND_PERIODS';
    var iso = periods.every(function (p) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(p); });
    function ordinal(p) { return Number(p.slice(0,4))*12 + Number(p.slice(5,7)); }
    if (iso && periods.some(function (p,i) { return i > 0 && ordinal(p) !== ordinal(periods[i-1]) + 1; })) return 'INVALID_TREND_PERIODS';
    var definition=series.metricDefinition;
    if (metric==='primary' || definition) {
      var definitionIssue=metricDefinitionIssue(series);
      if (definitionIssue) return definitionIssue;
      if (!iso) return 'INVALID_TREND_PERIODS';
    }
    var unit = definition ? definition.unit : metric === 'volume' ? 'tickets' : metric === 'frt' ? 'hours' : 'percent';
    if (series.unit && series.unit !== unit && !(unit === 'percent' && series.unit === '%')) return 'INVALID_TREND_UNIT';
    if (values.some(function (v) { return v !== null && (typeof v !== 'number' || !isFinite(v) || v < 0 ||
      (metric === 'csat' || definition && definition.valueType==='percentage') && v > (definition && definition.valueScale==='fraction' ? 1 : 100) ||
      (definition ? definition.valueType==='count' : metric === 'volume') && Math.floor(v) !== v); })) return 'INVALID_TREND_VALUE';
    if (!definition && metric === 'volume' && series.metric && ['created','solved'].indexOf(series.metric) === -1) return 'INVALID_METRIC_NAME';
    var prior = series.priorYear;
    if (prior) {
      if (!iso || !Array.isArray(prior.periods) || !Array.isArray(prior.values) || prior.values.length !== values.length || prior.periods.length !== periods.length ||
          prior.metric !== series.metric || prior.unit !== series.unit || definition && (metricDefinitionIssue(prior) || JSON.stringify(canonicalizeSource(prior.metricDefinition))!==JSON.stringify(canonicalizeSource(definition))) || prior.periods.some(function (p,i) { return !/^\d{4}-(0[1-9]|1[0-2])$/.test(p) || ordinal(periods[i])-ordinal(p) !== 12; }) ||
          prior.values.some(function (v) { return v !== null && (typeof v !== 'number' || !isFinite(v) || v < 0 || definition && (definition.valueType==='count' && Math.floor(v)!==v || definition.valueType==='percentage' && v>(definition.valueScale==='fraction'?1:100))); })) return 'INVALID_PRIOR_YEAR_COMPARISON';
    } else if (/year.over.year|\byoy\b|prior.year/i.test(series.summaryChange || '')) return 'MISSING_PRIOR_YEAR_EVIDENCE';
    return null;
  }
  function valueIssue(role, field, value) {
    if (value === null && optionalMetricField(field)) return null;
    var type = renderer(field), text;
    if (type === 'bar') return value === null || typeof value === 'number' && isFinite(value) && value >= 0 && value <= 1 ? null : 'INVALID_TREND_VALUE';
    if (type === 'series') {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !value.updates || typeof value.updates !== 'object' || Array.isArray(value.updates) || !Object.keys(value.updates).length) return 'INVALID_SERIES_VALUE';
      return Object.keys(value.updates).every(function (key) {
        var update=value.updates[key];
        return /^[a-z][a-z0-9_]{1,100}$/.test(key) && update && typeof update === 'object' && !Array.isArray(update) && Object.keys(update).length &&
          ['leftPt','topPt','widthPt','heightPt'].every(function (prop) {return !Object.prototype.hasOwnProperty.call(update,prop) || typeof update[prop] === 'number' && isFinite(update[prop]) && update[prop] >= 0;}) &&
          (!Object.prototype.hasOwnProperty.call(update,'text') || typeof update.text === 'string' && update.text.length > 0);
      }) ? null : 'INVALID_SERIES_VALUE';
    }
    if (type === 'link') {
      if (!value || typeof value.text !== 'string' || !value.text.trim()) return 'MISSING_SEMANTIC_VALUE';
      if (!/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(value.url || '')) return 'INVALID_LINK';
      text = value.text;
    } else {
      if (typeof value !== 'string' || !value.trim()) return 'MISSING_SEMANTIC_VALUE';
      text = value;
    }
    var limit = maxCharacters(role, field);
    return limit !== null && text.length > limit ? 'CONTENT_FIT_RISK' : null;
  }
  function optionalMetricField(field, role) {
    return (!role || role==='baseline') && /^baseline_metric_[1-4]_(?:label|value|context)$/.test(field)
      || (!role || role==='peer_comparison') && (/^peer_(?:metric|current|average|top_performer|delta)_[1-3]$/.test(field) || /^peer_insight_[2-5]$/.test(field))
      || (!role || role==='measurement_plan') && /^measurement_(?:metric|baseline|target|cadence)_[1-3]$/.test(field);
  }
  function optionalMetricOmissionIssue(role, values, fieldNames, typed) {
    var groups={};values=values || {};
    (fieldNames || Object.keys(values)).forEach(function (field) {
      if(!optionalMetricField(field,role) || /^peer_insight_/.test(field))return;
      var match=/^baseline_metric_([1-4])_/.exec(field) || /_([1-3])$/.exec(field);
      if(match)(groups[match[1]] || (groups[match[1]]=[])).push(field);
    });
    for(var key of Object.keys(groups)) {
      var removed=groups[key].map(function (field) {return typed ? values[field] && values[field].kind==='remove' : values[field]===null;});
      if(removed.some(Boolean) && !removed.every(Boolean))return 'PARTIAL_METRIC_REMOVAL';
    }
    return null;
  }
  // These guards reproduce known failures; they do not prove semantic quality.
  // A human still reviews relevance, grounding and the exact rendered wording.
  function customerImplicationIssue(value) {
    if (typeof value !== 'string' || !value.trim()) return 'CUSTOMER_IMPLICATION_REVIEW_REQUIRED';
    var text = value.trim();
    var measurementOnly = /^(?:median )?(?:first reply time|resolution time|CSAT(?: score)?|ticket volume)\s+(?:rose|fell|increased|decreased)\s+from\s+[\d.,]+\s*(?:hours?|h|%|tickets)?\s+to\s+[\d.,]+\s*(?:hours?|h|%|tickets)\.?$/i;
    var comparisonOnly = /^(?:January|February|March|April|May|June|July|August|September|October|November|December|first reply time|resolution time|CSAT)\s+is\s+[\d.,]+\s*(?:hours?|h|points?|pts|%)\s+(?:above|below|slower than|faster than)\s+(?:the\s+)?(?:peer\s+)?average\.?$/i;
    if (measurementOnly.test(text) || comparisonOnly.test(text) || /^(?:Speed|Capacity|Quality|Action|Review):/i.test(text)
      || /\b(?:Zendesk can support this with|if confirmed,? this could|source state|CSM only)\b/i.test(text)) return 'CUSTOMER_IMPLICATION_REVIEW_REQUIRED';
    return null;
  }
  function renewalFocusIssue(card) {
    if (!card || typeof card.focus_area !== 'string' || !card.focus_area.trim()
      || ['why_it_matters_now','practical_next_step','how_zendesk_can_help','expected_outcome_if_confirmed','primary_capability'].some(function (field) { return Object.prototype.hasOwnProperty.call(card,field); })) return 'RENEWAL_FOCUS_CARD_INVALID';
    var benefit = card.customer_benefit;
    if (typeof benefit !== 'string' || !benefit.trim() || /[\r\n]/.test(benefit)
      || /^(?:Use|Review|Evaluate|Agree|Identify|Choose)\b/i.test(benefit)
      || /\b(?:Why it matters now|Practical next step|How Zendesk can help|Expected outcome)\b/i.test(benefit)
      || customerImplicationIssue(benefit)) return 'RENEWAL_CUSTOMER_BENEFIT_REQUIRED';
    return null;
  }
  function renewalFocusNotesIssue(cards, notes) {
    var details = notes && notes.recommendation_details;
    if (!Array.isArray(details) || details.length !== cards.length) return 'RENEWAL_SPEAKER_NOTES_REQUIRED';
    if (details.some(function (detail,index) {
      return !detail || detail.number !== index + 1 || !detail.verified_capability || typeof detail.verified_capability.label !== 'string'
        || !detail.verified_capability.label.trim() || !cards[index] || typeof cards[index].customer_benefit !== 'string'
        || cards[index].customer_benefit.toLowerCase().indexOf(detail.verified_capability.label.toLowerCase()) === -1
        || ['why_it_matters_now','practical_next_step','how_zendesk_can_help','expected_outcome_if_confirmed'].some(function (field) { return typeof detail[field] !== 'string' || !detail[field].trim(); });
    })) return 'RENEWAL_SPEAKER_NOTES_REQUIRED';
    return null;
  }
  function projectionWordingIssue(input) {
    var projection = input.projection || {}, plan = input.metricSlidePlan || {}, templates = projection.templateFields || {};
    for (var role of ['baseline','volume_trend','speed_quality_trend','peer_comparison']) {
      if (!plan[role] || !plan[role].include) continue;
      var fields = templates[role] || {};
      for (var field of Object.keys(fields)) {
        // Explicitly omitted secondary takeaways are removed, never filled
        // with generic text. The first reviewed takeaway remains mandatory.
        if (fields[field] === null && /^peer_insight_[2-5]$/.test(field)) continue;
        if (/^(?:baseline_insight_body|peer_insight_[1-5])$/.test(field) && customerImplicationIssue(fields[field])) return 'CUSTOMER_IMPLICATION_REVIEW_REQUIRED';
        if (/_series$/.test(field)) {
          var updates = fields[field] && fields[field].updates || {};
          for (var key of Object.keys(updates)) {
            if (/^insight_\d+$/.test(key) && !updates[key].remove && customerImplicationIssue(updates[key].text)) return 'CUSTOMER_IMPLICATION_REVIEW_REQUIRED';
          }
        }
      }
    }
    for (var metric of ['volume','frt','csat']) {
      var metricRole = metric === 'volume' ? 'volume_trend' : 'speed_quality_trend';
      var series = projection.runtimeTrendData && projection.runtimeTrendData[metric];
      if (plan[metricRole] && plan[metricRole].include && series
        && (series.insights || []).some(function (text) { return customerImplicationIssue(text); })) return 'CUSTOMER_IMPLICATION_REVIEW_REQUIRED';
    }
    return null;
  }
  function storyIssue(input) {
    var content = input.customerContent || {}, projection = input.projection || {}, phases = content.phases || [];
    if (typeof projection.agenda_summary !== 'string' || !projection.agenda_summary.trim()) return 'AGENDA_REVIEW_REQUIRED';
    if ((content.successMeasures || []).length > 3 && input.metricSlidePlan && input.metricSlidePlan.measurement_plan && input.metricSlidePlan.measurement_plan.include) return 'MEASUREMENT_CAPACITY_EXCEEDED';
    for (var i = 0; i < phases.length; i++) {
      var fields = projection.phaseTemplateFields && projection.phaseTemplateFields[phases[i].order] && projection.phaseTemplateFields[phases[i].order].phase_detail;
      if (fields && fields.phase_success !== (phases[i].benefits || []).join(' ')) return 'PHASE_BENEFIT_MISMATCH';
      if (input.metricSlidePlan && input.metricSlidePlan.measurement_plan && input.metricSlidePlan.measurement_plan.include && (!phases[i].measureRefIds || !phases[i].measureRefIds.length)) return 'PHASE_MEASURE_NOT_REVIEWED';
    }
    if (/\b(?:SLA policies|SLAs?)\s+(?:automatically\s+)?(?:route|assign)\s+tickets\b/i.test(JSON.stringify(projection))) return 'PRODUCT_EXPLANATION_REVIEW_REQUIRED';
    return projectionWordingIssue(input);
  }
  function canonicalizeSource(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonicalizeSource);
    var volatileKeys = { objectId: true, contentUrl: true, thumbnailUrl: true, sourceUrl: true }, result = {};
    Object.keys(value).sort().forEach(function (key) {
      if (!volatileKeys[key] && value[key] !== null && typeof value[key] !== 'undefined') result[key] = canonicalizeSource(value[key]);
    });
    return result;
  }
  var renewalNativePreflightContract = 'renewal-native-preflight-v1';
  var renewalRoles = ['progress','opportunities','focus'];
  var renewalFields = [['headline','metric_comparison','why_it_matters'],['headline','what_the_data_shows','customer_impact_opportunity'],['focus_area','customer_benefit']];
  function renewalLayoutIssue(layout) {
    if (!layout || layout.contract !== renewalNativePreflightContract || !Array.isArray(layout.slides) || layout.slides.length !== 3) return 'RENEWAL_NATIVE_LAYOUT_REQUIRED';
    function geometry(value) {
      return value && ['widthPt','heightPt','fontSizePt'].every(function (key) {return typeof value[key] === 'number' && isFinite(value[key]) && value[key] > 0;}) &&
        ['lineSpacingPct','spaceAbovePt','spaceBelowPt'].every(function (key) {return typeof value[key] === 'undefined' || typeof value[key] === 'number' && isFinite(value[key]) && value[key] >= 0;});
    }
    for (var index=0;index<3;index++) {
      var slide=layout.slides[index];
      if (!slide || slide.role !== renewalRoles[index] || !Array.isArray(slide.cards) || slide.cards.length !== 3 ||
          index<2 && !geometry(slide.subtitle_fit) || slide.cards.some(function (card) {return !card || Object.keys(card).length !== renewalFields[index].length || renewalFields[index].some(function (field) {return !geometry(card[field]);});})) return 'RENEWAL_NATIVE_LAYOUT_REQUIRED';
    }
    return null;
  }
  // The same glyph/spacing estimator runs before approval and immediately
  // before copying. Geometry must come from the read-only native capture.
  function renewalTextFitIssue(slides, layout) {
    var issue=renewalLayoutIssue(layout);
    if (issue) return {code:issue};
    if (!Array.isArray(slides) || slides.length!==3) return {code:'RENEWAL_SLIDE_CONTRACT_INVALID'};
    for (var index=0;index<3;index++) {
      var slide=slides[index],captured=layout.slides[index];
      if (!slide || slide.role!==renewalRoles[index] || !Array.isArray(slide.cards) || slide.cards.length<1 || slide.cards.length>3) return {code:'RENEWAL_SLIDE_CONTRACT_INVALID',role:renewalRoles[index]};
      if (index<2 && textFitIssue(slide.annual_point_of_view || slide.data_note || '',captured.subtitle_fit)) return {code:'CONTENT_FIT_RISK',role:slide.role,field:'subtitle'};
      for (var cardIndex=0;cardIndex<slide.cards.length;cardIndex++) for (var field of renewalFields[index]) {
        var value=slide.cards[cardIndex][field];
        if (typeof value!=='string' || !value.trim()) return {code:'RENEWAL_REVIEWED_FIELD_REQUIRED',role:slide.role,field:field,card_index:cardIndex};
        if (textFitIssue(value,captured.cards[cardIndex][field])) return {code:'CONTENT_FIT_RISK',role:slide.role,field:field,card_index:cardIndex};
      }
    }
    return null;
  }
  function renewalReviewedContent(reviewPackage) {
    return {customer_copy_contract:reviewPackage.customer_copy_contract,customer_slides:reviewPackage.customer_slides,private_speaker_notes:reviewPackage.private_speaker_notes};
  }
  return { version: 'native-review-v6', nativeFitContract: 'native-fit-v3', phaseStoryContract: 'phase-story-v2', customerWordingContract: 'customer-outcome-v2', renewalCopyContract: 'RenewalCustomerHeroCopyV2', generatedRoles: generatedRoles,
    supportingTemplates: supportingTemplates,
    supportingTemplate: function (number) { return typeof number === 'number' && Math.floor(number) === number ? supportingTemplates[number] || null : null; },
    titleField: function (role) { return role === 'investigation_focus' ? 'investigation_title' : role === 'supporting_metric' ? 'support_title' : null; },
    coverTitle: function (customerDisplayName) { return customerDisplayName + ' + Zendesk'; },
    coverLayoutInsetPt: 12, peerTakeawayLayoutContract: 'peer-takeaway-area-v1', investigationLayoutContract: 'investigation-left-area-v1', narrativeSelectionContract: 'narrative-selection-v1', metricTrendContract: 'MetricTrendV1', fieldPurposes: fieldPurposes,
    narrativeTemplates:narrativeTemplates,supportingTemplateForPurpose:supportingTemplateForPurpose,narrativeSelectionIssue:narrativeSelectionIssue,metricDefinitionIssue:metricDefinitionIssue,normalizedTrendValues:normalizedTrendValues,
    singlePeerTakeaway: singlePeerTakeaway, peerTakeawayAreaIssue: peerTakeawayAreaIssue, peerTakeawayGeometry: peerTakeawayGeometry,
    renderer: renderer, maxCharacters: maxCharacters, valueIssue: valueIssue, textHeightPt:textHeightPt, textFitIssue: textFitIssue, investigationAreaIssue:investigationAreaIssue, trendIssue: trendIssue, optionalMetricField: optionalMetricField, optionalMetricOmissionIssue:optionalMetricOmissionIssue, storyIssue: storyIssue,
    customerImplicationIssue: customerImplicationIssue, renewalFocusIssue: renewalFocusIssue, renewalFocusNotesIssue: renewalFocusNotesIssue,
    renewalNativePreflightContract:renewalNativePreflightContract,renewalLayoutIssue:renewalLayoutIssue,renewalTextFitIssue:renewalTextFitIssue,renewalReviewedContent:renewalReviewedContent,
    canonicalizeSource: canonicalizeSource, canonicalSourceJson: function (value) { return JSON.stringify(canonicalizeSource(value)); } };
}());
if (typeof module !== 'undefined' && module.exports) module.exports = CSMNativeContract;
