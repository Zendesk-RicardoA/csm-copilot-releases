# Native render review

These rules apply to the existing private Google Slides renderer, not to account-brief display.
Do not install, deploy, alter a private builder or create an artifact without the specific user action.

## Supporting templates

The user-approved allowlist is numbered slides 8, 11, 12, 14, 16 and 17 of the approved v3 master.
All six are templates. Include a supporting module only when it has a relevant, distinct narrative
job; zero, one or multiple modules per phase are valid. Do not substitute template 10, 13, 15, 18,
20, another master, a blank slide or a PowerPoint import.

Supply `templateNumber` explicitly for each generated module. Template 8 uses its investigation
fields; 11 and 16 use their own supporting fields. Their source variants are fixed by their master
positions, not by the phase receiving the slide. They may explain an operational proposal without
inventing a numeric metric. Ground any product claim or measurement in the reviewed evidence.

Template 8's left panel is for the short focus (`investigation_focus`) and practical action
(`investigation_body`). Use its larger existing right box (`investigation_scope`) for the fuller
explanation and customer benefit; the bottom bar (`investigation_decision_note`) holds the decision
or next step. Compose and show this placement before approval. The renderer never moves approved
sentences to another box or rewrites them to fit. Capture fit geometry for every selected template,
including 8, 11 and 16, not just the unlabelled native templates.

For 12, 14 and 17, use the native editable-text inventory returned by the approved master capture,
not another template's field list. Carry its field keys, source fingerprint, source wording and
captured text capacity in `supportingTemplateInventory`; give the same capture in
`master_inventory.supporting_templates` before content review. Set the module's `titleField` to a
captured field. Fill every captured slot with reviewed wording and retain its provenance. The
renderer resolves an unlabelled shape by its exact native fingerprint, tags only the draft for
population, and preserves media, geometry and styling. Source master content is never edited.
The conservative capacity is the source slot's existing character count; it is not proof of fit
for longer text or a substitute for rendered human review.

## Before approval

Use `selectionPlan.contract = narrative-selection-v1`. Every included metric role needs a plain
reason and current evidence/recommendation references in `selectionPlan.metrics`; having data is
not itself a reason to include a chart. Choose the metric and reviewed window that best explain
the customer's goal. Omit irrelevant available metrics with their recorded reason.

Supporting modules declare `narrativeKind` before approval. Use 8 for investigation, 11 or 16 for
metric evidence, 12 for a reporting baseline, 14 for a workflow plan and 17 for a knowledge plan.
Keep comparable evidence slides consistent when they do the same job; use a different suitable
layout for a different job. Do not rotate templates or add extra slides merely for variety.
Keep the old `supporting_metric:phase_1` and `supporting_metric:phase_3` include flags false. Put
chosen supporting slides in the phase's `generatedModules`, including their purpose, exact copy
and current references. The renderer never replaces a template after approval.

The primary operating-trend slot keeps the internal role name `volume_trend`, but is not limited
to ticket counts. Supply `projection.runtimeTrendData.primary` with `metricDefinition.contract =
MetricTrendV1`, a stable metric ID, its exact label, units, aggregation and value type (count,
duration or percentage). Counts use their real unit; durations use hours. Percentages explicitly
declare `valueScale = percent` or `fraction` (0.25 becomes 25% only for a declared fraction).
Use `volumeMetricLabel` for that exact selected label. Review two to twelve consecutive months
that fit this native chart; do not silently truncate a longer requested window or retain a fixed
twelve-month title. Gaps stay gaps. Comparisons require actual matching metric/units/periods.

Call `beta_get_meeting_prep_build_requirements`. Check the draft name, exact field types, native
closing-copy limits, resource labels plus HTTPS links, normalized 0–1 bars and structured series.
Null/missing periods are gaps, not measured zero. Do not pass text where a link or series is needed.
An account-only chart must not be titled a peer comparison. Preserve the reviewed cohort and
percentile meaning; a peer median cannot be silently relabelled as an average or generic reference.
Use concise month/year labels with exact values; do not remove plotted observations to reduce clutter.

Use the returned early preflight errors to revise the input before asking the CSM to approve it.
Show the exact returned customer wording, complete ordered story, source/relevance decisions and
supporting-module purpose, not a promise that the renderer will write the rest.

The exact reviewed cover title is `[customer] + Zendesk`; the suffix is required. Check the full
title and period against the captured native fields before approval. In `native-fit-v3`, the
existing title frame may grow vertically in the draft only, keeping its font, width and position,
inside verified free space ending 12 points before the next overlapping native neighbour. The
master and presenter stay unchanged. Missing geometry or a blocked title area needs a layout
review, not removal of Zendesk, a guessed capacity or a late renderer rewrite.

Renewal headings, including “Your progress over the past year,” are fixed master content. The
`renewal-native-layout-v3` builder updates only the subtitle range inside a combined header,
preserving the title and both native text styles. New subtitle text must stay within the existing
subtitle's line capacity; missing or ambiguous targets stop before a draft is copied.

Native source fingerprints use SHA-256 of UTF-8 canonical JSON: sort object keys recursively, keep
array order, omit null/undefined object values, and ignore `objectId`, `contentUrl`, `thumbnailUrl`
and `sourceUrl`. Use the exact current source in memory. Do not persist source IDs, raw pages or
customer text, guess a hash, or substitute a timestamp for the source fingerprint.
For maintained-library content only, also omit the root `commentsViewMode` reader-display
property. The actual private builder's read-only selected-source capture can verify this exact
content fingerprint and revision without creating a draft. A sealed master's fingerprint remains
exact and unchanged. Never replace a genuinely changed source merely to satisfy a build.

## Review without repetition

Approval applies to the exact displayed decision. One explicit reply can approve displayed content
and displayed slide selections together when it names both. Record the separate ordered gates;
“continue” or “show more” alone does not approve them.

Wording-only changes retain unchanged evidence, recommendations and source/relevance selection
approvals. Re-review the changed copy. Changed source, applicability, order or recommendation
meaning invalidates the affected gates. Technical draft-name repairs do not reset unchanged
wording. A new revision discards previous draft authorization and rendered-output review.

Private-draft authorization and rendered human review stay separate. No technical test, source
capture, manual handoff or claimed output proves that a customer deck was created or looks good.
An old or mixed bound builder must stop before writing; local source edits and plugin installation
do not update that external builder.
