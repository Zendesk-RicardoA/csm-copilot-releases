import assert from "node:assert/strict";
import test from "node:test";
import { assessAccountIntelligenceCompleteness, buildAccountIntelligenceDisplay as buildBriefDisplay, formatBriefValue } from "../mcp/account-intelligence-display.mjs";
import { ACCOUNT_INTELLIGENCE_CORE_SECTIONS } from "../mcp/core.mjs";
import { buildPeerBenchmarkEvidence } from "../mcp/account-peer-benchmarks.mjs";

// The completeness regressions intentionally inspect full requested details.
// Separate overview tests below assert the actual default the CSM will see.
const fullDetailIds = [...ACCOUNT_INTELLIGENCE_CORE_SECTIONS, "source_states", "source_gaps", "call_specific_context"];
const buildAccountIntelligenceDisplay = (brief, options = {}) => buildBriefDisplay(brief, { displayDetails: fullDetailIds, ...options });

function completeBrief() {
  const checked = (value) => ({ state: "checked", value });
  const facts = {
    account_header: { csm: "Invented CSM", net_arr_usd: 0, health: "Green", cs_segment: "Invented segment", market_segment: "Invented market", region: checked("Invented region"), sub_region: checked("Invented subregion"), account_executive: checked("Invented AE"), arr_band: checked("Invented band"), renewal_date: checked("2027-04-01"), renewal_date_basis: checked("CRM renewal date"), renewal_days_remaining: checked(10), renewal_term: checked("Annual"), renewal_manager: checked("Invented manager"), current_subscription_term_end: checked("2027-04-01") },
    cta_context: { selected_cta: null, related_account_ctas: { state: "checked", items: [], source_limit_reached: false, note: "No open CTAs returned in this read." }, monitor_link: { state: "not_applicable", value: null } },
    company_profile: { industry: "Invented industry", type: "Invented type", summary: "First line | detail\nSecond line", employee_count: 0, hq_city: "Invented city", hq_state: "Invented state", hq_country: "Invented country", website: "https://example.invalid" },
    commercial_footprint: { subscriptions: [{ plan: "Invented plan", offering: "Invented offering", seats: 3 }], seats: checked(3), current_term_summary: [{ plan: "Invented plan", status: "Active", term_end: "2027-04-01" }] },
    product_footprint: { owned: [{ plan: "Invented plan" }], observed_use: { guide: "Activated but not adopted" }, observed_use_ladders: { guide: { eligible: true, activated: true, adopted: false } }, source_snapshot_dates: { guide: "2026-09-23" }, observed_product_usage_coverage: { state: "checked", note: "Invented complete scope" }, verified_capability_eligibility: { invented_capability: false } },
    adoption_gaps: { items: [{ product: "Invented product", current_state: "Activated but not adopted" }] },
    team_and_setup: { active_agents: 2, instance_count: 1, sla_active: false, custom_role_instance_count: 0, basic_rule_types_adopted: 3, seat_allocation: checked("Invented seat allocation") },
    tech_stack: { sso_enabled_instance_count: 0, guide_external_connector_instance_count: 0, marketplace_app_names: ["Invented app"], active_webhook_count: 0, webhook_active_usage_instance_count: 0, api_active_usage_instance_count: 0, max_api_ticket_percent: 0, private_app_count: 0 },
    support_operations: { metric_table: [{ metric: "Invented metric", current_value: 0, unit: "count", definition: "Invented full definition", period: "2026-09", year_ago_period: "2025-09", source: "Invented approved source", evidence_state: "measured", completed_month_trend: [{ period: "2026-08", value: 1 }, { period: "2026-09", value: 0 }] }], ticket_channels: { state: "checked", items: [{ channel: "Invented channel", tickets_created: 1, ticket_share: 1 }], note: "Invented channel scope" } },
    recent_conversations: { recent_calls: [{ call_at: "2026-08-11", title: "Invented call", gong_summary: "Invented summary", key_points: ["Invented point"], next_steps: ["Invented next step"], match_strength: "account context" }], note: "Metadata is navigation context only." },
  };
  return { contract: "AccountIntelligenceCoreV1", account: { display_name: "Invented Orchard", identity_state: "authoritative" }, sections: Object.fromEntries(ACCOUNT_INTELLIGENCE_CORE_SECTIONS.map((id) => [id, { state: "checked", facts: facts[id], note: `Invented ${id} coverage note` }])), source_states: { selected_cta: "not_applicable", cta_monitor_link: "not_applicable", related_account_ctas: "checked", guide_adoption: "checked", goals_and_timeline: "requires_selected_call" }, source_gaps: [], call_specific_context: { state: "requires_selected_call", fields: ["goals", "pain_points"], note: "Selected-call evidence is required." } };
}

test("invented full brief preserves ordered sections, fields, definitions, trends, notes, and false/zero values", () => {
  const brief = completeBrief();
  assert.equal(assessAccountIntelligenceCompleteness(brief).state, "ready");
  const display = buildAccountIntelligenceDisplay(brief);
  assert.deepEqual(display.section_order.slice(0, 10), ACCOUNT_INTELLIGENCE_CORE_SECTIONS);
  for (const value of ["Invented full definition", "Invented approved source", "2025-09", "Aug 2026", "Invented next step", "Invented point", "Invented channel scope", "Invented seat allocation", "https://example.invalid"]) assert.ok(display.markdown.includes(value), value);
  assert.match(display.markdown, /> First line \\\| detail\n> Second line/);
  assert.match(display.markdown, /net ARR usd \| \$0\.00/);
  assert.match(display.markdown, /Guide \| Activated but not adopted \| 2026-09-23/);
  assert.match(display.markdown, /Guide \| eligible \| Yes/);
  assert.match(display.markdown, /Guide \| activated \| Yes/);
  assert.match(display.markdown, /Guide \| adopted \| No/);
  assert.match(display.markdown, /selected CTA \| Not applicable/);
});
test("identical commercial facts appear once while different seat and term evidence stays visible",()=>{
  const brief=completeBrief(),subscription={plan:"Invented plan",product_line:"Invented support",offering:"Invented offering",status:"Active",seats:10,term_end:"2027-04-01"};
  brief.sections.commercial_footprint.facts={subscriptions:[subscription],seats:{state:"checked",value:[{plan:subscription.plan,offering:subscription.offering,seats:10}],note:"Invented contracted-seat note"},current_term_summary:[{plan:subscription.plan,status:"Active",term_end:subscription.term_end}]};
  brief.sections.product_footprint.facts.owned=[subscription];
  const display=buildAccountIntelligenceDisplay(brief).markdown;
  assert.equal(display.split("| Invented plan |").length-1,1);assert.doesNotMatch(display,/subscriptions \/ 1 \/|seats \/ 1 \/|current term summary \/ 1 \/|#### owned/);
  assert.match(display,/Invented contracted-seat note/);
  brief.sections.commercial_footprint.facts.seats.value[0].seats=11;
  assert.match(buildAccountIntelligenceDisplay(brief).markdown,/Seat evidence differs from subscription rows/);
});

test("recent conversations use one table row per call with separate summary, key points and next steps", () => {
  const brief = completeBrief();
  brief.sections.recent_conversations.facts.recent_calls = [
    { call_at: "2030-01-05", title: "Invented discovery", gong_summary: "Invented summary A",
      key_points: JSON.stringify(["Invented point A1", "Invented point A2"]),
      next_steps: JSON.stringify(["Invented action A1", "Invented action A2"]), match_strength: "Invented account match A" },
    { call_at: "2030-01-12", title: "Invented review", gong_summary: "Invented summary B",
      key_points: ["Invented point B1", "Invented point B2"], next_steps: "Invented action B", match_strength: "Invented account match B" },
  ];
  const before = structuredClone(brief);
  const display = buildAccountIntelligenceDisplay(brief);
  const section = display.sections.find(item => item.id === "recent_conversations").markdown;
  assert.match(section, /\| Date \| Call \| Summary \| Key points \| Next steps \| Account match \|/);
  const rows = section.split("\n").filter(line => /^\| 2030-/.test(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[0], "| 2030-01-05 | Invented discovery | Invented summary A | • Invented point A1<br>• Invented point A2 | • Invented action A1<br>• Invented action A2 | Invented account match A |");
  assert.match(rows[1], /Invented review \| Invented summary B \| • Invented point B1<br>• Invented point B2 \| Invented action B/);
  assert.doesNotMatch(section, /#### Call |\["Invented|#### gong summary|#### key points|#### next steps/);
  assert.match(section, /Metadata is navigation context only/);
  assert.deepEqual(brief, before, "Display must not mutate canonical evidence or receipts");
});

test("identical Gong summary and key points are shown once without dropping either column", () => {
  const brief = completeBrief();
  brief.sections.recent_conversations.facts.recent_calls = [{ title: "Invented duplicate",
    gong_summary: JSON.stringify(["Invented shared point one", "Invented shared point two"]),
    key_points: ["Invented shared point one", "Invented shared point two"], next_steps: ["Invented action"] }];
  const section = buildAccountIntelligenceDisplay(brief).sections.find(item => item.id === "recent_conversations").markdown;
  assert.match(section, /Summary \| Key points \| Next steps/);
  assert.match(section, /Same as Key points \| • Invented shared point one<br>• Invented shared point two/);
  assert.equal(section.split("Invented shared point one").length - 1, 1);
  assert.equal(section.split("Invented shared point two").length - 1, 1);
  assert.match(section, /Identical Summary and Key points content is shown once in Key points/);
});

test("empty Gong fields remain missing and a failed metadata read does not imply no calls", () => {
  const brief = completeBrief();
  brief.sections.recent_conversations.facts.recent_calls = [{ title: "Invented missing fields",
    gong_summary: "[]", key_points: [], next_steps: null }];
  let section = buildAccountIntelligenceDisplay(brief).sections.find(item => item.id === "recent_conversations").markdown;
  assert.match(section, /Invented missing fields \| Not returned \| Not returned \| Not returned \| Not established/);
  assert.doesNotMatch(section, /Same as Key points/);
  brief.sections.recent_conversations.state = "timed_out";
  brief.source_states.account_gong_metadata = "timed_out";
  brief.sections.recent_conversations.facts = { recent_calls: [] };
  section = buildAccountIntelligenceDisplay(brief).sections.find(item => item.id === "recent_conversations").markdown;
  assert.match(section, /Call metadata is unavailable from this read/);
  assert.match(section, /Read timed out/);
  assert.doesNotMatch(section, /No calls|No call metadata returned/);
});

test("Gong cells preserve distinct content, malformed list text, table characters and future fields safely", () => {
  const brief = completeBrief();
  brief.sections.recent_conversations.facts.recent_calls = [{ call_at: "2030-01-05",
    title: "Invented <script> | title", gong_summary: "Invented summary\nSecond summary line",
    key_points: JSON.stringify(["Invented <img> & point | one", "Invented point two"]),
    next_steps: "[malformed invented list", match_strength: "Invented match",
    source_note: "Invented additional source note", extra_context: { detail: "Invented nested detail" } }];
  const section = buildAccountIntelligenceDisplay(brief).sections.find(item => item.id === "recent_conversations").markdown;
  assert.match(section, /Invented &lt;script&gt; \\\| title/);
  assert.match(section, /Invented summary<br>Second summary line/);
  assert.match(section, /• Invented &lt;img&gt; &amp; point \\\| one<br>• Invented point two/);
  assert.match(section, /\[malformed invented list/);
  assert.match(section, /source note \| extra context/);
  assert.match(section, /Invented additional source note/);
  assert.match(section, /Invented nested detail/);
  assert.doesNotMatch(section, /<script>|<img>|Same as Key points/);
});

test("Gong tables keep every call and every list item without truncation or merging matching titles", () => {
  const brief = completeBrief();
  brief.sections.recent_conversations.facts.recent_calls = Array.from({ length: 60 }, (_, index) => ({
    call_at: `2030-01-${String(index % 28 + 1).padStart(2, "0")}`, title: "Invented repeated title",
    gong_summary: `Invented summary ${index + 1}`,
    key_points: JSON.stringify(Array.from({ length: 20 }, (_, point) => `Invented point ${index + 1}.${point + 1}`)),
    next_steps: "Invented long action " + "detail ".repeat(100) + `final marker ${index + 1}`,
  }));
  const section = buildAccountIntelligenceDisplay(brief).sections.find(item => item.id === "recent_conversations").markdown;
  assert.equal(section.split("\n").filter(line => /^\| 2030-/.test(line)).length, 60);
  assert.match(section, /Invented summary 60/);
  assert.match(section, /Invented point 60\.20/);
  assert.match(section, /final marker 60/);
});

test("field gaps and missing sections prevent identity-only readiness while retaining successful evidence", () => {
  const brief = completeBrief();
  brief.sections.company_profile.facts.website = null;
  delete brief.sections.tech_stack;
  const result = assessAccountIntelligenceCompleteness(brief);
  assert.equal(result.state, "partial");
  assert.ok(result.gaps.includes("company_profile/website:missing"));
  const display = buildAccountIntelligenceDisplay(brief).markdown;
  assert.match(display, /website \| Not returned \| Value not returned/);
  assert.match(display, /Invented full definition/);
  assert.match(display, /### Tech stack/);
});

test("completed reads distinguish blank values and named coverage limits from source failures", () => {
  const brief = completeBrief();
  brief.sections.company_profile.facts.type = null;
  brief.sections.company_profile.facts.hq_state = null;
  brief.sections.product_footprint.facts.observed_product_usage_coverage.state = "partially_checked";
  brief.source_states.observed_product_usage_coverage = "partially_checked";
  const result = assessAccountIntelligenceCompleteness(brief);
  assert.equal(result.state, "partial");
  assert.equal(result.read_state, "completed");
  assert.deepEqual(result.gap_categories.source_reads, []);
  assert.ok(result.gap_categories.missing_values.includes("company_profile/type:missing"));
  assert.ok(result.gap_categories.coverage_limits.includes("observed_product_usage_coverage:partially_checked"));
  const display = buildAccountIntelligenceDisplay(brief);
  assert.equal(display.read_state, "completed");
  assert.match(display.markdown, /Source reads completed/);
  assert.match(display.markdown, /#### Values not returned/);
  assert.match(display.markdown, /#### Coverage limits/);
  assert.doesNotMatch(display.markdown, /#### Source reads that did not complete/);
  assert.match(display.markdown, /optional metric.*does not block a deck/i);
});

test("failed and unstarted reads remain incomplete without discarding completed sections", () => {
  const brief = completeBrief();
  brief.source_states.company_profile = "timed_out";
  brief.source_states.account_gong_spotlight = "not_run";
  brief.sections.company_profile.state = "timed_out";
  const result = assessAccountIntelligenceCompleteness(brief);
  assert.equal(result.read_state, "partially_completed");
  assert.ok(result.gap_categories.source_reads.includes("company_profile:timed_out"));
  assert.ok(result.gap_categories.source_reads.includes("account_gong_spotlight:not_run"));
  const display = buildAccountIntelligenceDisplay(brief).markdown;
  assert.match(display, /Some source reads did not complete/);
  assert.match(display, /#### Source reads that did not complete/);
  assert.match(display, /Invented full definition/);
  assert.match(display, /Read timed out/);
});

test("valid calculations are usable derived facts, while absent calculated values remain gaps", () => {
  const brief = completeBrief();
  brief.sections.team_and_setup.facts.seat_allocation = {
    state: "calculated", value: "4 of 4 seats used — 1 owner, 3 agents", note: "Invented verified inputs",
  };
  assert.equal(assessAccountIntelligenceCompleteness(brief).state, "ready");
  assert.match(buildAccountIntelligenceDisplay(brief).markdown, /Calculated from verified inputs/);
  brief.sections.team_and_setup.facts.seat_allocation.value = null;
  const result = assessAccountIntelligenceCompleteness(brief);
  assert.equal(result.state, "partial");
  assert.ok(result.gap_categories.missing_values.includes("team_and_setup/seat allocation:missing"));
});

test("unestablished allocation and definition gaps are not described as failed reads", () => {
  const brief = completeBrief();
  brief.sections.team_and_setup.facts.seat_allocation = {
    state: "not_established", value: null, note: "Invented counts do not establish an allocation",
  };
  brief.sections.support_operations.facts.peer_benchmarks = { state: "definition_gap" };
  brief.source_states.peer_benchmarks = "definition_gap";
  const result = assessAccountIntelligenceCompleteness(brief);
  assert.equal(result.read_state, "completed");
  assert.ok(result.gap_categories.unestablished_facts.includes("team_and_setup/seat allocation:not_established"));
  assert.ok(result.gap_categories.definitions.includes("peer_benchmarks:definition_gap"));
  assert.deepEqual(result.gap_categories.source_reads, []);
  const display = buildAccountIntelligenceDisplay(brief).markdown;
  assert.match(display, /#### Facts not established/);
  assert.match(display, /#### Definitions or comparison scope not verified/);
});

test("confirmed peer percentages display account and percentiles consistently without unit gaps", () => {
  const brief = completeBrief();
  const peer = buildPeerBenchmarkEvidence([{ AGGREGATION_MONTH: "2026-09-01", CHOSEN_CLUSTER: "Invented peer scope",
    CHOSEN_CLUSTER_UNIQUE_ACCOUNTS: 50, TICKET_CHANNEL_GROUP: "Invented channel", TICKET_REPLY: "Invented scope",
    CSAT_SCORE: 0.8, THE_25TH_CSAT_SCORE: 0.7, THE_50TH_CSAT_SCORE: 0.9, THE_75TH_CSAT_SCORE: 0.95,
    PERCENT_ZERO_REPLY_TICKETS: 0.25, THE_50TH_PERCENT_ZERO_REPLY_TICKETS: 0.3,
    REOPEN_RATE: 0.01, THE_25TH_REOPEN_RATE: 0, THE_50TH_REOPEN_RATE: 0.02, THE_75TH_REOPEN_RATE: 0.03,
    MEDIAN_FIRST_REPLY_TIME_IN_HOURS: 2, THE_50TH_MEDIAN_FIRST_REPLY_TIME_IN_HOURS: 1 }]);
  brief.sections.support_operations.facts.peer_benchmarks = peer;
  brief.source_states.peer_benchmarks = peer.state;
  const assessment = assessAccountIntelligenceCompleteness(brief);
  assert.equal(assessment.read_state, "completed");
  assert.deepEqual(assessment.gap_categories.definitions, []);
  const display = buildAccountIntelligenceDisplay(brief).markdown;
  assert.match(display, /CSAT score \| % \| 80% \| 70% \| 90% \| 95%/);
  assert.match(display, /Zero-reply tickets \| % \| 25% \| Not returned \| 30%/);
  assert.match(display, /Reopen rate \| % \| 1% \| 0% \| 2% \| 3%/);
  assert.doesNotMatch(display, /Rate scale not verified|Unverified rate|0\.8%|8,000%/);
  assert.match(display, /Median first reply time \| hours \| 2 hours/);
  assert.match(display, /confirmed by the CSM/);
  assert.match(display, /optional metric.*does not block a deck/i);
});

test("invalid peer fractions are visible conflicts, not source failures or fabricated percentages", () => {
  const brief = completeBrief();
  const peer = buildPeerBenchmarkEvidence([{ AGGREGATION_MONTH: "2026-09-01", CHOSEN_CLUSTER: "Invented peer scope",
    CHOSEN_CLUSTER_UNIQUE_ACCOUNTS: 50, CSAT_SCORE: 0.25, THE_50TH_CSAT_SCORE: 0.5, THE_75TH_CSAT_SCORE: 25 }]);
  brief.sections.support_operations.facts.peer_benchmarks = peer;
  brief.source_states.peer_benchmarks = peer.state;
  const assessment = assessAccountIntelligenceCompleteness(brief);
  assert.equal(assessment.read_state, "completed");
  assert.ok(assessment.gap_categories.conflicts.some(gap => gap.includes("CSAT score:invalid_value")));
  assert.deepEqual(assessment.gap_categories.source_reads, []);
  const display = buildAccountIntelligenceDisplay(brief).markdown;
  assert.match(display, /CSAT score \| % \| 25% \| Not returned \| 50% \| Not returned \| Not compared/);
  assert.match(display, /Rate value outside confirmed 0–1 range/);
  assert.doesNotMatch(display, /2,500%|0\.25%/);
});

test("an unconfirmed legacy or future rate remains an explicit unscaled definition gap", () => {
  const brief = completeBrief();
  const item = { metric: "Invented unconfirmed rate", unit: "source rate", current_value: 0.25, p50: 0.5,
    period: "2026-09", cohort: "Invented cohort", state: "definition_gap" };
  brief.sections.support_operations.facts.peer_benchmarks = { state: "partially_checked", source: "Invented source",
    operating_snapshot: [item], comparisons: [item], gap_details: [{ metric: item.metric, state: item.state }] };
  const display = buildAccountIntelligenceDisplay(brief).markdown;
  assert.match(display, /Invented unconfirmed rate \| Unverified rate \| 0\.25/);
  assert.match(display, /Not compared \| Rate scale not verified/);
  assert.doesNotMatch(display, /Invented unconfirmed rate \|[^\n]*25%/);
});

test("inapplicable percentage-point deltas do not create false source gaps", () => {
  const brief = completeBrief();
  brief.sections.support_operations.facts.metric_table = [
    { metric: "Invented duration", unit: "hours", current_value: 0, percentage_point_change: null },
    { metric: "Invented rate", unit: "%", current_value: 0, percentage_point_change: null },
  ];
  const gaps = assessAccountIntelligenceCompleteness(brief).gaps;
  assert.ok(!gaps.some((gap) => gap.includes("metric table / 1 / percentage point change")));
  assert.ok(gaps.some((gap) => gap.includes("metric table / 2 / percentage point change")));
  assert.match(buildAccountIntelligenceDisplay(brief).markdown, /Invented duration \| 0 hours/);
  assert.match(buildAccountIntelligenceDisplay(brief).markdown, /Invented rate — percentage point change \| Value not returned/);
});

test("real adapter metric shapes use readable numbers, units, comparisons and monthly columns", () => {
  const brief = completeBrief();
  brief.sections.support_operations.facts.metric_table = [
    { metric: "First reply", unit: "hours", current_value: 10.224123456, year_ago_value: 2.555,
      year_over_year_change_pct: 300.043252, trend: [{ period: "2026-08", value: 6.98123 }, { period: "2026-09", value: null }] },
    { metric: "One touch", unit: "percent", current_value: 21.3456, year_ago_value: 17.3456,
      percentage_point_change: 4, trend: [{ period: "2026-08", value: 18.92345 }] },
  ];
  const display = buildAccountIntelligenceDisplay(brief);
  assert.match(display.markdown, /First reply \| 10\.2 hours \| 2\.6 hours \| 300\.04%/);
  assert.match(display.markdown, /One touch \| 21\.3% \| 17\.3% \| 4 percentage points/);
  assert.match(display.markdown, /Aug 2026 \| 7 hours/);
  assert.match(display.markdown, /Aug 2026 \| 18\.9%/);
  assert.match(display.markdown, /Sept 2026 \| Not returned/);
  assert.doesNotMatch(display.markdown, /10\.224123456|18\.92345/);
  assert.equal(formatBriefValue(null), "Not returned");
  assert.equal(formatBriefValue(0), "0");
  assert.equal(formatBriefValue(15673.2241, "net_arr_usd"), "$15,673.22");
});

test("source failure and named coverage limit remain distinct from a verified empty CTA result", () => {
  const brief = completeBrief();
  assert.equal(assessAccountIntelligenceCompleteness(brief).state, "ready");
  brief.sections.cta_context.facts.related_account_ctas.state = "query_failed";
  brief.source_states.related_account_ctas = "query_failed";
  brief.sections.product_footprint.facts.observed_product_usage_coverage.state = "partially_checked";
  brief.source_states.observed_product_usage_coverage = "partially_checked";
  brief.source_gaps = ["related_account_ctas:query_failed", "observed_product_usage_coverage:partially_checked"];
  assert.equal(assessAccountIntelligenceCompleteness(brief).state, "partial");
  const display = buildAccountIntelligenceDisplay(brief).markdown;
  assert.match(display, /#### related account CTAs[\s\S]*items \| No verified items returned \| Read failed/);
  assert.match(display, /Product usage coverage[\s\S]*Only the stated coverage was checked/);
});

test("full display keeps the final row and a visible overflow note without summarizing arrays", () => {
  const brief = completeBrief();
  brief.sections.recent_conversations.facts.recent_calls = Array.from({ length: 60 }, (_, index) => ({ title: `Invented conversation ${index + 1}`, gong_summary: `Invented summary ${index + 1}` }));
  brief.sections.cta_context.facts.related_account_ctas.source_limit_reached = true;
  brief.sections.cta_context.facts.related_account_ctas.note = "Additional open CTAs exist; this is a bounded result.";
  const display = buildAccountIntelligenceDisplay(brief).markdown;
  assert.match(display, /Invented conversation 60/);
  assert.match(display, /Invented summary 60/);
  assert.match(display, /Additional open CTAs exist; this is a bounded result/);
  assert.equal(assessAccountIntelligenceCompleteness(brief).state, "partial");
});

test("presentation blocks preserve full section order and do not invent missing product flags", () => {
  const brief = completeBrief();
  brief.sections.product_footprint.facts.observed_use_ladders = { guide: { activated: false }, copilot_paid: { adopted: false, active_seats: 0 } };
  brief.sections.product_footprint.facts.observed_use.copilot_paid = "Not adopted";
  const display = buildAccountIntelligenceDisplay(brief);
  assert.deepEqual(display.sections.map((section) => section.id), display.section_order);
  assert.equal(display.sections.map((section) => section.markdown).join("\n\n"), display.markdown);
  assert.match(display.markdown, /Guide \| activated \| No/);
  assert.match(display.markdown, /Copilot — paid product state \| active seats \| 0/);
  assert.doesNotMatch(display.markdown, /Guide \| adopted \| Not returned|Guide \| active seats \| Not returned|Copilot — paid product state \| activated \| Not returned/);
});

test("all-null histories remain visible gaps without twelve empty monthly rows", () => {
  const brief = completeBrief();
  brief.sections.support_operations.facts.metric_table = [
    { metric: "Knowledge views", unit: "views", current_value: null, trend: Array.from({ length: 12 }, (_, index) => ({ period: `2026-${String(index + 1).padStart(2, "0")}`, value: null })) },
    { metric: "Invented replies", unit: "hours", current_value: 1, trend: [{ period: "202606", value: 0 }, { period: "202608", value: 1 }] },
  ];
  const display = buildAccountIntelligenceDisplay(brief);
  assert.match(display.markdown, /Knowledge views \| Not returned/);
  assert.match(display.markdown, /Jun 2026 \| 0 hours/);
  assert.doesNotMatch(display.markdown, /Jan 2026 \| Not returned|Feb 2026 \| Not returned/);
  assert.equal(display.charts.length, 1);
  assert.ok(assessAccountIntelligenceCompleteness(brief).gaps.some((gap) => gap.includes("current value")));
  assert.match(display.markdown, /Knowledge views — Monthly history \| Value not returned/);
});

test("duplicate months and unrecognized periods stay visible without disagreement between chart and table", () => {
  const brief = completeBrief();
  brief.sections.support_operations.facts.metric_table = [{ metric: "Invented replies", unit: "hours", current_value: 4, trend: [
    { period: "202606", value: 1 }, { period: "2026-07", value: 2 }, { period: "202607", value: 3 },
    { period: "202608", value: 4 }, { period: "unknown", value: 7 },
  ] }];
  const display = buildAccountIntelligenceDisplay(brief);
  assert.match(display.markdown, /Jul 2026 \| Not returned/);
  assert.doesNotMatch(display.markdown, /Jul 2026 \| 2 hours|Jul 2026 \| 3 hours/);
  assert.match(display.markdown, /conflicting values for Jul 2026 remain a gap in both the chart and table/);
  assert.match(display.markdown, /Unrecognized period unknown \| 7 hours/);
  assert.equal(display.charts[0].series[0].points[1].value, null);
});

const mainView = (markdown) => markdown;
function briefWithPeerScopes() {
  const brief = completeBrief();
  brief.sections.support_operations.facts.peer_benchmarks = buildPeerBenchmarkEvidence(["Email", "Voice"].map((channel, index) => ({
    AGGREGATION_MONTH: "2030-01-01", SNAPSHOT_DATE: "2030-02-01", CHOSEN_CLUSTER: "Invented cohort", CHOSEN_CLUSTER_UNIQUE_ACCOUNTS: 40,
    TICKET_CHANNEL_GROUP: channel, TICKET_REPLY: "Invented reply scope",
    MEDIAN_FIRST_REPLY_TIME_IN_HOURS: index + 2, THE_25TH_MEDIAN_FIRST_REPLY_TIME_IN_HOURS: 1,
    THE_50TH_MEDIAN_FIRST_REPLY_TIME_IN_HOURS: index + 1, THE_75TH_MEDIAN_FIRST_REPLY_TIME_IN_HOURS: 4,
    CSAT_SCORE: 0.8, THE_25TH_CSAT_SCORE: 0.7, THE_50TH_CSAT_SCORE: 0.85, THE_75TH_CSAT_SCORE: 0.9,
  })));
  return brief;
}

test("a general brief does not flood the main view with every ticket-type benchmark or choose an arbitrary scope", () => {
  const brief = briefWithPeerScopes(), before = structuredClone(brief);
  const display = buildBriefDisplay(brief);
  assert.equal(display.display_catalog.peer_scopes.length, 2);
  assert.equal(display.presentation_focus.peer_scope_count, 0);
  const main = mainView(display.sections.find(section => section.id === "support_operations").markdown);
  assert.match(main, /all-channels, all-tickets comparison was not returned/);
  assert.doesNotMatch(main, /\| Peer P25|\| Peer median|\| Peer P75|Channel: Email|Channel: Voice/);
  const details = buildBriefDisplay(brief, { displayDetails: ["support_operations"] });
  assert.match(details.markdown, /All returned peer comparisons — 2 scopes/);
  for (const value of ["Channel: Email", "Channel: Voice", "Peer P25", "80%", "Invented cohort", "Invented reply scope"]) assert.ok(details.markdown.includes(value), value);
  assert.deepEqual(brief, before);
});

test("a cached display focus foregrounds only the named metrics and exact peer scopes, retaining all other evidence", () => {
  const brief = briefWithPeerScopes();
  const historical = brief.sections.support_operations.facts.metric_table[0];
  brief.sections.support_operations.facts.metric_table.push({ ...historical, metric: "Invented other metric", current_value: 123, unit: "hours" });
  const all = buildAccountIntelligenceDisplay(brief), before = structuredClone(brief);
  const focus = { metric_refs: all.display_catalog.metrics.filter(item => ["Invented metric", "Median first reply time"].includes(item.name)).map(item => item.ref),
    peer_scope_refs: [all.display_catalog.peer_scopes.find(item => item.channel === "Email").ref] };
  const display = buildBriefDisplay(brief, { displayFocus: focus });
  const main = mainView(display.sections.find(section => section.id === "support_operations").markdown);
  assert.match(main, /Invented metric \| 0/);
  assert.match(main, /Median first reply time \| 2 hours \| 1 hours/);
  assert.doesNotMatch(main, /Invented other metric|CSAT score|Channel: Voice|Peer P25/);
  const details = buildBriefDisplay(brief, { displayFocus: focus, displayDetails: ["support_operations"] });
  for (const value of ["Invented other metric", "CSAT score", "Channel: Voice", "Peer P25", "Invented full definition"]) assert.ok(details.markdown.includes(value), value);
  assert.equal(display.presentation_focus.additional_metric_count, 1);
  assert.equal(display.presentation_focus.additional_peer_scope_count, 1);
  assert.equal(display.charts.length, 1);
  assert.equal(display.additional_charts.length, 1);
  assert.deepEqual(display.charts[0], all.charts[0], "Use the original cached chart, not a reindexed or redrawn version");
  assert.deepEqual(brief, before, "Display focus must not mutate source evidence, states, receipt or metrics");
});

test("invented, stale and malformed display references fail visibly instead of returning a false empty focus", () => {
  const brief = briefWithPeerScopes(), catalog = buildAccountIntelligenceDisplay(brief).display_catalog;
  for (const focus of [{ peer_scope_refs: ["peer:" + "0".repeat(24)] }, { metric_refs: ["metric:" + "0".repeat(24)] },
    { metric_refs: [] }, { metric_refs: "all" }, { arbitrary_filter: "everything" }]) {
    assert.throws(() => buildAccountIntelligenceDisplay(brief, { displayFocus: focus }), { code: "ACCOUNT_BRIEF_DISPLAY_FOCUS_INVALID" });
  }
  const ref = catalog.peer_scopes[0].ref;
  brief.sections.support_operations.facts.peer_benchmarks.operating_snapshot[0].period = "2030-02";
  // Remove the remaining observations in the old scope, not just its first metric.
  brief.sections.support_operations.facts.peer_benchmarks.operating_snapshot = brief.sections.support_operations.facts.peer_benchmarks.operating_snapshot.filter(item => item.channel !== "Email" || item.period === "2030-02");
  assert.throws(() => buildAccountIntelligenceDisplay(brief, { displayFocus: { peer_scope_refs: [ref] } }), { code: "ACCOUNT_BRIEF_DISPLAY_FOCUS_INVALID" });
});

test("display focus cannot conceal conflicts, failures, coverage limits or benchmark truncation", () => {
  const brief = briefWithPeerScopes();
  const peers = brief.sections.support_operations.facts.peer_benchmarks;
  peers.state = "partially_checked"; peers.source_limit_reached = true;
  peers.gap_details.push({ metric: "CSAT score", state: "invalid_value", channel: "Voice" });
  brief.source_states.company_profile = "timed_out";
  brief.source_states.observed_product_usage_coverage = "partially_checked";
  const all = buildAccountIntelligenceDisplay(brief);
  const focused = buildBriefDisplay(brief, { displayFocus: { metric_refs: [all.display_catalog.metrics.find(item => item.name === "Invented metric").ref] } });
  const main = mainView(focused.markdown);
  for (const value of ["Read timed out", "checks cover only", "CSAT score", "Rate value outside confirmed 0–1 range", "Source limit reached"]) assert.ok(main.includes(value), value);
});

test("display refs are bound to the exact evidence, not reusable metric names or another account's peer scope", () => {
  const brief = briefWithPeerScopes(), catalog = buildAccountIntelligenceDisplay(brief).display_catalog;
  const metricFocus = { metric_refs: [catalog.metrics[0].ref] }, peerFocus = { peer_scope_refs: [catalog.peer_scopes[0].ref] };
  for (const change of [
    copy => { copy.account.display_name = "Invented Other Account"; },
    copy => { copy.sections.support_operations.facts.metric_table[0].current_value = 987; },
  ]) {
    const copy = structuredClone(brief); change(copy);
    for (const focus of [metricFocus, peerFocus]) assert.throws(() => buildAccountIntelligenceDisplay(copy, { displayFocus: focus }), { code: "ACCOUNT_BRIEF_DISPLAY_FOCUS_INVALID" });
  }
});

test("conflicting peer rows keep each returned percentile instead of pairing both with the first matching account value", () => {
  for (const [field, metric, value, medians, expected] of [
    ["MEDIAN_FIRST_REPLY_TIME_IN_HOURS", "Median first reply time", 2, [1, 9], ["1 hours", "9 hours"]],
    ["CSAT_SCORE", "CSAT score", 25, [0.4, 0.7], ["40%", "70%"]],
  ]) {
    const brief = completeBrief();
    brief.sections.support_operations.facts.peer_benchmarks = buildPeerBenchmarkEvidence(medians.map((median, index) => ({
      AGGREGATION_MONTH: "2030-01-01", CHOSEN_CLUSTER: "Invented conflict cohort", CHOSEN_CLUSTER_UNIQUE_ACCOUNTS: 50,
      TICKET_CHANNEL_GROUP: "Email", TICKET_REPLY: "Invented scope", [field]: value + (field === "CSAT_SCORE" ? index : 0), [`THE_50TH_${field}`]: median,
    })));
    const all = buildAccountIntelligenceDisplay(brief);
    const focused = buildAccountIntelligenceDisplay(brief, { displayFocus: {
      metric_refs: [all.display_catalog.metrics.find(item => item.name === metric).ref],
      peer_scope_refs: [all.display_catalog.peer_scopes[0].ref],
    } });
    const section = focused.sections.find(item => item.id === "support_operations").markdown;
    const main = mainView(section);
    for (const value of expected) {
      assert.ok(section.includes(value), `Full evidence must retain ${value}`);
      assert.ok(main.includes(value), `Focused conflict must retain ${value}, not choose the first row`);
    }
    assert.match(main, /Conflicting values/);
  }
});

test("duplicate adoption-gap facts point to the product table once, while changed and additional facts remain visible", () => {
  const brief = completeBrief();
  brief.sections.adoption_gaps.facts.items = [{ product: "Guide", current_state: "Activated but not adopted" }];
  let display = buildAccountIntelligenceDisplay(brief);
  assert.equal(display.markdown.split("Activated but not adopted").length - 1, 2, "One value and its definition, not a second gap row");
  assert.match(display.sections.find(section => section.id === "adoption_gaps").markdown, /already shown in Product footprint/);
  brief.sections.adoption_gaps.facts.items.push({ product: "Guide", current_state: "Invented conflicting state" },
    { product: "Guide", current_state: "Activated but not adopted", next_action: "Invented unique review action" });
  display = buildAccountIntelligenceDisplay(brief);
  assert.match(display.markdown, /Invented conflicting state/);
  assert.match(display.markdown, /Invented unique review action/);
});

test("commercial deduplication retains extra subscription, seat and term fields without inferring a zero total", () => {
  const brief = completeBrief();
  brief.sections.commercial_footprint.facts = {
    subscriptions: [{ plan: "Invented plan", offering: "Invented offering", seats: null, source_note: "Invented subscription detail" }],
    seats: { state: "checked", value: [{ plan: "Invented plan", offering: "Invented offering", seats: null, source_note: "Invented seat detail" }] },
    current_term_summary: [{ plan: "Invented plan", term_end: null, source_note: "Invented term detail" }],
  };
  const display = buildAccountIntelligenceDisplay(brief);
  for (const value of ["Invented subscription detail", "Invented seat detail", "Invented term detail"]) assert.ok(display.markdown.includes(value), value);
  assert.doesNotMatch(display.markdown, /seats \| 0/);
  assert.ok(assessAccountIntelligenceCompleteness(brief).gaps.some(gap => gap.includes("seats:missing")));
});

test("identical adoption text with a different failed or conflicting source state is not silently collapsed", () => {
  for (const state of ["timed_out", "query_failed", "conflicting"]) {
    const brief = completeBrief();
    brief.sections.adoption_gaps.state = state;
    brief.sections.adoption_gaps.facts.items = [{ product: "Guide", current_state: "Activated but not adopted" }];
    const section = buildAccountIntelligenceDisplay(brief).sections.find(item => item.id === "adoption_gaps").markdown;
    assert.match(section, /Guide \| Activated but not adopted/);
    assert.doesNotMatch(section, /already shown in Product footprint/);
  }
});

test("verified-source boilerplate is not repeated below every business section", () => {
  const display = buildAccountIntelligenceDisplay(completeBrief());
  const main = mainView(display.markdown);
  assert.equal((main.match(/Verified source read\./g) || []).length, 0);
  assert.match(display.markdown, /Read details for each source/);
});

test("the actual default is concise, tag-free and does not append the full hidden evidence", () => {
  const brief = completeBrief();
  brief.sections.recent_conversations.facts.recent_calls[0].key_points = Array.from({ length: 12 }, (_, index) => `Invented point ${index}: ${"Invented discussion detail. ".repeat(12)}`);
  const before = structuredClone(brief);
  const display = buildBriefDisplay(brief), detailed = buildAccountIntelligenceDisplay(brief);
  assert.equal(display.display_mode, "concise_overview");
  assert.deepEqual(display.section_order.slice(0, 10), ACCOUNT_INTELLIGENCE_CORE_SECTIONS);
  assert.doesNotMatch(display.markdown, /<\/?details>|<\/?summary>|\| Field \| Value|Exact monthly values|Metric definitions, sources and comparison scope|Key points \| Next steps/);
  assert.doesNotMatch(display.markdown, /Invented full definition|Invented point 11:|Verified source read|Source state/);
  assert.match(display.markdown, /Invented next step/);
  assert.match(display.markdown, /\| Product \| Value \|/);
  assert.match(display.markdown, /Guide \| Eligible: Yes; Activated: Yes; Adopted: No/);
  assert.match(display.markdown, /Net ARR \(USD\) \| \$0\.00/);
  assert.match(display.markdown, /Service-level agreements active \| No/);
  assert.match(display.markdown, /\| Date \| Call \| Summary \|/);
  assert.ok(display.markdown.length < detailed.markdown.length * 0.6, "The overview must be substantially shorter than requested full evidence");
  assert.deepEqual(display.charts, detailed.charts);
  assert.deepEqual(brief, before);
});

test("default benchmarks use one exact All/All scope, not eleven ticket-type tables", () => {
  const brief = completeBrief();
  brief.sections.support_operations.facts.peer_benchmarks = buildPeerBenchmarkEvidence(Array.from({ length: 11 }, (_, index) => ({
    AGGREGATION_MONTH: "2030-01-01", SNAPSHOT_DATE: "2030-02-01", CHOSEN_CLUSTER: "Invented cohort", CHOSEN_CLUSTER_UNIQUE_ACCOUNTS: 40,
    TICKET_CHANNEL_GROUP: index ? `Invented channel ${index}` : "All", TICKET_REPLY: index ? "With reply" : "All",
    MEDIAN_FIRST_REPLY_TIME_IN_HOURS: index + 2, THE_50TH_MEDIAN_FIRST_REPLY_TIME_IN_HOURS: index + 1,
  })));
  const display = buildBriefDisplay(brief), section = display.sections.find(item => item.id === "support_operations").markdown;
  assert.equal(display.presentation_focus.peer_scope_count, 1);
  assert.equal(display.presentation_focus.additional_peer_scope_count, 10);
  assert.equal((section.match(/\| Metric \| Account \| Peer median/g) || []).length, 1);
  assert.match(section, /Channel: All\. Reply scope: All/);
  assert.doesNotMatch(section.split("#### Operating snapshot and peer comparison")[1], /Invented channel|Peer P25|Peer P75|agreed target/);
  assert.match(section, /middle value \(P50\), not an average/);
  const details = buildBriefDisplay(brief, { displayDetails: ["support_operations"] });
  assert.match(details.markdown, /Invented channel 10/);
  assert.equal((details.markdown.match(/\| Metric \| Unit \| Account/g) || []).length, 11);
});

test("two overall peer cohorts require a choice and are never merged or arbitrarily selected", () => {
  const brief = completeBrief();
  brief.sections.support_operations.facts.peer_benchmarks = buildPeerBenchmarkEvidence(["Invented cohort A", "Invented cohort B"].map((cohort, index) => ({
    AGGREGATION_MONTH: "2030-01-01", CHOSEN_CLUSTER: cohort, TICKET_CHANNEL_GROUP: "All", TICKET_REPLY: "All",
    MEDIAN_FIRST_REPLY_TIME_IN_HOURS: 2, THE_50TH_MEDIAN_FIRST_REPLY_TIME_IN_HOURS: index + 1,
  })));
  const display = buildBriefDisplay(brief);
  assert.equal(display.presentation_focus.peer_scope_count, 0);
  assert.match(display.markdown, /More than one all-channels, all-tickets peer group/);
  assert.doesNotMatch(display.markdown, /\| Metric \| Account \| Peer median/);
});

test("call overview uses key points and next steps; complete notes remain available on request", () => {
  const brief = completeBrief();
  brief.sections.recent_conversations.facts.recent_calls = [{ call_at: "2030-01-05", title: "Invented long call",
    gong_summary: JSON.stringify(["Invented support routing topic. " + "invented detail ".repeat(100), "Invented final summary marker"]),
    key_points: ["Invented key point marker"], next_steps: ["Invented next action marker"] }];
  const before = structuredClone(brief), display = buildBriefDisplay(brief);
  const section = display.sections.find(item => item.id === "recent_conversations").markdown;
  const row = section.split("\n").find(line => line.startsWith("| 2030-"));
  assert.ok(row.split(/\s+/).length < 55);
  assert.match(section, /\| Date \| Call \| Summary \| Next steps \|/);
  assert.match(section, /Invented key point marker/);
  assert.match(section, /Invented next action marker/);
  assert.doesNotMatch(section, /final summary marker/);
  const details = buildBriefDisplay(brief, { displayDetails: ["recent_conversations"] });
  assert.equal(display.conversation_briefing.enabled, true);
  assert.equal(details.conversation_briefing.enabled, false);
  for (const marker of ["final summary marker", "key point marker", "next action marker"]) assert.ok(details.markdown.includes(marker));
  assert.doesNotMatch(details.markdown, /<\/?details>|<\/?summary>/);
  assert.deepEqual(brief, before);
});

test("call overview reviews later pain points rather than clipping introductions", () => {
  const brief = completeBrief();
  brief.sections.recent_conversations.facts.recent_calls = [{ call_at: "2030-01-05", title: "Invented discovery",
    gong_summary: "Introductions: The invented coordinator explains the purpose of the meeting.",
    key_points: JSON.stringify([
      "Introductions: The invented team introduces its roles.",
      "Product overview: Several support features were demonstrated.",
      "Manual review: Agents read every request and repeat information in another system.",
      "Customer goal: Reduce time spent resolving requests over the next six months.",
    ]), next_steps: JSON.stringify(["The invented coordinator will share an account audit.", "The team will arrange a tailored demonstration."]) }];
  const before = structuredClone(brief);
  const display = buildBriefDisplay(brief), section = display.sections.find(item => item.id === "recent_conversations").markdown;
  assert.match(section, /Agents read every request/);
  assert.match(section, /Reduce time spent resolving requests/);
  assert.match(section, /share an account audit/);
  assert.match(section, /arrange a tailored demonstration/);
  assert.doesNotMatch(section, /introduces its roles|explains the purpose|The summary describes|The notes say|Product overview:/);
  assert.equal(display.conversation_briefing.source_path, "account_brief.sections.recent_conversations.facts.recent_calls");
  assert.equal(display.conversation_briefing.evidence_changed, false);
  assert.equal(display.conversation_briefing.approvals_changed, false);
  assert.deepEqual(brief, before);
});

test("call overview keeps actions on their own call and preserves proposed versus agreed wording", () => {
  const brief = completeBrief();
  brief.sections.recent_conversations.facts.recent_calls = [
    { call_at: "2030-01-05", title: "Invented repeated title", key_points: ["Challenge: Agents cannot find current answers."],
      next_steps: ["A pilot may be considered; no launch date was agreed."] },
    { call_at: "2030-01-12", title: "Invented repeated title", key_points: ["Challenge: Routing delays first replies."],
      next_steps: ["The invented coordinator will send the routing review by 18 January."] },
  ];
  const section = buildBriefDisplay(brief).sections.find(item => item.id === "recent_conversations").markdown;
  const rows = section.split("\n").filter(line => line.startsWith("| 2030-"));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /cannot find current answers.*may be considered; no launch date was agreed/);
  assert.doesNotMatch(rows[0], /18 January/);
  assert.match(rows[1], /Routing delays first replies.*18 January/);
  assert.doesNotMatch(rows[1], /pilot/);
});

test("missing next steps stay missing even when a key point mentions a possible action", () => {
  const brief = completeBrief();
  brief.sections.recent_conversations.facts.recent_calls = [{ title: "Invented missing actions",
    key_points: ["Challenge: Manual classification takes time.", "A workshop could help."], next_steps: "[]" }];
  const section = buildBriefDisplay(brief).sections.find(item => item.id === "recent_conversations").markdown;
  assert.match(section, /Next steps/);
  assert.match(section, /Not recorded in the returned notes/);
  assert.doesNotMatch(section, /No next steps|Agreed workshop/);
});

test("short call overviews expose overflow and retain every action and source note in full details", () => {
  const brief = completeBrief();
  brief.sections.recent_conversations.facts.recent_calls = [{ call_at: "2030-01-05", title: "Invented long actions",
    key_points: ["Challenge: The invented queue needs manual routing."],
    next_steps: Array.from({ length: 5 }, (_, index) => `Invented action ${index + 1}: Review workstream ${index + 1}.`) }];
  const before = structuredClone(brief);
  const overview = buildBriefDisplay(brief).sections.find(item => item.id === "recent_conversations").markdown;
  assert.match(overview, /\+2 more recorded steps/);
  assert.doesNotMatch(overview, /workstream 5/);
  const details = buildBriefDisplay(brief, { displayDetails: ["recent_conversations"] }).markdown;
  for (let index = 1; index <= 5; index++) assert.ok(details.includes(`workstream ${index}`));
  assert.deepEqual(brief, before);
});

test("call overview escapes source text and retains summary-only fallback without inventing detail", () => {
  const brief = completeBrief();
  brief.sections.recent_conversations.facts.recent_calls = [{ call_at: "2030-01-05", title: "Invented <script> | title",
    gong_summary: "The team discussed manual routing | delays and <unsafe> text.", key_points: null, next_steps: "[malformed action" }];
  const section = buildBriefDisplay(brief).sections.find(item => item.id === "recent_conversations").markdown;
  assert.match(section, /manual routing \\\| delays and &lt;unsafe&gt; text/);
  assert.match(section, /\[malformed action/);
  assert.doesNotMatch(section, /<script>|<unsafe>/);
});

test("channel month goes in its heading and common metric sources appear once", () => {
  const brief = completeBrief();
  brief.sections.support_operations.facts.ticket_channels.period = "2026-09-01";
  const metric = brief.sections.support_operations.facts.metric_table[0];
  brief.sections.support_operations.facts.metric_table.push({ ...metric, metric: "Invented second metric" });
  const section = buildBriefDisplay(brief).sections.find(item => item.id === "support_operations").markdown;
  assert.match(section, /#### Ticket channels — Sept 2026/);
  assert.doesNotMatch(section, /\| period \||\| Field \|/);
  assert.equal(section.split("Invented approved source").length - 1, 1);
  assert.doesNotMatch(section, /Aug 2026 \| 1|Exact monthly values/);
});

test("native Month ending labels and an unavailable optional metric do not repeat dates in every row", () => {
  const brief = completeBrief(), metric = brief.sections.support_operations.facts.metric_table[0];
  metric.period = "Month ending 2026-09"; metric.year_ago_period = "Year-ago month ending 2025-09";
  brief.sections.support_operations.facts.metric_table.push({ metric: "Invented absent optional", period: "Month ending unavailable", year_ago_period: "Year-ago month ending unavailable", current_value: null, unit: "views" });
  const section = buildBriefDisplay(brief).sections.find(item => item.id === "support_operations").markdown;
  assert.match(section, /Support performance — Sept 2026/);
  assert.match(section, /Year-ago comparison: 2025-09/);
  assert.doesNotMatch(section, /Month ending|Year-ago month ending|\| Periods \|/);
});

test("annual summaries use complete measured months, not a latest-month comparison labelled annual", () => {
  const brief = completeBrief();
  const metric = { metric: "Tickets created", unit: "tickets", current_value: 2, year_ago_value: 1, source: "Invented source",
    trend: Array.from({ length: 24 }, (_, index) => ({ period: `${2028 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`, value: index < 12 ? 1 : 2 })) };
  brief.sections.support_operations.facts.metric_table = [metric];
  let display = buildBriefDisplay(brief);
  assert.match(display.markdown, /24 tickets in Jan 2029–Dec 2029\. Previous 12 months: 12; 100% change/);
  metric.trend[3].value = 0;
  assert.match(buildBriefDisplay(brief).markdown, /Previous 12 months: 11/);
  metric.trend[15].value = null;
  display = buildBriefDisplay(brief);
  assert.match(display.markdown, /23 measured months.*full annual comparison is not available/);
  assert.doesNotMatch(display.markdown, /24 tickets in|Previous 12 months:/);
  metric.trend = metric.trend.slice(-12).map(point => ({ ...point, value: 0 }));
  assert.match(buildBriefDisplay(brief).markdown, /0 tickets in Jan 2029–Dec 2029/);
  assert.doesNotMatch(buildBriefDisplay(brief).markdown, /Previous 12 months:/);
});

test("ordinary repeated gaps become a short note, not dozens of repeated coverage rows", () => {
  const brief = completeBrief();
  brief.source_states.ai_agents_adoption = "query_failed";
  brief.source_states.observed_product_usage_coverage = "partially_checked";
  brief.sections.product_footprint.facts.observed_product_usage_coverage.state = "partially_checked";
  brief.sections.team_and_setup.facts.seat_allocation = { state: "not_established", value: null };
  brief.source_gaps = Array.from({ length: 30 }, (_, index) => `company_profile/invented field ${index}:missing`);
  const display = buildBriefDisplay(brief), section = display.sections.find(item => item.id === "source_gaps").markdown;
  assert.ok(section.split(/\s+/).length <= 85, section);
  assert.match(section, /Read failed: AI Agents adoption/);
  assert.match(section, /Seat allocation is not established/);
  assert.doesNotMatch(section, /\| Area \||Only the stated coverage was checked|invented field 29/);
  assert.match(buildBriefDisplay(brief, { displayDetails: ["source_gaps"] }).markdown, /invented field 29/);
  assert.ok(display.gap_categories.missing_values.length >= 30);
});

test("detail requests are bounded and do not accept unknown, duplicate or malformed sections", () => {
  for (const details of [[], "all", ["unknown"], ["support_operations", "support_operations"]]) {
    assert.throws(() => buildBriefDisplay(completeBrief(), { displayDetails: details }), { code: "ACCOUNT_BRIEF_DISPLAY_DETAILS_INVALID" });
  }
});

test("the selected-call overlay stays accurate in both concise and detailed views", () => {
  const brief = completeBrief();
  const pending = buildBriefDisplay(brief, { callContext: { state: "selected_pending", note: "Invented selected-call note" } });
  assert.match(pending.markdown, /call is selected and authorized/);
  assert.doesNotMatch(pending.markdown, /need a selected call/);
  const analyzed = buildBriefDisplay(brief, { callContext: { state: "available", finding_count: 4 } });
  assert.match(analyzed.markdown, /Selected-call findings are available for review/);
  const expired = buildBriefDisplay(brief, { callContext: { state: "unavailable" } });
  assert.match(expired.markdown, /receipt cannot restore expired findings/);
});

test("a combined source failure is visible unless its named underlying failure is already reported", () => {
  const brief = completeBrief();
  brief.source_states.company_profile_products_adoption = "timed_out";
  let limits = buildBriefDisplay(brief).sections.find(item => item.id === "source_gaps").markdown;
  assert.match(limits, /Read timed out: Combined account coverage/);
  brief.source_states.company_profile = "timed_out";
  limits = buildBriefDisplay(brief).sections.find(item => item.id === "source_gaps").markdown;
  assert.match(limits, /Read timed out: Company profile/);
  assert.doesNotMatch(limits, /Combined account coverage/);
});

test("a zero prior annual total is preserved without an infinite or invented percentage change", () => {
  const brief = completeBrief();
  brief.sections.support_operations.facts.metric_table = [{ metric: "Tickets created", unit: "tickets", current_value: 2,
    trend: Array.from({ length: 24 }, (_, index) => ({ period: `${2028 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`, value: index < 12 ? 0 : 2 })) }];
  const display = buildBriefDisplay(brief);
  assert.match(display.markdown, /Previous 12 months: 0/);
  assert.match(display.markdown, /percentage change unavailable \(previous total is zero\)/);
  assert.doesNotMatch(display.markdown, /Infinity|NaN/);
});
