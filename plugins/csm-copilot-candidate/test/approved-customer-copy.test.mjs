import test from "node:test";
import assert from "node:assert/strict";
import Native from "../mcp/approved-native-contract.js";
import { buildRenewalConversationBrief, buildRenewalDeckContent } from "../mcp/renewal-conversation-brief.mjs";
import { validateMeetingPrepBuildContract } from "../mcp/meeting-prep-build-contract.mjs";
import { inventedMeetingPrepDraft } from "./fixtures/meeting-prep-draft-input.mjs";

// Independent invented evidence and owner-reviewed literal expectations.
// Never import the expected wording from the producer under test.
const account = {
  ACCOUNT_NAME: "Invented Account", GUIDE_ELIGIBLE: true, GUIDE_ACTIVATED: true, GUIDE_ADOPTED: false,
  COPILOT_PAID_PENETRATED: true, TECH_STACK_GUIDE_EXTERNAL_CONNECTOR_INSTANCE_COUNT: 1,
  COMMERCIAL_SUBSCRIPTIONS_JSON: JSON.stringify([{ product_plan: "Professional", product_line: "Suite", offering: "Copilot", offering_group: "Copilot", status: "Active", term_end: "2027-12-31" }]),
};
const metrics = [
  { metric: "One-touch ticket ratio", evidence_state: "measured", comparison_state: "comparable", current_value: 27, year_ago_value: 22, year_over_year_change: 5, unit: "percent" },
  { metric: "Median first reply time", evidence_state: "measured", comparison_state: "comparable", current_value: 1.8, year_ago_value: 0.9, year_over_year_change: 0.9, year_over_year_change_pct: 100, unit: "hours" },
  { metric: "Median resolution time", evidence_state: "measured", comparison_state: "comparable", current_value: 48, year_ago_value: 30, year_over_year_change: 18, year_over_year_change_pct: 60, unit: "hours" },
  { metric: "Zero-touch ticket ratio", evidence_state: "measured", comparison_state: "comparable", current_value: 9, year_ago_value: 20, year_over_year_change: -11, unit: "percent" },
];
const review = (row = account) => buildRenewalConversationBrief({ accountContextRow: row, metricRows: metrics, sourceStates: { account_context: "checked", rba_metrics: "checked" } });

test("renewal produces the exact three approved natural benefit cards without changing evidence or private planning", () => {
  const before = structuredClone(metrics);
  const deck = buildRenewalDeckContent({ reviewPackage: review(), selectedMetricIds: ["metric:one-touch-ticket-ratio"], selectedPairIds: ["pair:metric:median-first-reply-time", "pair:metric:median-resolution-time", "pair:metric:zero-touch-ticket-ratio"] });
  assert.deepEqual(deck.customer_slides[2].cards, [
    { number: 1, focus_area: "A faster first reply", customer_benefit: "Give customers a quicker first reply through smarter routing with Intelligent Triage." },
    { number: 2, focus_area: "Quicker resolutions", customer_benefit: "Resolve requests faster with Auto Assist guiding your agents through support procedures." },
    { number: 3, focus_area: "Easier self-service", customer_benefit: "Make trusted answers easier to find in Help Center search with Knowledge Connectors, so customers can help themselves." },
  ]);
  assert.equal(deck.customer_slides[0].title, "Your progress over the past year");
  assert.equal(deck.customer_slides[0].cards[0].metric_comparison, "27.0% now vs 22.0% a year earlier (+5.0 percentage points)");
  assert.deepEqual(deck.customer_slides[1].cards.map(card => card.what_the_data_shows), [
    "1.8 hours now vs 0.9 hours a year earlier (+100.0%)",
    "48.0 hours now vs 30.0 hours a year earlier (+60.0%)",
    "9.0% now vs 20.0% a year earlier (-11.0 percentage points)",
  ]);
  assert.deepEqual(metrics, before);
  assert.equal(Native.renewalFocusNotesIssue(deck.customer_slides[2].cards, deck.private_speaker_notes[2]), null);
  assert.match(deck.private_speaker_notes[2].recommendation_details[0].practical_next_step, /Review the request types/);
  assert.match(deck.private_speaker_notes[2].recommendation_details[2].how_zendesk_can_help, /^Use Knowledge Connectors/);
});

test("approved benefit examples are not reused for a different capability or missing commercial evidence", () => {
  const result = review({ ...account, COPILOT_PAID_PENETRATED: false, COMMERCIAL_SUBSCRIPTIONS_JSON: "[]" });
  assert.equal(result.opportunity_and_focus_pairs.some(pair => ["intelligent_triage", "auto_assist"].includes(pair.verified_capability.key)), false);
  assert.doesNotMatch(JSON.stringify(result.opportunity_and_focus_pairs), /smarter routing with Intelligent Triage|Auto Assist guiding your agents/);
});

test("one reviewed peer takeaway permits explicit removal of unused lines, not empty or unreviewed text", () => {
  const record = { revision: 1, account_ref_digest: "a".repeat(64), account_intelligence_core: { content_digest: "b".repeat(64), account_ref_digest: "a".repeat(64) }, derived_evidence: { digest: "c".repeat(64) } };
  const input = inventedMeetingPrepDraft(record);
  input.metricSlidePlan.peer_comparison = { include: true };
  input.projection.templateFields.peer_comparison = {
    peer_insight_1: "Alongside strong ticket output, there’s room to give customers quicker help and a better support experience.",
    peer_insight_2: null, peer_insight_3: null, peer_insight_4: null, peer_insight_5: null,
  };
  const before = structuredClone(input);
  assert.equal(validateMeetingPrepBuildContract(input), true);
  assert.deepEqual(input, before);
  for (const n of [2, 3, 4, 5]) {
    assert.equal(Native.valueIssue("peer_comparison", `peer_insight_${n}`, null), null);
    assert.equal(Native.valueIssue("peer_comparison", `peer_insight_${n}`, ""), "MISSING_SEMANTIC_VALUE");
  }
  assert.equal(Native.valueIssue("peer_comparison", "peer_insight_1", null), "MISSING_SEMANTIC_VALUE");
  input.projection.templateFields.peer_comparison.peer_insight_2 = "Review: track FRT, CSAT, and throughput monthly.";
  assert.throws(() => validateMeetingPrepBuildContract(input), { code: "CUSTOMER_IMPLICATION_REVIEW_REQUIRED" });
});
