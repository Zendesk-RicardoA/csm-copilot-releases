# Customer-led slide wording

Status: mandatory local contract. Example wording approved in chat on 2026-10-12;
not installed or accepted as rendered quality.
Applies to renewal preparation and recommendations. Read before preparing or revising customer
wording. This does not authorize a draft, a private-builder update, installation or release.

Shared contract: `customer-outcome-v2` in `native-review-v6`.
Renewal copy: `RenewalCustomerHeroCopyV2`; renewal content schema: `2.0.0`.

## One story, three different jobs

- **Evidence:** what was measured, with the correct values, units and comparison dates.
- **Significance:** why the evidence matters for customers or the team's work.
- **Proposed benefit:** the customer outcome the recommended action supports, with the relevant
  Zendesk capability as its enabler.

The customer is the hero. Zendesk helps them make progress; the product is not the main story.
Use short, direct sentences. Do not imply that a trend proves its cause or that a proposed benefit
has already happened. Never turn a missing measurement into a result or an unsupported promise.
Removing repetitive hedging is not permission to hide a material uncertainty or access limitation.

## Renewal: exactly three slides

1. **Your progress over the past year:** keep the fixed heading. Update only the subtitle and
   selected cards. Each card has an outcome headline, exact metric comparison and short reason
   that progress matters. A higher one-touch ratio means a higher share of requests was resolved
   in one exchange, not proof that more people used self-service. More knowledge views are an
   engagement result, not proof of avoided contacts.
2. **Opportunities to build on:** show the observed trend and the operational or customer benefit
   worth pursuing. Explain the opportunity, not merely the definition of the metric. Keep proposed
   causes and validation questions in the linked private notes.
3. **Where to focus next:** each numbered card has `focus_area` and **one** `customer_benefit`.
   Phrase the benefit of the recommended action, naming its reviewed supporting Zendesk capability.
   Do not print the four planning sections, repeat the metric, or add a CSM checklist.

Owner-reviewed invented focus examples (preserve these exact strings for the matching pairs):

| Focus area | Customer benefit |
| --- | --- |
| A faster first reply | Give customers a quicker first reply through smarter routing with Intelligent Triage. |
| Quicker resolutions | Resolve requests faster with Auto Assist guiding your agents through support procedures. |
| Easier self-service | Make trusted answers easier to find in Help Center search with Knowledge Connectors, so customers can help themselves. |

Use this natural, benefit-led style for other grounded recommendations too. Avoid repeatedly
joining a long outcome and capability list with “supported by.” These are reviewed examples,
not mandatory products or claims for every account. Select a capability from verified evidence,
not from this table, and do not replace a different customer's approved wording with an example.
This example approval does not approve a customer's case wording. A prospective capability
evaluation must still read as proposed; it must not imply an unverified entitlement or deployment.

Preserve `why_it_matters_now`, `practical_next_step`, `how_zendesk_can_help`,
`expected_outcome_if_confirmed`, selected capability and evidence roots in the linked private
`recommendation_details`. Keep validation questions and commercial checks there too. The visible
benefit and private detail are frozen together before customer-content approval. Do not silently
convert a V1 request or reuse its wording approval for changed V2 content.

## Recommendations: “What this means”

Explain one clear customer or operational implication, connecting it to the reviewed goal or
recommendation. Do not repeat the chart or turn the box into a talk track. Start with one concise
takeaway. Add a second point only if it has a different, relevant job; never fill every available
slot just because it exists. Keep each box's purpose distinct across the deck.

Owner-reviewed invented takeaways:

| Box | Exact wording |
| --- | --- |
| Ticket volume | Customers need reliable support in busy months as well as quieter ones. |
| First reply time | An earlier first reply gives customers an update while they wait for a resolution. |
| Operational snapshot | A quick reply matters most when it helps customers move closer to a resolution. |
| Peer comparison | Alongside strong ticket output, there’s room to give customers quicker help and a better support experience. |

Adapt the implication to the account evidence and reviewed goal; do not paste these invented
takeaways into unrelated customer cases. For an included peer slide, keep `peer_insight_1` non-empty
and reviewed. Set unused `peer_insight_2` through `peer_insight_5` explicitly to null so the renderer
removes their native text shapes. Empty strings are invalid, not removal instructions. Never remove
a genuinely relevant second point merely to meet this example's count.

Exact values belong in the chart or comparison table. Keep metric definitions, median/average
distinctions, dates and units in their relevant labels or concise footnotes, not as the whole
interpretation. A peer comparison is not evidence of staffing capacity, a cause or an agreed target.
Actions, owners and timing belong in their plan sections; they must agree with the goal and benefits.

Missing CSAT, benchmarks or other optional metrics must not block a grounded plan. Omit unavailable
metrics and their empty frames or legends. If no grounded implication can be stated, raise that
content-review gap; do not fill the box with generic reassurance or invented analysis.

## Review and rendering

Before approval, verify meaning, evidence links, capability eligibility, concise wording and native
fit. Compare every revision with the rejected copy. Show the exact customer copy for review.
For renewal, the native subtitle is a short customer-facing line, not all selected headlines joined
into a paragraph. The complete annual context stays in CSM review data and private notes; all
selected progress cards remain visible. The existing private builder returns its actual template
dimensions/styles through a read-only, customer-content-free capture. `beta_bind_renewal_native_fit`
checks every chosen subtitle and card using the shared fit estimator before `review_ready` or any
wording approval. Missing, expired, mismatched or overflowing native geometry stops visibly.
The source fingerprint, exact content digest and layout digest are checked again before copying.
Changed wording requires fresh customer-content approval, but not repeated unchanged earlier gates.
Draft authorization and rendered human review remain separate.

Both controls and builders use the shared contract. Render approved strings exactly; never shorten,
rewrite, rephrase, add claims or transfer approval to new content while rendering. Reject mismatched
versions before writing. Fixed-value tests protect known wording failures and preserve metric data;
the conservative wording guards do not certify relevance, causality or customer quality. Those
still require CSM review of the complete rendered deck.
