import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_INTELLIGENCE_CORE_CONTRACT,
  ACCOUNT_INTELLIGENCE_CORE_VERSION,
  addRenewalCsmContext,
  buildRenewalCsmEvidenceTables,
  buildRenewalDeckContent,
  buildRenewalConversationBrief,
  buildRenewalAiAgentsAdoptionSql,
  buildRenewalBasicToolsAdoptionSql,
  buildRenewalCommercialSubscriptionsSql,
  buildRenewalAccountTimingSql,
  buildRenewalTicketsByChannelSql,
  buildRenewalCompanyProfileSql,
  buildRenewalCopilotAdoptionSql,
  buildRenewalGuideAdoptionSql,
  buildRenewalRelatedAccountCtasSql,
  buildRenewalAccountContextSql,
  buildRenewalAccountGongDigestSql,
  buildRenewalAccountGongSpotlightSql,
  buildRenewalGainsightAccountContextSql,
  buildRenewalSuiteAdoptionSql,
  buildRenewalTeamAndTechContextSql,
  isRenewalCta,
  readRenewalConversationEvidenceWithSession,
  renewalCtaDeadlineStatus,
  renewalPreparationChoice,
} from "../mcp/renewal-conversation-brief.mjs";
import {
  RENEWAL_CONVERSATION_DESIGN_CONTRACT,
  RENEWAL_CONVERSATION_RENDERER_BASELINE,
  assertRenewalConversationRendererRequest,
  activeRenewalTemplateBinding,
} from "../mcp/renewal-conversation-renderer.mjs";
import { BetaError } from "../mcp/core.mjs";
import { buildAccountContextSql } from "../mcp/journey-a-contact-evidence.mjs";

const ACCOUNT_ID = "001000000000000AAA";
const comparableMetrics = [
  { metric: "CSAT score", evidence_state: "measured", comparison_state: "comparable", current_value: 92, year_ago_value: 88, year_over_year_change: 4, unit: "percent", period: "Month ending 2026-08", year_ago_period: "Year-ago month ending 2025-08" },
  { metric: "Median first reply time", evidence_state: "measured", comparison_state: "comparable", current_value: 2.5, year_ago_value: 1.5, year_over_year_change: 1, unit: "hours", period: "Month ending 2026-08", year_ago_period: "Year-ago month ending 2025-08" },
  { metric: "Zero-touch ticket ratio", evidence_state: "measured", comparison_state: "comparable", current_value: 14, year_ago_value: 10, year_over_year_change: 4, unit: "percent", period: "Month ending 2026-08", year_ago_period: "Year-ago month ending 2025-08" },
];

const accountRow = {
  ACCOUNT_NAME: "Invented Account", COMPANY_INDUSTRY: "Healthcare", COMPANY_EMPLOYEE_COUNT: 700,
  COMPANY_TYPE: "Private", COMPANY_SUMMARY: "Invented healthcare company summary.", COMPANY_HQ_CITY: "Lisbon", COMPANY_HQ_COUNTRY: "Portugal", COMPANY_WEBSITE: "https://example.invalid",
  GUIDE_ELIGIBLE: true, GUIDE_ACTIVATED: true, GUIDE_ADOPTED: false,
  COPILOT_PAID_PENETRATED: true,
  COMMERCIAL_SUBSCRIPTIONS_JSON: JSON.stringify([{
    product_plan: "Professional", product_line: "Suite", offering: "Copilot", offering_group: "Copilot",
    status: "Active", term_end: "2027-12-31",
  }]),
  TEAM_SETUP_ACTIVE_AGENT_COUNT: 3, TEAM_SETUP_INSTANCE_COUNT: 1, TEAM_SETUP_SLA_ACTIVE: true,
  ACCOUNT_EXECUTIVE: "Invented Account Executive", RENEWAL_MANAGER: "Invented Renewal Manager",
  BASIC_TOOLS_ADOPTED: true,
};

const gainsightRow = {
  ACCOUNT_NAME: "Invented Account",
  CSM_NAME: "Invented CSM",
  ACCOUNT_HEALTH: "Green",
  CS_SEGMENT: "Scaled",
  MARKET_SEGMENT: "Commercial",
  NET_ARR_USD: 15000,
};

const companyProfileRow = {
  ACCOUNT_NAME: "Invented Account", COMPANY_INDUSTRY: "Healthcare", COMPANY_EMPLOYEE_COUNT: 700,
  COMPANY_TYPE: "Private", COMPANY_SUMMARY: "Invented healthcare company summary.", COMPANY_HQ_CITY: "Lisbon", COMPANY_HQ_COUNTRY: "Portugal", COMPANY_WEBSITE: "https://example.invalid",
};

const commercialSubscriptionsRow = {
  COMMERCIAL_SUBSCRIPTIONS_JSON: JSON.stringify([{
    product_plan: "Professional", product_line: "Suite", offering: "Copilot", offering_group: "Copilot",
    status: "Active", seats: 4, arr_band: "12-100K", term_end: "2027-12-31",
  }]),
};

const renewalTimingRow = {
  ACCOUNT_EXECUTIVE: "Invented Account Executive",
  ACCOUNT_REGION: "EMEA",
  ACCOUNT_SUB_REGION: "Iberia",
  RENEWAL_DATE: "2026-12-31",
  RENEWAL_DAYS_REMAINING: 100,
  RENEWAL_TERM: "Annual",
  RENEWAL_MANAGER: "Invented Renewal Manager",
};

const ticketChannelsRow = {
  TICKET_CHANNELS_MONTH: "2026-08-01",
  TICKET_CHANNELS_JSON: JSON.stringify([
    { channel: "Email", tickets_created: 80, ticket_share: 2 / 3 },
    { channel: "Web", tickets_created: 40, ticket_share: 1 / 3 },
  ]),
};

const guideAdoptionRow = {
  GUIDE_ELIGIBLE: true, GUIDE_ACTIVATED: true, GUIDE_ADOPTED: false,
};

const copilotAdoptionRow = {
  COPILOT_PAID_PENETRATED: true, COPILOT_PAID_ACTIVATED: null, COPILOT_PAID_ADOPTED: null,
  COPILOT_UNPAID_PENETRATED: null, COPILOT_UNPAID_ACTIVATED: null, COPILOT_UNPAID_ADOPTED: null,
};

const teamAndTechRow = {
  TEAM_SETUP_ACTIVE_AGENT_COUNT: 3, TEAM_SETUP_INSTANCE_COUNT: 1, TEAM_SETUP_SLA_ACTIVE: true,
};

const gongDigestRow = {
  RELIABLY_MATCHED_CALL_COUNT: 1,
  LATEST_RELIABLY_MATCHED_CALL_AT: "2026-09-01T10:00:00.000Z",
  RECENT_CALLS_JSON: JSON.stringify([{
    call_at: "2026-09-01T10:00:00.000Z",
    title: "Invented customer call",
    conversation_key: "invented-gong-conversation",
    match_strength: "account_spotlight",
  }]),
};

const gongSpotlightRow = {
  RECENT_GONG_SPOTLIGHTS_JSON: JSON.stringify([{
    conversation_key: "invented-gong-conversation",
    spotlight_brief: "Invented navigation context",
    spotlight_key_points: "Invented key point",
    spotlight_next_steps: "Invented next step",
  }]),
};

function standardRenewalRows(query) {
  if (query.includes("GAINSIGHT_CALL_TO_ACTION_BCV")) {
    return [{ CTA_TITLE: "P1: Invented Renewal", CTA_STATUS: "New", CREATED_AT: "2026-09-01", DUE_AT: "2026-09-15" }];
  }
  if (query.includes("GAINSIGHT_COMPANY_BCV")) return [gainsightRow];
  if (query.includes("SALESFORCE_ACCOUNT_BCV")) return [companyProfileRow];
  if (query.includes("PRESENTATION.BULLSEYE_PRO.CUSTOMERS")) return [renewalTimingRow];
  if (query.includes("GUIDE_ADOPTION_CRM_DAILY_SNAPSHOT")) return [guideAdoptionRow];
  if (query.includes("COPILOT_CRM_DAILY_SNAPSHOT")) return [copilotAdoptionRow];
  if (query.includes("AI_AGENTS_CRM_DAILY_SNAPSHOT")) {
    assert.match(query, /FROM FUNCTIONAL\.PRODUCT_ANALYTICS\.AI_AGENTS_CRM_DAILY_SNAPSHOT\b/);
    return [{}];
  }
  if (query.includes("ZENDESK_SUITE_CRM_DAILY_SNAPSHOT")) return [{}];
  if (query.includes("BASIC_TOOLS_AND_RULES_CRM_DAILY_SNAPSHOT")) return [{}];
  if (query.includes("PRICING_COMM_SUBSCRIPTION")) return [commercialSubscriptionsRow];
  if (query.includes("FACT_AGGREGATED_TICKETS_DATA_DAILY_SNAPSHOT")) return [ticketChannelsRow];
  if (query.includes("FACT_AGGREGATED_RBA_KPIS")) {
    return [{
      RBA_METRICS_MONTH: 202608, YEAR_AGO_RBA_METRICS_MONTH: 202508,
      CREATED_TICKET_VALUE_COUNT: 1, RBA_CREATED_TICKETS: 120, YEAR_AGO_CREATED_TICKET_VALUE_COUNT: 1, YEAR_AGO_RBA_CREATED_TICKETS: 100,
      SOLVED_TICKET_VALUE_COUNT: 1, RBA_SOLVED_TICKETS: 115, YEAR_AGO_SOLVED_TICKET_VALUE_COUNT: 1, YEAR_AGO_RBA_SOLVED_TICKETS: 105,
      FIRST_REPLY_VALUE_COUNT: 1, YEAR_AGO_FIRST_REPLY_VALUE_COUNT: 1, MEDIAN_FIRST_REPLY_HOURS: 2, YEAR_AGO_MEDIAN_FIRST_REPLY_HOURS: 1.5,
      RESOLUTION_VALUE_COUNT: 1, YEAR_AGO_RESOLUTION_VALUE_COUNT: 1, MEDIAN_RESOLUTION_HOURS: 20, YEAR_AGO_MEDIAN_RESOLUTION_HOURS: 18,
      ZERO_TOUCH_VALUE_COUNT: 1, YEAR_AGO_ZERO_TOUCH_VALUE_COUNT: 1, ZERO_TOUCH_TICKET_RATIO: 14, YEAR_AGO_ZERO_TOUCH_TICKET_RATIO: 10,
      ONE_TOUCH_VALUE_COUNT: 1, YEAR_AGO_ONE_TOUCH_VALUE_COUNT: 1, ONE_TOUCH_TICKET_RATIO: 22, YEAR_AGO_ONE_TOUCH_TICKET_RATIO: 18,
      RBA_TREND_SERIES: [{ period: "202603", tickets_created: 105, tickets_solved: 98, median_first_reply_hours: 1.7, median_resolution_hours: 19, zero_touch_ticket_ratio: 12, one_touch_ticket_ratio: 20 }, { period: "202608", tickets_created: 120, tickets_solved: 115, median_first_reply_hours: 2, median_resolution_hours: 20, zero_touch_ticket_ratio: 14, one_touch_ticket_ratio: 22 }],
    }];
  }
  if (query.includes("FACT_GUIDE_ARTICLE_VIEWS_DAILY_SNAPSHOT")) {
    return [{
      GUIDE_KNOWLEDGE_VIEWS_MONTH: 202608, YEAR_AGO_GUIDE_KNOWLEDGE_VIEWS_MONTH: 202508,
      GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, GUIDE_KNOWLEDGE_VIEWS: 1343,
      YEAR_AGO_GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, YEAR_AGO_GUIDE_KNOWLEDGE_VIEWS: 1277,
      GUIDE_KNOWLEDGE_VIEW_TREND_SERIES: [{ period: "202603", knowledge_views: 1200 }, { period: "202608", knowledge_views: 1343 }],
    }];
  }
  if (query.includes("DIM_GROWTH_ENGINE_CUSTOMER_ACCOUNTS")) return [teamAndTechRow];
  if (query.includes("recent_gong_spotlights_json")) return [gongSpotlightRow];
  if (query.includes("PRESENTATION.BULLSEYE_PRO.SALES_ACTIVITY")) return [gongDigestRow];
  return [{ FIRST_REPLY_VALUE_COUNT: 1, YEAR_AGO_FIRST_REPLY_VALUE_COUNT: 1, MEDIAN_FIRST_REPLY_HOURS: 2, YEAR_AGO_MEDIAN_FIRST_REPLY_HOURS: 1.5 }];
}

test("all P0–P4 renewal CTA titles are eligible and non-renewal work is not", () => {
  for (const priority of ["P0", "P1", "P2", "P3", "P4"]) {
    assert.equal(isRenewalCta({ priority, cta_title: `${priority}: Non-Monthly Renewal (Partner)` }), true);
  }
  assert.equal(isRenewalCta({ priority: "P0", cta_title: "P0: Guide Adoption" }), false);
  assert.equal(isRenewalCta({ priority: "Other", cta_title: "Renewal" }), false);
  assert.equal(renewalPreparationChoice({ priority: "P2", cta_title: "P2: Non-Monthly Renewal" }).choice_required, true);
  assert.equal(renewalPreparationChoice({ priority: "P2", cta_title: "P2: Non-Monthly Renewal" }, { explicitlyRequested: true }).preparation_mode, "renewal_conversation_brief");
});

test("CSM selects frozen customer-safe slides from supported candidates and pairs", () => {
  const result = buildRenewalConversationBrief({
    accountContextRow: accountRow,
    metricRows: comparableMetrics,
    sourceStates: { account_context: "checked", ticket_metrics: "checked", rba_metrics: "checked" },
  });
  assert.equal(result.content_readiness.state, "ready_for_csm_selection");
  assert.equal(result.metric_candidates.length, 2);
  assert.equal(result.opportunity_and_focus_pairs.length, 3);
  const deck = buildRenewalDeckContent({
    reviewPackage: result,
    selectedMetricIds: result.metric_candidates.map((candidate) => candidate.id),
    selectedPairIds: result.opportunity_and_focus_pairs.map((pair) => pair.id),
  });
  assert.deepEqual(deck.customer_slides.map((slide) => slide.role), ["progress", "opportunities", "focus"]);
  assert.match(deck.annual_point_of_view, /customer feedback improved/i);
  assert.equal(deck.customer_slides[0].cards.length, 2);
  assert.equal(deck.customer_slides[1].cards.length, 3);
  assert.equal(deck.customer_slides[2].cards.length, 3);
  assert.match(deck.customer_slides[2].cards[0].customer_benefit, /Intelligent Triage/);
  assert.equal(deck.customer_slides[1].cards.some((card) => "question_to_validate" in card), false);
  assert.equal(deck.customer_slides[2].cards.some((card) => "primary_capability" in card), false);
  assert.doesNotMatch(JSON.stringify(deck.customer_slides), /CSM only|hypothesis|data-led/i);
  assert.equal(/ARR|health|CTA owner/i.test(JSON.stringify(deck.customer_slides)), false);
  assert.equal(deck.private_speaker_notes.length, 3);
  assert.match(deck.private_speaker_notes[1].talk_track, /question to validate/i);
});

test("renewal customer copy keeps Zendesk as guide and validation questions in private notes", () => {
  const review = buildRenewalConversationBrief({
    accountContextRow: accountRow,
    metricRows: comparableMetrics,
    sourceStates: { account_context: "checked", ticket_metrics: "checked", rba_metrics: "checked" },
  });
  const deck = buildRenewalDeckContent({
    reviewPackage: review,
    selectedMetricIds: review.metric_candidates.map((candidate) => candidate.id),
    selectedPairIds: review.opportunity_and_focus_pairs.map((pair) => pair.id),
  });
  assert.equal(deck.customer_copy_contract, "RenewalCustomerHeroCopyV2");
  assert.match(deck.annual_point_of_view, /^Over the past year, the measured results show/i);
  assert.match(deck.private_speaker_notes[2].recommendation_details[0].how_zendesk_can_help, /^Use Intelligent Triage/i);
  assert.doesNotMatch(JSON.stringify(deck.customer_slides), /Zendesk can support this with|If confirmed, this could/i);
  assert.match(deck.customer_slides[1].cards[0].customer_impact_opportunity, /customers/i);
  assert.match(deck.customer_slides[2].cards[0].customer_benefit, /customers.*Intelligent Triage/i);
  assert.deepEqual(Object.keys(deck.customer_slides[2].cards[0]).sort(), ["customer_benefit", "focus_area", "number"]);
  assert.doesNotMatch(JSON.stringify(deck.customer_slides), /question_to_validate|CSM only|hypothesis|data-led/i);
  assert.ok(deck.private_speaker_notes[1].validation_questions.length > 0);
});

test("a three-slide invented renewal story separates measured trends from customer benefits", () => {
  const review = buildRenewalConversationBrief({
    accountContextRow: { ...accountRow, TECH_STACK_GUIDE_EXTERNAL_CONNECTOR_INSTANCE_COUNT: 1 },
    metricRows: [
      { metric: "One-touch ticket ratio", evidence_state: "measured", comparison_state: "comparable", current_value: 27, year_ago_value: 22, year_over_year_change: 5, unit: "percent" },
      { metric: "Knowledge views", evidence_state: "measured", comparison_state: "comparable", current_value: 900, year_ago_value: 800, year_over_year_change: 100, year_over_year_change_pct: 12.5, unit: "views" },
      { metric: "Median first reply time", evidence_state: "measured", comparison_state: "comparable", current_value: 1.8, year_ago_value: 0.9, year_over_year_change: 0.9, year_over_year_change_pct: 100, unit: "hours" },
      { metric: "Median resolution time", evidence_state: "measured", comparison_state: "comparable", current_value: 48, year_ago_value: 30, year_over_year_change: 18, year_over_year_change_pct: 60, unit: "hours" },
      { metric: "Zero-touch ticket ratio", evidence_state: "measured", comparison_state: "comparable", current_value: 9, year_ago_value: 20, year_over_year_change: -11, unit: "percent" },
    ],
    sourceStates: { account_context: "checked", rba_metrics: "checked", guide_knowledge_views: "checked" },
  });
  const deck = buildRenewalDeckContent({
    reviewPackage: review,
    selectedMetricIds: ["metric:one-touch-ticket-ratio", "metric:knowledge-views"],
    selectedPairIds: ["pair:metric:median-first-reply-time", "pair:metric:median-resolution-time", "pair:metric:zero-touch-ticket-ratio"],
  });
  const [progress, opportunities, focus] = deck.customer_slides;
  assert.deepEqual(deck.customer_slides.map((slide) => slide.cards.length), [2, 3, 3]);
  assert.match(progress.cards[0].headline, /^A higher share/i);
  assert.match(progress.cards[1].why_it_matters, /self-serve.*complex work/i);
  assert.match(opportunities.cards[0].customer_impact_opportunity, /customers an earlier update/i);
  assert.match(opportunities.cards[2].customer_impact_opportunity, /self-service/i);
  assert.match(focus.cards[0].customer_benefit, /Intelligent Triage/i);
  assert.equal(focus.cards[2].customer_benefit, "Make trusted answers easier to find in Help Center search with Knowledge Connectors, so customers can help themselves.");
  assert.match(deck.private_speaker_notes[2].recommendation_details[2].how_zendesk_can_help, /^Use Knowledge Connectors/i);
  assert.match(deck.private_speaker_notes[2].recommendation_details[2].practical_next_step, /Help Center search/i);
  assert.match(deck.private_speaker_notes[2].recommendation_details[2].expected_outcome_if_confirmed, /self-service/i);
  assert.doesNotMatch(JSON.stringify(deck.customer_slides), /Zendesk can support this with|If confirmed, this could|does not show who viewed it/i);
  assert.match(deck.private_speaker_notes[0].talk_track, /views measure engagement/i);
  assert.match(deck.private_speaker_notes[1].validation_questions[2], /available to customers/i);
});

test("the CSM-only renewal brief keeps the full account context out of customer slides", () => {
  const result = buildRenewalConversationBrief({
    accountContextRow: { ...gainsightRow, ...accountRow },
    metricRows: comparableMetrics,
    selectedCta: {
      priority: "P0", title: "P0: Non-Monthly Renewal", status: "New",
      created_at: "2026-09-01T09:45:32.000Z", action_deadline: "2026-09-08T09:45:32.000Z", urgency: "overdue",
      monitor_link: "https://monitor.example.invalid/cta",
    },
    ticketChannels: {
      state: "checked",
      period: "2026-08-01",
      items: [{ channel: "Email", tickets_created: 80, ticket_share: 2 / 3 }, { channel: "Web", tickets_created: 40, ticket_share: 1 / 3 }],
      note: "Invented channel note",
    },
    gongDigestRow,
    sourceStates: { account_context: "checked", ticket_metrics: "checked", rba_metrics: "checked" },
    fullBriefSources: {
      csm_account_context: "checked",
      company_profile_products_adoption: "checked",
      team_setup_and_tech_stack: "checked",
      support_operations_ticket_trends: "checked",
      support_operations_rba_trends: "checked",
      selected_cta: "checked",
      cta_monitor_link: "checked",
      account_region: "checked",
      renewal_timing: "checked",
      account_arr_band: "checked",
      subscription_seats: "checked",
      account_gong_metadata: "checked",
      goals_and_timeline: "requires_selected_call",
    },
  });
  assert.equal(result.csm_account_brief.csm_account_context.current_csm_name, "Invented CSM");
  assert.equal(result.csm_account_brief.csm_account_context.net_arr_usd, 15000);
  assert.equal(result.csm_account_brief.selected_cta.priority, "P0");
  assert.equal(result.csm_account_brief.selected_cta.monitor_link_state, "checked");
  assert.equal(result.csm_account_brief.product_context.adoption_gaps[0].product, "Guide");
  assert.equal(result.csm_account_brief.recent_gong_conversations.recent_calls.length, 1);
  assert.match(result.csm_account_brief.goals_and_timeline.note, /selected and authorized call/i);
  assert.equal(JSON.stringify(result.customer_slides).includes("Invented CSM"), false);
  assert.equal(JSON.stringify(result.customer_slides).includes("15000"), false);
});

test("the renewal brief exposes the shared account-intelligence core and does not hide uncovered fields", () => {
  const result = buildRenewalConversationBrief({
    accountContextRow: { ...gainsightRow, ...accountRow },
    metricRows: comparableMetrics,
    selectedCta: {
      priority: "P0", title: "P0: Non-Monthly Renewal", status: "New",
      created_at: "2026-09-01T09:45:32.000Z", action_deadline: "2026-09-08T09:45:32.000Z", urgency: "overdue",
      monitor_link: "https://monitor.example.invalid/cta",
    },
    gongDigestRow,
    sourceStates: { account_context: "checked", ticket_metrics: "checked", rba_metrics: "checked" },
    fullBriefSources: {
      csm_account_context: "checked",
      company_profile_products_adoption: "checked",
      team_setup_and_tech_stack: "checked",
      support_operations_ticket_trends: "checked",
      support_operations_rba_trends: "checked",
      selected_cta: "checked",
      cta_monitor_link: "checked",
      account_region: "checked",
      renewal_timing: "checked",
      account_arr_band: "checked",
      subscription_seats: "checked",
      account_gong_metadata: "checked",
      goals_and_timeline: "requires_selected_call",
    },
  });
  const core = result.shared_account_intelligence;
  assert.equal(core.contract, ACCOUNT_INTELLIGENCE_CORE_CONTRACT);
  assert.equal(core.schema_version, ACCOUNT_INTELLIGENCE_CORE_VERSION);
  assert.equal(core.brief_state, "partial");
  assert.deepEqual(Object.keys(core.sections), [
    "account_header", "cta_context", "company_profile", "commercial_footprint", "product_footprint",
    "adoption_gaps", "team_and_setup", "tech_stack", "support_operations", "recent_conversations",
  ]);
  assert.equal(core.sections.account_header.facts.renewal_date.state, "checked");
  assert.equal(core.sections.commercial_footprint.facts.seats.state, "checked");
  assert.equal(core.sections.cta_context.facts.monitor_link.state, "checked");
  assert.equal(core.sections.product_footprint.facts.observed_product_usage_coverage.state, "partially_checked");
  assert.equal(core.call_specific_context.state, "requires_selected_call");
  assert.equal(JSON.stringify(result.customer_slides).includes("not_assessed"), false);
});

test("the CSM evidence display is a fixed table-only view with source states", () => {
  const review = buildRenewalConversationBrief({
    accountContextRow: { ...gainsightRow, ...accountRow, ...renewalTimingRow, ...commercialSubscriptionsRow },
    metricRows: comparableMetrics,
    selectedCta: {
      priority: "P0", title: "P0: Non-Monthly Renewal", status: "New",
      created_at: "2026-09-01T09:45:32.000Z", action_deadline: "2026-09-08T09:45:32.000Z", urgency: "overdue",
      monitor_link: "https://monitor.example.invalid/cta",
    },
    ticketChannels: {
      state: "checked",
      period: "2026-08-01",
      items: [{ channel: "Email", tickets_created: 80, ticket_share: 2 / 3 }, { channel: "Web", tickets_created: 40, ticket_share: 1 / 3 }],
      note: "Invented channel note",
    },
    gongDigestRow,
    sourceStates: { account_context: "checked", rba_metrics: "checked", guide_knowledge_views: "checked" },
    fullBriefSources: {
      csm_account_context: "checked", company_profile_products_adoption: "checked", company_profile: "checked",
      commercial_subscriptions: "checked", guide_adoption: "checked", copilot_adoption: "checked",
      ai_agents_adoption: "checked", suite_adoption: "checked", basic_tools_adoption: "checked",
      team_setup_and_tech_stack: "checked", support_operations_monthly_rba_trends: "checked",
      guide_knowledge_view_trends: "checked", ticket_channels: "checked", selected_cta: "checked", related_account_ctas: "checked",
      cta_monitor_link: "checked", account_region: "checked", renewal_timing: "checked",
      account_arr_band: "checked", subscription_seats: "checked", account_gong_metadata: "checked",
      goals_and_timeline: "requires_selected_call",
    },
  });
  const tables = buildRenewalCsmEvidenceTables({ accountIntelligence: review.shared_account_intelligence, metricTable: { rows: comparableMetrics } });
  assert.deepEqual(tables.map((table) => table.id), [
    "account_and_renewal", "cta_context", "related_ctas", "company_profile", "commercial_footprint",
    "product_and_adoption", "team_and_tech", "performance_trends", "tickets_by_channel", "recent_conversations", "source_gaps",
  ]);
  assert.ok(tables.every((table) => Array.isArray(table.columns) && Array.isArray(table.rows)));
  const accountAndRenewal = tables.find((table) => table.id === "account_and_renewal");
  const ctaContext = tables.find((table) => table.id === "cta_context");
  const companyProfile = tables.find((table) => table.id === "company_profile");
  const productAndAdoption = tables.find((table) => table.id === "product_and_adoption");
  const teamAndTech = tables.find((table) => table.id === "team_and_tech");
  const performanceTrends = tables.find((table) => table.id === "performance_trends");
  assert.equal(accountAndRenewal.rows.find((row) => row.field === "Net ARR (USD)").value, "15,000");
  assert.equal(accountAndRenewal.rows.find((row) => row.field === "Account Executive").value, "Invented Account Executive");
  assert.equal(accountAndRenewal.rows.find((row) => row.field === "Renewal manager").value, "Invented Renewal Manager");
  assert.equal(ctaContext.rows.find((row) => row.field === "Monitor link").state, "checked");
  assert.equal(ctaContext.rows.find((row) => row.field === "Created").value, "2026-09-01 09:45 UTC");
  assert.equal(ctaContext.rows.find((row) => row.field === "Deadline status").value, "Overdue");
  assert.equal(ctaContext.rows.some((row) => row.field === "Action-deadline definition"), false);
  assert.equal(companyProfile.rows.find((row) => row.field === "CRM website").value, "https://example.invalid");
  assert.equal(companyProfile.rows.find((row) => row.field === "Company summary").value, "Invented healthcare company summary.");
  assert.equal(companyProfile.rows.some((row) => /account type/i.test(row.field)), false);
  assert.match(companyProfile.footnote, /Salesforce Account\.Website/i);
  assert.equal(productAndAdoption.rows.find((row) => row.product === "basic tools and rules").adoption_gap, "Adopted");
  assert.equal(productAndAdoption.rows.find((row) => row.product === "basic tools and rules").state, "checked");
  assert.equal(productAndAdoption.rows.find((row) => row.product === "ai agents paid").adoption_gap, "Not adopted — Unavailable in the current snapshot");
  assert.equal(productAndAdoption.rows.some((row) => row.product === "Adoption reference"), false);
  assert.match(productAndAdoption.footnote, /approved adoption snapshot/i);
  const unestablishedTables = buildRenewalCsmEvidenceTables({
    accountIntelligence: { sections: { product_footprint: { facts: { observed_use: { "copilot paid": "Not established" } } } } },
    metricTable: { rows: [] },
  });
  assert.equal(unestablishedTables.find((table) => table.id === "product_and_adoption").rows.find((row) => row.product === "copilot paid").adoption_gap, "Not established");
  assert.deepEqual(teamAndTech.rows.find((row) => row.field === "Seat allocation"), {
    field: "Seat allocation", value: "4 of 4 seats used — 1 owner, 3 agents", state: "calculated",
  });
  assert.match(teamAndTech.footnote, /current contracted seats and active agents/i);
  assert.deepEqual(performanceTrends.columns.slice(0, 3), ["Metric", "Aug 2026", "Aug 2025"]);
  assert.equal(performanceTrends.rows.find((row) => row.metric === "Median first reply time").current, "2.5 hours");
  const ticketsByChannel = tables.find((table) => table.id === "tickets_by_channel");
  assert.deepEqual(ticketsByChannel.columns, ["Aug 2026", "Share of tickets", "State"]);
  assert.deepEqual(ticketsByChannel.rows, [
    { channel: "Email", ticket_share: "66.7%", state: "checked" },
    { channel: "Web", ticket_share: "33.3%", state: "checked" },
  ]);
  assert.equal(ticketsByChannel.footnote, "Invented channel note");
  assert.equal(tables.find((table) => table.id === "recent_conversations").rows[0].match, "account_spotlight");
  const sourceGaps = tables.find((table) => table.id === "source_gaps");
  assert.deepEqual(sourceGaps.columns, ["Field", "State", "Coverage or reason"]);
  assert.match(sourceGaps.rows.find((row) => row.field === "observed product usage coverage").details, /Checked: adoption snapshots/i);
  assert.equal(sourceGaps.rows.some((row) => row.field === "Goals, timeline, pain points, stakeholders, priorities, and commitments"), true);

  const inProgressReview = buildRenewalConversationBrief({
    accountContextRow: { ...gainsightRow, ...accountRow, ...renewalTimingRow, ...commercialSubscriptionsRow },
    metricRows: [],
    selectedCta: {
      priority: "P0", title: "P0: Non-Monthly Renewal", status: "In Progress",
      created_at: "2026-09-01T09:45:32.000Z", action_deadline: "2026-09-08T09:45:32.000Z",
    },
    sourceStates: { account_context: "checked" },
  });
  const inProgressCtaContext = buildRenewalCsmEvidenceTables({
    accountIntelligence: inProgressReview.shared_account_intelligence,
    metricTable: { rows: [] },
  }).find((table) => table.id === "cta_context");
  assert.equal(inProgressCtaContext.rows.find((row) => row.field === "Deadline status").value, "Overdue");
});

test("renewal evidence supplies complete customer-content review tables and rounded metric changes", () => {
  const review = buildRenewalConversationBrief({
    accountContextRow: { ...gainsightRow, ...accountRow, ...renewalTimingRow, ...commercialSubscriptionsRow },
    metricRows: comparableMetrics,
    sourceStates: { account_context: "checked", rba_metrics: "checked", guide_knowledge_views: "checked" },
    fullBriefSources: {
      csm_account_context: "checked", company_profile_products_adoption: "checked", company_profile: "checked",
      commercial_subscriptions: "checked", guide_adoption: "checked", copilot_adoption: "checked",
      ai_agents_adoption: "checked", suite_adoption: "checked", basic_tools_adoption: "checked",
      team_setup_and_tech_stack: "checked", support_operations_monthly_rba_trends: "checked",
      guide_knowledge_view_trends: "checked", selected_cta: "checked", related_account_ctas: "checked",
      cta_monitor_link: "checked", account_region: "checked", renewal_timing: "checked",
      account_arr_band: "checked", subscription_seats: "checked", account_gong_metadata: "checked",
      goals_and_timeline: "requires_selected_call",
    },
  });
  const contentTables = review.csm_content_review_display.tables;
  assert.deepEqual(contentTables.map((table) => table.id), [
    "annual_point_of_view", "progress_metric_candidates", "linked_opportunities_and_focus",
  ]);
  assert.match(contentTables[2].rows[0].how_zendesk_can_help, /^Use Intelligent Triage/i);
  assert.match(contentTables[2].rows[0].expected_outcome, /customers/i);
  const tables = buildRenewalCsmEvidenceTables({
    accountIntelligence: review.shared_account_intelligence,
    metricTable: {
      rows: [{
        metric: "One-touch ticket ratio", current_value: 29.6, year_ago_value: 32.9,
        percentage_point_change: -3.3000000004, evidence_state: "measured", comparison_state: "comparable",
        definition: "Invented definition", source: "Invented source", unit: "percent",
      }],
    },
  });
  const trend = tables.find((table) => table.id === "performance_trends").rows[0];
  assert.equal(trend.current, "29.6%");
  assert.equal(trend.same_month_last_year, "32.9%");
  assert.equal(trend.change, "-3.3 pp");
});

test("an active subscription term end supplies clearly labelled renewal timing when CRM renewal date is missing", () => {
  const review = buildRenewalConversationBrief({
    accountContextRow: { ...gainsightRow, ...accountRow, RENEWAL_DAYS_REMAINING: 0, RENEWAL_DATE: null, RENEWAL_TERM: null },
    metricRows: comparableMetrics,
    sourceStates: { account_context: "checked", rba_metrics: "checked", guide_knowledge_views: "checked" },
    now: new Date("2026-09-23T00:00:00.000Z"),
    fullBriefSources: {
      csm_account_context: "checked", company_profile_products_adoption: "checked", company_profile: "checked",
      commercial_subscriptions: "checked", guide_adoption: "checked", copilot_adoption: "checked",
      ai_agents_adoption: "checked", suite_adoption: "checked", basic_tools_adoption: "checked",
      team_setup_and_tech_stack: "checked", support_operations_monthly_rba_trends: "checked",
      guide_knowledge_view_trends: "checked", selected_cta: "checked", related_account_ctas: "checked",
      cta_monitor_link: "checked", account_region: "checked", renewal_timing: "no_data",
      account_arr_band: "checked", subscription_seats: "checked", account_gong_metadata: "checked",
      goals_and_timeline: "requires_selected_call",
    },
  });
  const tables = buildRenewalCsmEvidenceTables({ accountIntelligence: review.shared_account_intelligence, metricTable: { rows: [] } });
  const renewalDate = tables.find((table) => table.id === "account_and_renewal").rows.find((row) => row.field === "Renewal date");
  const basis = tables.find((table) => table.id === "account_and_renewal").rows.find((row) => row.field === "Renewal date basis");
  const days = tables.find((table) => table.id === "account_and_renewal").rows.find((row) => row.field === "Days to renewal");
  assert.deepEqual(renewalDate, { field: "Renewal date", value: "2027-12-31", state: "checked" });
  assert.deepEqual(basis, { field: "Renewal date basis", value: "Current active subscription term end (CRM renewal date not available)", state: "checked" });
  assert.deepEqual(days, { field: "Days to renewal", value: "464", state: "checked" });
});

test("a CRM renewal date takes precedence over the active subscription term end", () => {
  const review = buildRenewalConversationBrief({
    accountContextRow: { ...gainsightRow, ...accountRow, ...renewalTimingRow, ...commercialSubscriptionsRow },
    metricRows: comparableMetrics,
    sourceStates: { account_context: "checked", rba_metrics: "checked", guide_knowledge_views: "checked" },
    now: new Date("2026-09-23T00:00:00.000Z"),
    fullBriefSources: {
      csm_account_context: "checked", company_profile_products_adoption: "checked", company_profile: "checked",
      commercial_subscriptions: "checked", guide_adoption: "checked", copilot_adoption: "checked",
      ai_agents_adoption: "checked", suite_adoption: "checked", basic_tools_adoption: "checked",
      team_setup_and_tech_stack: "checked", support_operations_monthly_rba_trends: "checked",
      guide_knowledge_view_trends: "checked", selected_cta: "checked", related_account_ctas: "checked",
      cta_monitor_link: "checked", account_region: "checked", renewal_timing: "checked",
      account_arr_band: "checked", subscription_seats: "checked", account_gong_metadata: "checked",
      goals_and_timeline: "requires_selected_call",
    },
  });
  const header = review.shared_account_intelligence.sections.account_header.facts;
  assert.equal(header.renewal_date.value, "2026-12-31");
  assert.equal(header.renewal_date_basis.value, "CRM renewal date");
  assert.equal(header.renewal_days_remaining.value, 99);
});

test("independently sourced renewal fields remain available when another account section fails", async () => {
  const session = {
    async query(query) {
      if (query.includes("SALESFORCE_ACCOUNT_BCV")) {
        throw new BetaError("SNOWFLAKE_SESSION_QUERY_FAILED", "profile source failed");
      }
      return standardRenewalRows(query);
    },
  };
  const result = await readRenewalConversationEvidenceWithSession({
    accountId: ACCOUNT_ID,
    selectedCta: { monitor_link: "https://monitor.example.invalid/cta" },
    session,
  });
  const header = result.review_package.shared_account_intelligence.sections.account_header.facts;
  const commercial = result.review_package.shared_account_intelligence.sections.commercial_footprint.facts;
  assert.equal(result.full_brief_source_states.company_profile, "query_failed");
  assert.equal(result.review_package.shared_account_intelligence.sections.company_profile.facts.employee_count, null, "Failed profile read is not zero employees");
  assert.equal(header.region.state, "checked");
  assert.equal(header.region.value, "EMEA");
  assert.equal(header.renewal_date.value, "2026-12-31");
  assert.equal(header.arr_band.value, "12-100K");
  assert.equal(commercial.seats.value[0].seats, 4);
  assert.equal(result.review_package.shared_account_intelligence.sections.cta_context.facts.monitor_link.state, "checked");
});

test("Account Executive reuses the Bullseye CRM owner without a Salesforce User lookup", async () => {
  const queries = [];
  const session = {
    async query(query) {
      queries.push(query);
      return standardRenewalRows(query);
    },
  };
  const result = await readRenewalConversationEvidenceWithSession({ accountId: ACCOUNT_ID, session });
  assert.match(queries.find((query) => query.includes("PRESENTATION.BULLSEYE_PRO.CUSTOMERS")), /CRM_OWNER_NAME AS account_executive/);
  assert.equal(queries.some((query) => query.includes("SALESFORCE_USER_BCV")), false);
  assert.equal(result.full_brief_source_states.account_executive, "checked");
  assert.equal(result.review_package.shared_account_intelligence.sections.account_header.facts.account_executive.value, "Invented Account Executive");
  assert.equal(result.full_brief_source_states.ticket_channels, "checked");
  assert.equal(result.full_brief_source_states.support_operations_monthly_rba_trends, "checked");
});

test("incomplete evidence produces a data note, not generic filler", () => {
  const result = buildRenewalConversationBrief({
    accountContextRow: accountRow,
    metricRows: [{ metric: "CSAT score", evidence_state: "missing", comparison_state: "missing", unit: "percent" }],
    sourceStates: { account_context: "checked", ticket_metrics: "timed_out", rba_metrics: "unavailable" },
  });
  assert.equal(result.slides[0].cards.length, 0);
  assert.match(result.slides[0].data_note, /incomplete/i);
  assert.equal(result.content_readiness.state, "needs_csm_decision");
  assert.equal(result.metric_candidates.length, 0);
});

test("the managed renewal evidence read uses only its managed full-brief sources", async () => {
  const queries = [];
  const session = {
    async query(query) {
      queries.push(query);
      return standardRenewalRows(query);
    },
  };
  const result = await readRenewalConversationEvidenceWithSession({ accountId: ACCOUNT_ID, session });
  assert.equal(result.status, "evidence_ready_with_gaps");
  assert.equal(queries.length, 18);
  const combined = queries.join("\n");
  assert.match(combined, /<= 12/);
  assert.match(combined, /PRESENTATION\.BULLSEYE_PRO\.SALES_ACTIVITY/);
  assert.match(combined, /GAINSIGHT_CALL_TO_ACTION_BCV/);
  assert.match(combined, /FACT_AGGREGATED_RBA_KPIS_MONTHLY_SNAPSHOT_CS_VIEW/);
  assert.match(combined, /FACT_AGGREGATED_TICKETS_DATA_DAILY_SNAPSHOT/);
  assert.match(combined, /TICKET_VIA_ID IN \(5, 66\).*'API'/s);
  assert.match(combined, /FACT_GUIDE_ARTICLE_VIEWS_DAILY_SNAPSHOT/);
  assert.doesNotMatch(combined, /FACT_AGGREGATED_TICKETS_UNIONED_DAILY_SNAPSHOT/);
  assert.doesNotMatch(combined, /GONG_CONVERSATION_PARTICIPANTS_BCV|SALESFORCE_CONTACT_FORMULA_BCV|DIM_CRM_CONTACTS|SALESFORCE_TASK|GONG_CALL_TRANSCRIPTS|gmail|tam_|QBR Express/i);
  assert.equal(result.full_brief_source_states.account_gong_metadata, "checked");
  assert.equal(result.full_brief_source_states.account_gong_spotlight, "checked");
  assert.equal(result.full_brief_source_states.related_account_ctas, "checked");
  assert.equal(result.full_brief_source_states.ticket_channels, "checked");
  assert.equal(result.full_brief_source_states.account_executive, "checked");
  assert.equal(result.review_package.shared_account_intelligence.sections.cta_context.facts.related_account_ctas.items.length, 1);
});

test("knowledge views can be a progress metric without claiming deflection or resolution", () => {
  const result = buildRenewalConversationBrief({
    accountContextRow: accountRow,
    metricRows: [{
      metric: "Knowledge views",
      definition: "All recorded Guide article views in the measured calendar month, regardless of viewer role. This is engagement, not proof of ticket deflection.",
      evidence_state: "measured",
      comparison_state: "comparable",
      current_value: 1343,
      year_ago_value: 1277,
      year_over_year_change: 66,
      year_over_year_change_pct: 5.1684,
      unit: "views",
    }],
    sourceStates: { account_context: "checked", rba_metrics: "checked", guide_knowledge_views: "checked" },
  });
  assert.equal(result.metric_candidates.length, 1);
  assert.equal(result.metric_candidates[0].outcome_headline, "Help Center content received more views");
  assert.match(result.metric_candidates[0].why_it_matters, /chances to help customers self-serve/i);
  assert.doesNotMatch(result.metric_candidates[0].why_it_matters, /reduced contacts|resolved requests|deflected tickets/i);
  assert.doesNotMatch(result.metric_candidates[0].outcome_headline, /deflect|resolve|prevent/i);
  const deck = buildRenewalDeckContent({
    reviewPackage: {
      ...result,
      opportunity_and_focus_pairs: [{
        id: "pair:invented",
        verified_capability: { key: "invented_capability", label: "Invented capability" },
        evidence_roots: ["metric:invented-opportunity"],
        opportunity: { headline: "Make answers easier to find", what_the_data_shows: "An invented metric moved.", customer_impact_opportunity: "Help customers find useful answers.", question_to_validate: "Which answers matter most?" },
        focus: { focus_area: "Improve useful answers", customer_benefit: "Clearer answers for customers, supported by the Invented capability.", why_it_matters_now: "An invented metric moved.", practical_next_step: "Review common questions.", how_zendesk_can_help: "Use an approved capability.", expected_outcome_if_confirmed: "Clearer answers for customers." },
      }],
    },
    selectedMetricIds: [result.metric_candidates[0].id],
    selectedPairIds: ["pair:invented"],
  });
  assert.match(deck.private_speaker_notes[0].talk_track, /not unique customers, answered questions, or avoided contacts/i);
  assert.match(deck.private_speaker_notes[0].validation_questions.at(-1), /Did the additional Help Center views/i);
});

test("one-touch progress describes a higher share, not an unmeasured absolute count", () => {
  const result = buildRenewalConversationBrief({
    accountContextRow: accountRow,
    metricRows: [{ metric: "One-touch ticket ratio", evidence_state: "measured", comparison_state: "comparable", current_value: 24, year_ago_value: 20, year_over_year_change: 4, unit: "percent" }],
    sourceStates: { account_context: "checked", rba_metrics: "checked" },
  });
  assert.match(result.metric_candidates[0].outcome_headline, /^A higher share of requests/i);
  assert.match(result.metric_candidates[0].why_it_matters, /less back-and-forth/i);
});

test("a zero-touch focus links Knowledge Connectors to customer-visible answers only after a check", () => {
  const result = buildRenewalConversationBrief({
    accountContextRow: { ...accountRow, TECH_STACK_GUIDE_EXTERNAL_CONNECTOR_INSTANCE_COUNT: 1 },
    metricRows: [{ metric: "Zero-touch ticket ratio", evidence_state: "measured", comparison_state: "comparable", current_value: 12, year_ago_value: 28, year_over_year_change: -16, unit: "percent" }],
    sourceStates: { account_context: "checked", rba_metrics: "checked" },
  });
  const pair = result.opportunity_and_focus_pairs.find((candidate) => candidate.id === "pair:metric:zero-touch-ticket-ratio");
  assert.equal(pair.verified_capability.key, "knowledge_connectors");
  assert.match(pair.focus.how_zendesk_can_help, /Help Center search/i);
  assert.match(pair.focus.practical_next_step, /check whether their answers appear/i);
  assert.match(pair.opportunity.question_to_validate, /available to customers/i);
});

test("the managed renewal evidence read serializes a single Snowflake session", async () => {
  const queries = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  const session = {
    async query(query) {
      queries.push(query);
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return standardRenewalRows(query);
    },
  };
  await readRenewalConversationEvidenceWithSession({ accountId: ACCOUNT_ID, session });
  assert.equal(maximumInFlight, 1);
  assert.equal(queries.length, 18);
});

test("a successful empty related-CTA read is checked while a failed read retains its gap", async () => {
  for (const failed of [false, true]) {
    const session = { async query(query) {
      if (query.includes("GAINSIGHT_CALL_TO_ACTION_BCV")) {
        if (failed) throw new BetaError("SNOWFLAKE_SESSION_QUERY_FAILED", "Invented query failure", { source_error_type: "ProgrammingError" });
        return [];
      }
      return standardRenewalRows(query);
    } };
    const result = await readRenewalConversationEvidenceWithSession({ accountId: ACCOUNT_ID, session });
    const ctas = result.review_package.shared_account_intelligence.sections.cta_context.facts.related_account_ctas;
    assert.equal(ctas.state, failed ? "query_failed" : "checked");
    assert.deepEqual(ctas.items, []);
    assert.match(ctas.note, failed ? /not available/ : /No open CTAs were returned/);
    assert.equal(result.full_brief_source_states.related_account_ctas, failed ? "query_failed" : "checked");
    assert.ok(result.review_package.shared_account_intelligence.sections.support_operations.facts.metric_table.length > 0);
  }
});

test("the shared core retains product ladder flags and their source snapshot dates", () => {
  const result = buildRenewalConversationBrief({ accountContextRow: {
    ...accountRow, SUITE_ELIGIBLE: true, SUITE_PENETRATED: false, SUITE_ACTIVATED: false,
    SUITE_ADOPTED: false, SUITE_SNAPSHOT_DATE: "2026-09-23", GUIDE_SNAPSHOT_DATE: "2026-09-22",
  } });
  const product = result.shared_account_intelligence.sections.product_footprint.facts;
  assert.deepEqual(product.observed_use_ladders.zendesk_suite, { eligible: true, present_in_usage_footprint: false, activated: false, adopted: false });
  assert.equal(product.source_snapshot_dates.zendesk_suite, "2026-09-23");
  assert.equal(product.source_snapshot_dates.guide, "2026-09-22");
  assert.equal(product.observed_use_ladders.ai_agents_paid.adopted, null);
  assert.match(buildRenewalSuiteAdoptionSql(ACCOUNT_ID), /SOURCE_SNAPSHOT_DATE AS suite_snapshot_date/);
});

test("AI Agents uses the owner-specified source with the existing account and latest-snapshot contract", () => {
  const query = buildRenewalAiAgentsAdoptionSql(ACCOUNT_ID);
  assert.match(query, /FROM FUNCTIONAL\.PRODUCT_ANALYTICS\.AI_AGENTS_CRM_DAILY_SNAPSHOT\b/);
  assert.doesNotMatch(query, /FUNCTIONAL\.PRODUCT_ANALYTICS_V2\.AI_AGENTS_CRM_DAILY_SNAPSHOT/);
  assert.match(query, /WHERE CRM_ACCOUNT_ID = '001000000000000AAA'/);
  assert.match(query, /QUALIFY ROW_NUMBER\(\) OVER \(ORDER BY SOURCE_SNAPSHOT_DATE DESC\) = 1/);
  assert.match(query, /SOURCE_SNAPSHOT_DATE AS ai_agents_snapshot_date/);
  for (const tier of ["PAID", "UNPAID"]) {
    for (const stage of ["PENETRATED", "ACTIVATED", "ADOPTED"]) {
      assert.ok(query.includes(`CRM_IS_AI_AGENTS_${tier}_${stage} AS ai_agents_${tier.toLowerCase()}_${stage.toLowerCase()}`));
    }
  }
  assert.throws(() => buildRenewalAiAgentsAdoptionSql("invented-invalid-id"), /account/i);
});

test("AI Agents replacement-source flags and snapshot reach the shared renewal and meeting-prep core", async () => {
  const queries = [];
  const session = { async query(query) {
    queries.push(query);
    if (query.includes("AI_AGENTS_CRM_DAILY_SNAPSHOT")) {
      assert.match(query, /FROM FUNCTIONAL\.PRODUCT_ANALYTICS\.AI_AGENTS_CRM_DAILY_SNAPSHOT\b/);
      return [{
        AI_AGENTS_SNAPSHOT_DATE: "2026-09-23",
        AI_AGENTS_PAID_PENETRATED: true, AI_AGENTS_PAID_ACTIVATED: true, AI_AGENTS_PAID_ADOPTED: false,
        AI_AGENTS_UNPAID_PENETRATED: false, AI_AGENTS_UNPAID_ACTIVATED: null, AI_AGENTS_UNPAID_ADOPTED: null,
      }];
    }
    return standardRenewalRows(query);
  } };
  const result = await readRenewalConversationEvidenceWithSession({ accountId: ACCOUNT_ID, session });
  const product = result.review_package.shared_account_intelligence.sections.product_footprint.facts;
  assert.equal(result.full_brief_source_states.ai_agents_adoption, "checked");
  assert.deepEqual(product.observed_use_ladders.ai_agents_paid, { paid_product_state: true, activated: true, adopted: false });
  assert.deepEqual(product.observed_use_ladders.ai_agents_unpaid, { available_product_state: false, activated: null, adopted: null });
  assert.equal(product.source_snapshot_dates.ai_agents_paid, "2026-09-23");
  assert.equal(product.source_snapshot_dates.ai_agents_unpaid, "2026-09-23");
  assert.equal(queries.filter(query => query.includes("AI_AGENTS_CRM_DAILY_SNAPSHOT")).length, 1);
});

test("AI Agents replacement-source failure stays a gap without a V2 fallback or loss of other brief facts", async () => {
  const queries = [];
  const session = { async query(query) {
    queries.push(query);
    if (query.includes("AI_AGENTS_CRM_DAILY_SNAPSHOT")) {
      assert.match(query, /FROM FUNCTIONAL\.PRODUCT_ANALYTICS\.AI_AGENTS_CRM_DAILY_SNAPSHOT\b/);
      throw new BetaError("SNOWFLAKE_SESSION_QUERY_FAILED", "Invented source failure", { source_error_type: "ProgrammingError" });
    }
    return standardRenewalRows(query);
  } };
  const result = await readRenewalConversationEvidenceWithSession({ accountId: ACCOUNT_ID, session });
  const core = result.review_package.shared_account_intelligence;
  assert.equal(result.full_brief_source_states.ai_agents_adoption, "query_failed");
  assert.equal(core.sections.product_footprint.facts.observed_use_ladders.ai_agents_paid.adopted, null);
  assert.equal(core.sections.product_footprint.facts.observed_use_ladders.ai_agents_unpaid.adopted, null);
  assert.equal(result.review_package.csm_account_brief.company_profile.industry, "Healthcare");
  assert.ok(core.sections.support_operations.facts.metric_table.length > 0);
  assert.equal(queries.filter(query => query.includes("AI_AGENTS_CRM_DAILY_SNAPSHOT")).length, 1);
  assert.ok(queries.every(query => !query.includes("FUNCTIONAL.PRODUCT_ANALYTICS_V2.AI_AGENTS_CRM_DAILY_SNAPSHOT")));
});

test("the account-context query converts numeric integration flags to boolean conditions", () => {
  const query = buildAccountContextSql(ACCOUNT_ID);
  assert.match(query, /COUNT_IF\(COALESCE\(INSTANCE_HAS_WEBHOOKS_ACTIVE_USAGE, 0\) <> 0\)/);
  assert.match(query, /COUNT_IF\(COALESCE\(INSTANCE_HAS_API_ACTIVE_USAGE, 0\) <> 0\)/);
});

test("the renewal brief preserves the same account-intelligence source contract through small account-scoped statements", () => {
  const fullQuery = buildAccountContextSql(ACCOUNT_ID);
  const gainsightQuery = buildRenewalGainsightAccountContextSql(ACCOUNT_ID);
  const coreQueries = [
    buildRenewalCompanyProfileSql(ACCOUNT_ID),
    buildRenewalAccountTimingSql(ACCOUNT_ID),
    buildRenewalCommercialSubscriptionsSql(ACCOUNT_ID),
    buildRenewalGuideAdoptionSql(ACCOUNT_ID),
    buildRenewalCopilotAdoptionSql(ACCOUNT_ID),
    buildRenewalAiAgentsAdoptionSql(ACCOUNT_ID),
    buildRenewalSuiteAdoptionSql(ACCOUNT_ID),
    buildRenewalBasicToolsAdoptionSql(ACCOUNT_ID),
  ];
  const relatedCtasQuery = buildRenewalRelatedAccountCtasSql(ACCOUNT_ID);
  assert.match(relatedCtasQuery, /status\.IS_OPEN_STATUS = TRUE/);
  assert.doesNotMatch(relatedCtasQuery, /cta\.IS_CLOSED/);
  const ticketChannelsQuery = buildRenewalTicketsByChannelSql(ACCOUNT_ID);
  const setupQuery = buildRenewalTeamAndTechContextSql(ACCOUNT_ID);
  const gongQuery = buildRenewalAccountGongDigestSql(ACCOUNT_ID);
  const gongSpotlightQuery = buildRenewalAccountGongSpotlightSql(ACCOUNT_ID);
  const combined = `${gainsightQuery}\n${coreQueries.join("\n")}\n${ticketChannelsQuery}\n${setupQuery}\n${relatedCtasQuery}\n${gongQuery}\n${gongSpotlightQuery}`;
  assert.match(fullQuery, /GAINSIGHT_COMPANY_BCV/);
  assert.match(combined, /SALESFORCE_ACCOUNT_BCV/);
  assert.match(combined, /GUIDE_ADOPTION_CRM_DAILY_SNAPSHOT/);
  assert.match(combined, /COPILOT_CRM_DAILY_SNAPSHOT/);
  assert.match(combined, /FUNCTIONAL\.PRODUCT_ANALYTICS\.AI_AGENTS_CRM_DAILY_SNAPSHOT/);
  assert.doesNotMatch(combined, /FUNCTIONAL\.PRODUCT_ANALYTICS_V2\.AI_AGENTS_CRM_DAILY_SNAPSHOT/);
  assert.match(combined, /ZENDESK_SUITE_CRM_DAILY_SNAPSHOT/);
  assert.match(combined, /BASIC_TOOLS_AND_RULES_CRM_DAILY_SNAPSHOT/);
  assert.match(combined, /DIM_GROWTH_ENGINE_CUSTOMER_ACCOUNTS/);
  assert.match(combined, /INTEGRATIONS_AND_FLEXIBILITY_INSTANCE/);
  assert.match(combined, /INSTALLED_APPS_SOURCE_DASHBOARD/);
  assert.match(combined, /SECURITY_FEATURES_INSTANCE_DAILY_SNAPSHOT/);
  assert.match(combined, /PRICING_COMM_SUBSCRIPTION/);
  assert.match(combined, /GAINSIGHT_CALL_TO_ACTION_BCV/);
  assert.match(combined, /PRESENTATION\.BULLSEYE_PRO\.CUSTOMERS/);
  assert.match(combined, /CRM_OWNER_NAME AS account_executive/);
  assert.match(combined, /CRM_RENEWAL_OWNER_NAME AS renewal_manager/);
  assert.doesNotMatch(combined, /SALESFORCE_USER_BCV AS account_executive/);
  assert.match(ticketChannelsQuery, /FACT_AGGREGATED_TICKETS_DATA_DAILY_SNAPSHOT/);
  assert.match(ticketChannelsQuery, /TICKET_VIA_ID IN \(5, 66\) THEN 'API'/);
  assert.match(ticketChannelsQuery, /THEN 'Messaging'/);
  assert.match(ticketChannelsQuery, /THEN 'Other'/);
  assert.match(ticketChannelsQuery, /ELSE 'Unknown'/);
  assert.match(ticketChannelsQuery, /DATEADD\(MONTH, -24, CURRENT_DATE\(\)\)/);
  assert.match(combined, /PRESENTATION\.BULLSEYE_PRO\.SALES_ACTIVITY/);
  assert.match(combined, /CRM_IS_ZENDESK_SUITE_ELIGIBLE/);
  assert.match(combined, /CRM_IS_ZENDESK_SUITE_PENETRATED/);
  assert.doesNotMatch(combined, /CRM_IS_SUITE_ELIGIBLE/);
  assert.equal(coreQueries.every((query) => query.includes("WITH account_brief")), false);
  assert.match(gongQuery, /GONG_CONVERSATION_KEY IS NOT NULL/);
  assert.doesNotMatch(gongQuery, /ACTIVITY_DESCRIPTION|GONG_SPOTLIGHT_KEY_POINTS|GONG_SPOTLIGHT_NEXT_STEPS/);
  assert.match(gongSpotlightQuery, /TO_VARCHAR\(ACTIVITY_DESCRIPTION\)/);
  assert.match(gongSpotlightQuery, /TO_VARCHAR\(GONG_SPOTLIGHT_KEY_POINTS\)/);
  assert.match(gongSpotlightQuery, /COALESCE\(/);
  assert.doesNotMatch(gongQuery, /ACTIVITY_SOURCE = 'gong_call'/);
  assert.doesNotMatch(gongQuery, /GONG_CONVERSATION_PARTICIPANTS_BCV|SALESFORCE_CONTACT_FORMULA_BCV|GONG_CALL_TRANSCRIPTS_BCV|CALL_URL/);
  assert.notEqual(buildRenewalAccountContextSql(ACCOUNT_ID), coreQueries[0]);
});

test("a failed commercial source remains visible without erasing the verified company brief", async () => {
  const session = {
    async query(query) {
      if (query.includes("PRICING_COMM_SUBSCRIPTION")) {
        throw new BetaError("SNOWFLAKE_SESSION_QUERY_FAILED", "source failure", {
          source_error_number: 1044,
          source_sqlstate: "42P13",
        });
      }
      return standardRenewalRows(query);
    },
  };
  const result = await readRenewalConversationEvidenceWithSession({ accountId: ACCOUNT_ID, session });
  assert.equal(result.status, "needs_csm_decision");
  assert.equal(result.source_states.account_context, "checked");
  assert.equal(result.full_brief_source_states.commercial_subscriptions, "query_failed");
  assert.equal(result.full_brief_source_states.company_profile, "checked");
  assert.equal(result.review_package.csm_account_brief.company_profile.industry, "Healthcare");
  assert.equal(result.review_package.recommendation_context_verified, false);
  assert.equal(result.statement_executions.length, 18);
  assert.equal(result.full_brief_source_states.account_gong_metadata, "checked");
});

test("a failed Suite snapshot stays a narrow gap and does not erase the renewal brief", async () => {
  const session = {
    async query(query) {
      if (query.includes("ZENDESK_SUITE_CRM_DAILY_SNAPSHOT")) {
        throw new BetaError("SNOWFLAKE_SESSION_QUERY_FAILED", "Suite field failure", {
          source_error_number: 904,
          source_sqlstate: "42000",
        });
      }
      return standardRenewalRows(query);
    },
  };
  const result = await readRenewalConversationEvidenceWithSession({ accountId: ACCOUNT_ID, session });
  assert.equal(result.status, "evidence_ready_with_gaps");
  assert.equal(result.source_states.account_context, "checked");
  assert.equal(result.full_brief_source_states.company_profile, "checked");
  assert.equal(result.full_brief_source_states.suite_adoption, "query_failed");
  assert.equal(result.review_package.csm_account_brief.account_name, "Invented Account");
  assert.match(result.review_package.source_gaps.join(" "), /SUITE_ADOPTION_QUERY_FAILED/);
});

test("an unavailable Gong digest remains a visible full-brief gap without blocking supported renewal hypotheses", async () => {
  const session = {
    async query(query) {
      if (query.includes("PRESENTATION.BULLSEYE_PRO.SALES_ACTIVITY")) throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "slow Gong metadata");
      return standardRenewalRows(query);
    },
  };
  const result = await readRenewalConversationEvidenceWithSession({ accountId: ACCOUNT_ID, session });
  assert.equal(result.status, "evidence_ready_with_gaps");
  assert.equal(result.full_brief_source_states.account_gong_metadata, "timed_out");
  assert.equal(result.review_package.account_context.recent_gong_conversations.state, "timed_out");
  assert.ok(result.review_package.csm_recommendation_options.length > 0);
  assert.ok(result.review_package.source_gaps.includes("ACCOUNT_GONG_METADATA_TIMED_OUT"));
});

test("a failed optional Gong spotlight read preserves verified account-level call metadata", async () => {
  const session = {
    async query(query) {
      if (query.includes("recent_gong_spotlights_json")) {
        throw new BetaError("SNOWFLAKE_SESSION_QUERY_FAILED", "changed spotlight field", {
          source_error_type: "ProgrammingError",
          source_error_number: 1044,
          source_sqlstate: "42P13",
        });
      }
      return standardRenewalRows(query);
    },
  };
  const result = await readRenewalConversationEvidenceWithSession({ accountId: ACCOUNT_ID, session });
  const recentConversations = result.review_package.account_context.recent_gong_conversations;
  const spotlightExecution = result.statement_executions.find((entry) => entry.source === "account_gong_spotlight");
  assert.equal(result.full_brief_source_states.account_gong_metadata, "checked");
  assert.equal(result.full_brief_source_states.account_gong_spotlight, "query_failed");
  assert.equal(recentConversations.state, "checked");
  assert.equal(recentConversations.recent_calls.length, 1);
  assert.equal(recentConversations.recent_calls[0].title, "Invented customer call");
  assert.equal("gong_summary" in recentConversations.recent_calls[0], false);
  assert.equal(spotlightExecution.safe_failure_category, "schema_or_query");
  assert.equal("source_error_number" in spotlightExecution, false);
  assert.equal("source_sqlstate" in spotlightExecution, false);
});

test("a timed-out Suite read retries once without blocking the rest of the account brief", async () => {
  let suiteAttempts = 0;
  const session = {
    async query(query, { onStarted } = {}) {
      onStarted?.({ started_at: "2026-09-22T00:00:00.000Z", queue_wait_ms: 0 });
      if (query.includes("ZENDESK_SUITE_CRM_DAILY_SNAPSHOT")) {
        suiteAttempts += 1;
        if (suiteAttempts === 1) throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "timed out");
      }
      return standardRenewalRows(query);
    },
  };
  const result = await readRenewalConversationEvidenceWithSession({ accountId: ACCOUNT_ID, session });
  assert.equal(result.status, "evidence_ready_with_gaps");
  assert.equal(suiteAttempts, 2);
  assert.deepEqual(result.statement_executions.map((entry) => [entry.source, entry.attempt, entry.safe_outcome]), [
    ["gainsight_account_context", 1, "checked"],
    ["company_profile", 1, "checked"],
    ["renewal_timing", 1, "checked"],
    ["commercial_subscriptions", 1, "checked"],
    ["guide_adoption", 1, "checked"],
    ["copilot_adoption", 1, "checked"],
    ["ai_agents_adoption", 1, "checked"],
    ["suite_adoption", 1, "timed_out"],
    ["basic_tools_adoption", 1, "checked"],
    ["team_and_tech_context", 1, "checked"],
    ["related_account_ctas", 1, "checked"],
    ["rba_metrics", 1, "checked"],
    ["ticket_channels", 1, "checked"],
    ["guide_knowledge_views", 1, "checked"],
    ["peer_benchmarks", 1, "checked"],
    ["account_gong_metadata", 1, "checked"],
    ["account_gong_spotlight", 1, "checked"],
    ["historical_sla_policies", 1, "checked"],
    ["suite_adoption", 2, "checked"],
  ]);
});

test("a slow profile cannot starve peer, Guide or Gong reads and reports safe recovery progress", async () => {
  let clock = 0, profileAttempts = 0;
  const progress = [];
  const session = { async query(query, options = {}) {
    options.onStarted?.({ queue_wait_ms: 0 });
    if (query.includes("SALESFORCE_ACCOUNT_BCV")) {
      profileAttempts += 1;
      clock += 120_000;
      options.onDiagnostics?.({ failure_stage: "fetch_results", statement_execution_ms: 2, fetch_results_ms: 59_998, source_error: "must-not-be-retained" });
      throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "invented source delay", { failure_stage: "fetch_results" });
    }
    clock += 3_000;
    return standardRenewalRows(query);
  } };
  const result = await readRenewalConversationEvidenceWithSession({ accountId: ACCOUNT_ID, session, nowMs: () => clock, onProgress: (event) => progress.push(event) });
  assert.equal(profileAttempts, 2);
  assert.equal(result.statement_executions.at(-1).source, "company_profile");
  for (const source of ["guide_knowledge_views", "peer_benchmarks", "account_gong_metadata", "account_gong_spotlight"]) {
    const execution = result.statement_executions.find((item) => item.source === source);
    assert.equal(execution.safe_outcome, "checked", source);
    assert.equal(execution.attempt, 1, source);
    assert.equal(execution.execution_timeout_ms, 120_000, "A later source must not inherit a nearly exhausted window");
  }
  assert.equal(progress.at(-1).stage, "account_evidence_recovery");
  assert.equal(progress.at(-1).stage_deadline_seconds, 300);
  assert.equal(progress.at(-1).attempt, 2);
  assert.ok(clock < 600_000);
  assert.doesNotMatch(JSON.stringify(result.statement_executions), /must-not-be-retained/);
});

test("renewal focus options use distinct verified capabilities and never invent account context", () => {
  const result = buildRenewalConversationBrief({
    accountContextRow: {
      ...accountRow,
      AI_AGENTS_PAID_PENETRATED: true,
      COMMERCIAL_SUBSCRIPTIONS_JSON: JSON.stringify([
        { product_plan: "Professional", product_line: "Suite", offering: "Copilot", offering_group: "Copilot", status: "Active", term_end: "2027-12-31" },
        { product_plan: "Professional", product_line: "Suite", offering: "AI Agents", offering_group: "AI Agents", status: "Active", term_end: "2027-12-31" },
      ]),
    },
    metricRows: [
      { metric: "Median first reply time", evidence_state: "measured", comparison_state: "comparable", current_value: 3, year_ago_value: 1, year_over_year_change: 2, unit: "hours" },
      { metric: "Zero-touch ticket ratio", evidence_state: "measured", comparison_state: "comparable", current_value: 10, year_ago_value: 30, year_over_year_change: -20, unit: "percent" },
    ],
    sourceStates: { account_context: "checked", ticket_metrics: "checked", rba_metrics: "checked" },
  });
  assert.ok(result.csm_recommendation_options.length >= 3);
  assert.deepEqual(result.csm_recommendation_options.slice(0, 2).map((option) => option.verified_capability.label), ["Intelligent Triage", "AI agents"]);
  assert.equal(new Set(result.csm_recommendation_options.map((option) => option.verified_capability.label)).size, result.csm_recommendation_options.length);
  assert.equal(result.customer_slides[2].cards.length, 0);
  const incomplete = buildRenewalConversationBrief({ metricRows: [], sourceStates: { account_context: "timed_out" } });
  assert.equal(incomplete.account_name, null);
  assert.equal(incomplete.account_context, null);
  assert.equal(incomplete.customer_slides[2].cards.length, 0);
  assert.match(incomplete.customer_slides[2].data_note, /Account context could not be verified/);
});

test("the separate renderer accepts exactly the independent three-slide contract and rejects PPTX", () => {
  const review = buildRenewalConversationBrief({ accountContextRow: accountRow, metricRows: comparableMetrics, sourceStates: { account_context: "checked", ticket_metrics: "checked", rba_metrics: "checked" } });
  const deck = buildRenewalDeckContent({
    reviewPackage: review,
    selectedMetricIds: review.metric_candidates.map((candidate) => candidate.id),
    selectedPairIds: review.opportunity_and_focus_pairs.map((pair) => pair.id),
  });
  const request = {
    rendererBaseline: RENEWAL_CONVERSATION_RENDERER_BASELINE,
    bridgeInput: {
      mode: "build", artifactKind: "renewal_conversation_brief",
      output: { provider: "google_slides", native: true, private_draft_only: true },
      designContract: RENEWAL_CONVERSATION_DESIGN_CONTRACT,
      templateBinding: activeRenewalTemplateBinding(),
      reviewPackage: {
        customer_copy_contract: deck.customer_copy_contract,
        customer_slides: deck.customer_slides,
        private_speaker_notes: deck.private_speaker_notes,
      },
    },
  };
  assert.equal(assertRenewalConversationRendererRequest(request), true);
  request.bridgeInput.output.format = "pptx";
  assert.throws(() => assertRenewalConversationRendererRequest(request), (error) => error.code === "PPTX_OUTPUT_PROHIBITED");
});

test("one evidence-led pair is reviewable and a CSM statement adds a prospective AI Agents option", () => {
  const review = buildRenewalConversationBrief({
    accountContextRow: {
      ...accountRow,
      GUIDE_ELIGIBLE: true,
      GUIDE_ACTIVATED: true,
      GUIDE_ADOPTED: true,
      COPILOT_PAID_PENETRATED: false,
      AI_AGENTS_PAID_PENETRATED: null,
    },
    metricRows: [
      { metric: "Median resolution time", evidence_state: "measured", comparison_state: "comparable", current_value: 48, year_ago_value: 151, year_over_year_change: -103, unit: "hours" },
      { metric: "Zero-touch ticket ratio", evidence_state: "measured", comparison_state: "comparable", current_value: 31.8, year_ago_value: 51.5, year_over_year_change: -19.7, unit: "percent" },
      { metric: "Tickets created", evidence_state: "measured", comparison_state: "comparable", current_value: 19780, year_ago_value: 24695, year_over_year_change: -4915, unit: "tickets" },
    ],
    sourceStates: { account_context: "checked", rba_metrics: "checked", guide_knowledge_views: "checked" },
  });
  assert.equal(review.opportunity_and_focus_pairs.length, 1);
  assert.equal(review.content_readiness.state, "ready_for_csm_selection");
  assert.equal(review.csm_content_review_display.tables[2].rows.length, 1);
  const withCsmContext = addRenewalCsmContext({
    reviewPackage: review,
    metricRows: [
      { metric: "Tickets created", evidence_state: "measured", current_value: 19780, unit: "tickets" },
    ],
    context: "ai_agents_not_in_use",
  });
  assert.equal(withCsmContext.opportunity_and_focus_pairs.length, 2);
  assert.equal(withCsmContext.csm_provided_context.provenance, "csm_statement");
  assert.equal(withCsmContext.csm_provided_context.commercial_access, "not_verified");
  assert.equal(withCsmContext.csm_account_brief.product_context.ai_agents_paid_lifecycle, "Unavailable in the current snapshot");
  assert.equal(withCsmContext.csm_content_review_display.tables[3].id, "csm_provided_context");
  const aiPair = withCsmContext.opportunity_and_focus_pairs[1];
  assert.equal(aiPair.verified_capability.account_access, "not_verified");
  assert.match(aiPair.opportunity.what_the_data_shows, /19,780 human-support tickets/);
  assert.doesNotMatch(JSON.stringify(aiPair.focus), /already using|included in the plan/i);
  const deck = buildRenewalDeckContent({
    reviewPackage: withCsmContext,
    selectedMetricIds: [withCsmContext.metric_candidates[0].id],
    selectedPairIds: withCsmContext.opportunity_and_focus_pairs.map((pair) => pair.id),
  });
  assert.deepEqual(deck.customer_slides.map((slide) => slide.cards.length), [1, 2, 2]);
  assert.equal(assertRenewalConversationRendererRequest({
    rendererBaseline: RENEWAL_CONVERSATION_RENDERER_BASELINE,
    bridgeInput: {
      mode: "build", artifactKind: "renewal_conversation_brief",
      output: { provider: "google_slides", native: true, private_draft_only: true },
      designContract: RENEWAL_CONVERSATION_DESIGN_CONTRACT,
      templateBinding: activeRenewalTemplateBinding(),
      reviewPackage: {
        customer_copy_contract: deck.customer_copy_contract,
        customer_slides: deck.customer_slides,
        private_speaker_notes: deck.private_speaker_notes,
      },
    },
  }), true);
});

test("a CSM statement cannot fill an opportunity without measured ticket evidence", () => {
  const review = buildRenewalConversationBrief({
    accountContextRow: accountRow,
    metricRows: comparableMetrics,
    sourceStates: { account_context: "checked", rba_metrics: "checked" },
  });
  assert.throws(
    () => addRenewalCsmContext({ reviewPackage: review, metricRows: [], context: "ai_agents_not_in_use" }),
    (error) => error.code === "RENEWAL_TICKET_EVIDENCE_REQUIRED",
  );
});

test("CSM AI Agents context stops on an adopted-source conflict", () => {
  const review = buildRenewalConversationBrief({
    accountContextRow: { ...accountRow, AI_AGENTS_PAID_ADOPTED: true },
    metricRows: comparableMetrics,
    sourceStates: { account_context: "checked", rba_metrics: "checked" },
  });
  assert.throws(
    () => addRenewalCsmContext({
      reviewPackage: review,
      metricRows: [{ metric: "Tickets created", evidence_state: "measured", current_value: 400 }],
      context: "ai_agents_not_in_use",
    }),
    (error) => error.code === "RENEWAL_CSM_SOURCE_CONFLICT",
  );
});

test("the renewal renderer refuses a generic or unbound layout", () => {
  assert.throws(
    () => assertRenewalConversationRendererRequest({
      rendererBaseline: RENEWAL_CONVERSATION_RENDERER_BASELINE,
      bridgeInput: { artifactKind: "renewal_conversation_brief", designContract: RENEWAL_CONVERSATION_DESIGN_CONTRACT, templateBinding: { bindingMode: "generic_cards" } },
    }),
    (error) => error.code === "RENEWAL_LAYOUT_BINDING_REQUIRED",
  );
});

test("slower first replies and lower one-touch resolution are opportunities with correct comparisons", () => {
  const review = buildRenewalConversationBrief({
    accountContextRow: accountRow,
    metricRows: [
      { metric: "CSAT score", evidence_state: "measured", comparison_state: "comparable", current_value: 92, year_ago_value: 88, year_over_year_change: 4, unit: "percent" },
      { metric: "Zero-touch ticket ratio", evidence_state: "measured", comparison_state: "comparable", current_value: 20, year_ago_value: 14, year_over_year_change: 6, unit: "percent" },
      { metric: "Median first reply time", evidence_state: "measured", comparison_state: "comparable", current_value: 0.7, year_ago_value: 0.6, year_over_year_change: 0.1, year_over_year_change_pct: 16.6667, unit: "hours" },
      { metric: "One-touch ticket ratio", evidence_state: "measured", comparison_state: "comparable", current_value: 29.6, year_ago_value: 32.9, year_over_year_change: -3.3, unit: "percent" },
    ],
    sourceStates: { account_context: "checked", ticket_metrics: "checked", rba_metrics: "checked" },
  });
  assert.deepEqual(review.metric_candidates.map((candidate) => candidate.metric), ["CSAT score", "Zero-touch ticket ratio"]);
  const firstReply = review.opportunity_and_focus_pairs.find((pair) => pair.id === "pair:metric:median-first-reply-time");
  const oneTouch = review.opportunity_and_focus_pairs.find((pair) => pair.id === "pair:metric:one-touch-ticket-ratio");
  assert.match(firstReply.opportunity.headline, /sooner/i);
  assert.match(firstReply.opportunity.what_the_data_shows, /\+16\.7%/);
  assert.match(oneTouch.opportunity.headline, /back-and-forth/i);
  assert.match(oneTouch.opportunity.what_the_data_shows, /-3\.3 percentage points/);
  assert.doesNotMatch(JSON.stringify(review.metric_candidates), /first reply sooner|one touch/i);
});

test("ticket volume cannot become a strength, capacity claim, or automation recommendation on its own", () => {
  const review = buildRenewalConversationBrief({
    accountContextRow: accountRow,
    metricRows: [
      { metric: "Tickets created", evidence_state: "measured", comparison_state: "comparable", current_value: 400, year_ago_value: 200, year_over_year_change: 200, year_over_year_change_pct: 100, unit: "tickets" },
      { metric: "Tickets solved", evidence_state: "measured", comparison_state: "comparable", current_value: 400, year_ago_value: 200, year_over_year_change: 200, year_over_year_change_pct: 100, unit: "tickets" },
    ],
    sourceStates: { account_context: "checked", ticket_metrics: "checked", rba_metrics: "checked" },
  });
  assert.equal(review.metric_candidates.length, 0);
  assert.doesNotMatch(JSON.stringify(review.opportunity_and_focus_pairs), /capacity|automate|automation/i);
});

test("the frozen content contract rejects duplicate or unreviewed customer stories", () => {
  const review = buildRenewalConversationBrief({
    accountContextRow: accountRow,
    metricRows: comparableMetrics,
    sourceStates: { account_context: "checked", ticket_metrics: "checked", rba_metrics: "checked" },
  });
  assert.throws(
    () => buildRenewalDeckContent({
      reviewPackage: review,
      selectedMetricIds: [review.metric_candidates[0].id],
      selectedPairIds: [review.opportunity_and_focus_pairs[0].id, review.opportunity_and_focus_pairs[0].id, "pair:not-reviewed"],
    }),
    (error) => error.code === "RENEWAL_CONTENT_SELECTION_INVALID",
  );
  assert.throws(
    () => buildRenewalDeckContent({
      reviewPackage: review,
      selectedMetricIds: ["metric:not-reviewed"],
      selectedPairIds: review.opportunity_and_focus_pairs.map((pair) => pair.id),
    }),
    (error) => error.code === "RENEWAL_CONTENT_SELECTION_INVALID",
  );
});
