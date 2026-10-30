import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BetaError,
  ACCOUNT_INTELLIGENCE_CORE_CONTRACT,
  ACCOUNT_INTELLIGENCE_CORE_SECTIONS,
  ACCOUNT_INTELLIGENCE_CORE_VERSION,
  GATES,
  approveGate,
  bindAccountIntelligenceCore,
  bindRecommendationReviewPackage,
  createInventedCase,
  evaluateCapabilityReadiness,
  evaluateJourneyAReadiness,
  evaluateOnboarding,
  nextGate,
  submitFeedback,
  validateInventedAllowlistPreflight,
  validatePackagePreflight,
} from "../mcp/core.mjs";
import { confirmFeedbackSubmitted, prepareFeedbackForm } from "../mcp/feedback-form.mjs";
import { appendLocalRegisterEvent, createTesterRegisterEvent } from "../mcp/tester-register.mjs";
import {
  effectivePresentationPreferences,
  planCasePresentation,
  readPresentationPreferences,
  resetPresentationPreferences,
  writePresentationPreferences,
} from "../mcp/presentation-preferences.mjs";
import {
  bindDerivedEvidence,
  bindPrivateArtifact,
  createAuthorizedCase,
  createAuthorizedJourneyACase,
  recordLanguageReview,
  validateRealBetaRuntime,
} from "../mcp/real-beta.mjs";
import {
  parseSnowflakeProbe,
  probeSnowflakeZdp,
  snowflakeReadEnvironment,
  writeCredentialState,
} from "../mcp/credential-bridges.mjs";
import { createAuthorizationUrl } from "../mcp/google-oauth.mjs";
import {
  applyPresenterProfileStatus,
  confirmPersonalMaster,
  normalizePresenterProfile,
  presenterProfileForRenderer,
  readPresenterProfile,
  writePresenterProfile,
} from "../mcp/presenter-profile.mjs";
import { readRendererConfig } from "../mcp/renderer-client.mjs";
import {
  authorizeOwnerAssistedTest,
  consumeOwnerAssistedTestAuthorization,
  ownerAssistedDevelopmentStatus,
} from "../mcp/owner-assisted-development.mjs";
import {
  JOURNEY_A_GATES,
  approveJourneyAGate,
  bindJourneyContext,
  handoffJourney,
  recordJourneyAContactVerification,
  recordOrchestrationRun,
  publicJourneyStatus,
  routeWorkflowIntent,
  startJourney,
} from "../mcp/journey-orchestrator.mjs";

const allowlist = {
  mode: "invented_only",
  testers: [{ id: "tester-alpha", enabled: true }],
};
const manifest = {
  package_version: "0.2.0",
  renderer_baseline: "v22.10",
  status: "approved_for_invented_testing",
  expires_at: "2026-10-31T23:59:59Z",
  constraints: {
    real_customer_data: false,
    external_reads: false,
    external_writes: false,
    generated_artifacts: false,
  },
  integrity: { files: {} },
};
const now = new Date("2026-08-28T12:00:00Z");

function bindCompleteRecommendationReviewPackage(record) {
  return bindRecommendationReviewPackage(record, {
    reviewPackageDigest: "f".repeat(64),
    sections: [
      "account_identity_scope",
      "metric_baseline_and_definitions",
      "call_pain_points",
      "product_configuration_evidence_and_gaps",
      "pain_point_capability_metric_mapping",
    ],
    revision: record.revision,
    testerId: "tester-alpha",
    now,
  });
}

function approveAllJourneyBGates(record) {
  for (const gate of GATES.slice(0, 2)) {
    record = approveGate(record, { gate, revision: record.revision, testerId: "tester-alpha", now });
  }
  record = bindCompleteRecommendationReviewPackage(record);
  for (const gate of GATES.slice(2)) {
    record = approveGate(record, { gate, revision: record.revision, testerId: "tester-alpha", now });
  }
  return record;
}
const readyCredentials = {
  mode: "invented_only",
  identity: {
    state: "connected",
    provider: "invented_company_sso",
    subject: "invented-tester-alpha",
    verified: true,
  },
  snowflake: { state: "connected", read_only_verified: true },
  salesforce_cli: { state: "not_configured" },
  google: { state: "connected", private_draft_scope_verified: true },
  presenter_profile: { state: "ready" },
  tester_register: { state: "not_configured", blocking: false },
};

function errorCode(fn, code) {
  assert.throws(fn, (error) => error instanceof BetaError && error.code === code);
}

test("preflight approves an allowlisted tester on the approved invented-only version", () => {
  const result = validateInventedAllowlistPreflight({
    testerId: "tester-alpha",
    allowlist,
    manifest,
    packageRoot: ".",
    now,
  });
  assert.equal(result.ok, true);
  assert.equal(result.package_version, "0.2.0");
  assert.equal(result.renderer_baseline, "v22.10");
});

test("preflight fails closed for missing, unallowlisted, and expired access", () => {
  errorCode(
    () => validateInventedAllowlistPreflight({ testerId: "", allowlist, manifest, packageRoot: ".", now }),
    "TESTER_ID_MISSING",
  );
  errorCode(
    () =>
      validateInventedAllowlistPreflight({ testerId: "tester-unknown", allowlist, manifest, packageRoot: ".", now }),
    "TESTER_NOT_ALLOWLISTED",
  );
  errorCode(
    () =>
      validateInventedAllowlistPreflight({
        testerId: "tester-alpha",
        allowlist,
        manifest: { ...manifest, expires_at: "2026-08-01T00:00:00Z" },
        packageRoot: ".",
        now,
      }),
    "VERSION_STALE",
  );
});

test("preflight rejects a boundary that permits real data or external access", () => {
  errorCode(
    () =>
      validateInventedAllowlistPreflight({
        testerId: "tester-alpha",
        allowlist,
        manifest: { ...manifest, constraints: { ...manifest.constraints, external_reads: true } },
        packageRoot: ".",
        now,
      }),
    "BOUNDARY_MISMATCH",
  );
});

test("preflight rejects a manifest for a different package version", () => {
  errorCode(
    () =>
      validateInventedAllowlistPreflight({
        testerId: "tester-alpha",
        allowlist,
        manifest,
        packageRoot: ".",
        expectedPackageName: "csm-copilot-beta",
        expectedPackageVersion: "0.3.0",
        now,
      }),
    "PACKAGE_VERSION_MISMATCH",
  );
});

test("credential onboarding returns ready without exposing the raw identity", () => {
  const packageResult = validatePackagePreflight({ manifest, packageRoot: ".", now });
  const result = evaluateOnboarding({ credentialState: readyCredentials, packageResult });
  assert.equal(result.status, "ready");
  assert.match(result.operator_ref, /^operator_[a-f0-9]{20}$/);
  assert.equal(JSON.stringify(result).includes("invented-tester-alpha"), false);
  assert.equal(result.checks.snowflake_zdp, "ready");
  assert.equal(result.checks.salesforce_cli, "not_configured");
  assert.equal(result.checks.google_drive_slides, "ready");
  assert.equal(result.warnings.some((warning) => warning.code === "SALESFORCE_CLI_OPTIONAL"), true);
  assert.equal(result.warnings.every((warning) => warning.blocking === false), true);
});

test("Salesforce CLI readiness is optional and never blocks setup", () => {
  const packageResult = validatePackagePreflight({ manifest, packageRoot: ".", now });
  const result = evaluateOnboarding({
    credentialState: {
      ...readyCredentials,
      salesforce_cli: { state: "ready" },
    },
    packageResult,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.checks.salesforce_cli, "ready");
  assert.equal(result.warnings.some((warning) => warning.code === "SALESFORCE_CLI_OPTIONAL"), false);
});

test("credential onboarding returns only the first actionable setup fix", () => {
  const packageResult = validatePackagePreflight({ manifest, packageRoot: ".", now });
  const result = evaluateOnboarding({
    credentialState: {
      ...readyCredentials,
      identity: { state: "not_connected" },
      snowflake: { state: "not_connected" },
      google: { state: "not_connected" },
    },
    packageResult,
  });
  assert.equal(result.status, "action_required");
  assert.equal(result.next_action.code, "CONNECT_SNOWFLAKE_ZDP");
  assert.equal(result.checks.snowflake_zdp, "pending");
  assert.equal(result.checks.google_drive_slides, "pending");
});

test("credential onboarding distinguishes connection from read-only permission", () => {
  const packageResult = validatePackagePreflight({ manifest, packageRoot: ".", now });
  const result = evaluateOnboarding({
    credentialState: {
      ...readyCredentials,
      snowflake: { state: "connected", read_only_verified: false },
    },
    packageResult,
  });
  assert.equal(result.status, "action_required");
  assert.equal(result.next_action.code, "VERIFY_READ_ONLY_ZDP_ACCESS");
  assert.equal(result.checks.google_drive_slides, "pending");
});

test("limited onboarding blocks rendering until the CSM personalizes the private master deck", () => {
  const packageResult = validatePackagePreflight({ manifest, packageRoot: ".", now });
  const result = evaluateOnboarding({
    credentialState: { ...readyCredentials, presenter_profile: { state: "not_configured" } },
    packageResult,
  });
  assert.equal(result.status, "action_required");
  assert.equal(result.next_action.code, "PERSONALIZE_PRIVATE_MASTER_DECK");
  assert.equal(result.next_action.title, "Confirm your personal master deck");
});

test("Journey A needs Snowflake but not the private deck or renderer", () => {
  const packageResult = validatePackagePreflight({ manifest, packageRoot: ".", now });
  const result = evaluateJourneyAReadiness({
    credentialState: {
      ...readyCredentials,
      mode: "limited_beta",
      presenter_profile: { state: "not_configured" },
      renderer_mode: "manual_bound_script",
      manual_renderer: { state: "not_configured" },
      google: { state: "not_connected" },
    },
    packageResult,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.checks.snowflake_zdp, "ready");
});

test("Book of Business Analysis needs only the authenticated read-only Snowflake scope", () => {
  const packageResult = validatePackagePreflight({ manifest, packageRoot: ".", now });
  const result = evaluateCapabilityReadiness({
    credentialState: {
      ...readyCredentials,
      mode: "limited_beta",
      presenter_profile: { state: "not_configured" },
      renderer_mode: "manual_bound_script",
      manual_renderer: { state: "not_configured" },
      google: { state: "not_connected" },
    },
    packageResult,
    workflow: "portfolio_analytics",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.capabilities.book_of_business_analysis, "ready");
  assert.equal(result.capabilities.aggregate_account_counts, "ready");
  assert.equal(result.capabilities.aggregate_net_arr_usd, "ready");
  assert.match(result.setup_notes[0], /does not need CTA selection, a private deck, a renderer, or Gmail setup/i);
});

test("manual onboarding confirms the personal master before renderer authorization", () => {
  const packageResult = validatePackagePreflight({ manifest, packageRoot: ".", now });
  const result = evaluateOnboarding({
    credentialState: {
      ...readyCredentials,
      renderer_mode: "manual_bound_script",
      presenter_profile: { state: "not_configured" },
      manual_renderer: { state: "not_configured" },
    },
    packageResult,
  });
  assert.equal(result.next_action.code, "PERSONALIZE_PRIVATE_MASTER_DECK");
});

test("manual renderer onboarding requires only the bound-script authorization step", () => {
  const packageResult = validatePackagePreflight({ manifest, packageRoot: ".", now });
  const pending = evaluateOnboarding({
    credentialState: {
      ...readyCredentials,
      renderer_mode: "manual_bound_script",
      google: { state: "not_connected" },
      manual_renderer: { state: "not_configured" },
    },
    packageResult,
  });
  assert.equal(pending.status, "action_required");
  assert.equal(pending.next_action.code, "AUTHORIZE_MANUAL_RENDERER");
  const ready = evaluateOnboarding({
    credentialState: {
      ...readyCredentials,
      renderer_mode: "manual_bound_script",
      google: { state: "not_connected" },
      manual_renderer: { state: "ready", authorized: true },
    },
    packageResult,
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.checks.google_drive_slides, "ready");
  assert.equal(ready.checks.manual_renderer, "ready");
});

test("Snowflake probe derives opaque identity and verifies only an approved role", () => {
  const result = parseSnowflakeProbe(JSON.stringify([{
    CURRENT_USER: "invented.user",
    CURRENT_ROLE: "PUBLIC",
    CURRENT_WAREHOUSE: "INVENTED_SOURCE_WH",
  }]), { connectionName: "zdp-global", approvedReadOnlyRoles: ["PUBLIC"] });
  assert.equal(result.identity.verified, true);
  assert.equal(result.snowflake.read_only_verified, true);
  assert.equal(JSON.stringify(result).includes("invented.user"), false);
  assert.match(result.identity.subject, /^[a-f0-9]{64}$/);
});

test("Snowflake probe removes the desktop NO_COLOR override before invoking the CLI", () => {
  const original = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    let callCount = 0;
    probeSnowflakeZdp({
      runner(command, args, options) {
        assert.equal(command, "snow");
        assert.equal(args[0], "--config-file");
        assert.match(args[1], /\.snowflake\/config\.toml$/);
        assert.equal(options.env.NO_COLOR, undefined);
        assert.equal(options.env.SNOWFLAKE_CLI_LOGS_SAVE_LOGS, "");
        callCount += 1;
        if (callCount === 1) {
          assert.deepEqual(args.slice(2), ["connection", "test", "-c", "zdp-global"]);
          return { status: 0, stdout: "Connection test passed" };
        }
        assert.deepEqual(args.slice(2, 5), ["sql", "-c", "zdp-global"]);
        assert.deepEqual(args.slice(-2), ["--format", "json"]);
        return {
          status: 0,
          stdout: JSON.stringify([{
            CURRENT_USER: "tester@example.invalid",
            CURRENT_ROLE: "PUBLIC",
            CURRENT_WAREHOUSE: "READ_ONLY",
          }]),
        };
      },
      approvedReadOnlyRoles: ["PUBLIC"],
    });
    assert.equal(callCount, 2);
  } finally {
    if (original === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = original;
  }
});

test("Snowflake reads use a falsey process-only CLI log override", () => {
  const env = snowflakeReadEnvironment({ NO_COLOR: "1", EXISTING_VALUE: "kept" });
  assert.equal(env.SNOWFLAKE_CLI_LOGS_SAVE_LOGS, "");
  assert.equal(env.EXISTING_VALUE, "kept");
  assert.equal(Object.hasOwn(env, "NO_COLOR"), false);
});

test("private credential state is written with owner-only permissions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "csm-beta-credentials-"));
  const target = path.join(directory, "credential-state.json");
  try {
    writeCredentialState(target, { snowflake: { state: "connected", read_only_verified: true } });
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Google desktop OAuth uses PKCE and never asks for an out-of-band code", () => {
  const url = new URL(createAuthorizationUrl({
    clientId: "invented.apps.googleusercontent.com",
    redirectUri: "http://127.0.0.1:43123/oauth2callback",
    state: "invented-state",
    verifier: "a".repeat(64),
  }));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:43123/oauth2callback");
  assert.equal(url.searchParams.get("access_type"), "offline");
});

test("presenter profile requires a personalized private master deck and photo", () => {
  errorCode(() => normalizePresenterProfile({
    display_name: "Invented CSM",
    job_title: "Customer Success Manager",
    master_deck_personalized: true,
    photo_personalized: false,
  }), "MASTER_DECK_NOT_PERSONALIZED");
  const profile = normalizePresenterProfile({
    display_name: "Invented CSM",
    job_title: "Customer Success Manager",
    master_deck_personalized: true,
    photo_personalized: true,
  }, now);
  assert.match(profile.profile_ref, /^presenter_[a-f0-9]{20}$/);
  assert.equal(presenterProfileForRenderer(profile).photoPersonalizedConfirmed, true);
});

test("presenter profile remains private and contains no master-deck identifier", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "csm-beta-presenter-"));
  const target = path.join(directory, "presenter-profile.json");
  try {
    writePresenterProfile(target, {
      display_name: "Invented CSM",
      job_title: "Customer Success Manager",
      master_deck_personalized: true,
      photo_personalized: true,
    }, now);
    const result = readPresenterProfile(target);
    assert.equal(result.status, "ready");
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(result).includes("presentation"), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("one personal-master confirmation creates a ready local record without collecting presenter details", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "csm-beta-presenter-confirmation-"));
  const target = path.join(directory, "presenter-profile.json");
  try {
    const profile = confirmPersonalMaster(target, now);
    const result = readPresenterProfile(target);
    assert.equal(result.status, "ready");
    assert.equal(profile.confirmed_from_private_master, true);
    assert.equal(profile.display_name, "Private master deck");
    assert.equal(profile.job_title, "Presenter details preserved in the deck");
    assert.equal(presenterProfileForRenderer(profile).presenterDetailsSource, "private_master");
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("presenter profile readiness is applied in invented and limited modes", () => {
  const invented = applyPresenterProfileStatus(
    { mode: "invented_only", presenter_profile: { state: "not_configured" } },
    { status: "ready" },
  );
  const limited = applyPresenterProfileStatus(
    { mode: "limited_beta", presenter_profile: { state: "ready" } },
    { status: "action_required" },
  );
  assert.equal(invented.presenter_profile.state, "ready");
  assert.equal(limited.presenter_profile.state, "not_configured");
});

test("missing presenter profile asks to confirm an existing deck before creating another", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "csm-beta-presenter-missing-"));
  try {
    const result = readPresenterProfile(path.join(directory, "presenter-profile.json"));
    assert.equal(result.status, "action_required");
    assert.equal(result.next_action.title, "Confirm your personal master deck");
    assert.match(result.next_action.instruction, /already have/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("renderer client retires the API-executable path", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "csm-beta-renderer-"));
  const target = path.join(directory, "renderer-client.json");
  try {
    fs.writeFileSync(target, JSON.stringify({
      schema_version: "1.0",
      deployment_id: "invented-deployment",
      function_name: "runSomethingElse",
      dev_mode: false,
    }));
    errorCode(() => readRendererConfig(target), "API_RENDERER_RETIRED");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("local tester-register events are privacy-minimized and idempotent", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "csm-beta-register-"));
  try {
    const target = path.join(directory, "events.json");
    const event = createTesterRegisterEvent({
      eventType: "setup_ready",
      operatorRef: "operator_0123456789abcdefabcd",
      packageVersion: "0.2.0",
      rendererBaseline: "v22.10",
      status: "ready",
      occurredAt: now,
    });
    appendLocalRegisterEvent(target, event);
    const result = appendLocalRegisterEvent(target, event);
    assert.equal(result.events.length, 1);
    assert.deepEqual(Object.keys(result.events[0]).sort(), [
      "case_id",
      "event_key",
      "event_type",
      "occurred_at",
      "operator_ref",
      "package_version",
      "renderer_baseline",
      "schema_version",
      "status",
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("preflight fails when an integrity-bound package file changes", () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csm-beta-integrity-"));
  try {
    const target = path.join(packageRoot, "bound.txt");
    fs.writeFileSync(target, "approved\n");
    const expected = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    fs.writeFileSync(target, "changed\n");
    errorCode(
      () =>
        validateInventedAllowlistPreflight({
          testerId: "tester-alpha",
          allowlist,
          manifest: { ...manifest, integrity: { files: { "bound.txt": expected } } },
          packageRoot,
          now,
        }),
      "PACKAGE_INTEGRITY_FAILED",
    );
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("case approvals are ordered and bound to tester and revision", () => {
  let record = createInventedCase({
    scenario: "northstar-support",
    testerId: "tester-alpha",
    manifest,
    now,
    caseId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(nextGate(record), "identity");
  errorCode(
    () => approveGate(record, { gate: "evidence", revision: 1, testerId: "tester-alpha", now }),
    "APPROVAL_ORDER_VIOLATION",
  );
  errorCode(
    () => approveGate(record, { gate: "identity", revision: 2, testerId: "tester-alpha", now }),
    "STALE_CASE_REVISION",
  );
  for (const gate of GATES.slice(0, 2)) {
    record = approveGate(record, { gate, revision: 1, testerId: "tester-alpha", now });
  }
  errorCode(
    () => approveGate(record, { gate: "recommendations", revision: 1, testerId: "tester-alpha", now }),
    "RECOMMENDATION_REVIEW_PACKAGE_REQUIRED",
  );
  errorCode(
    () => bindRecommendationReviewPackage(record, {
      reviewPackageDigest: "f".repeat(64),
      sections: ["account_identity_scope"],
      revision: 1,
      testerId: "tester-alpha",
      now,
    }),
    "RECOMMENDATION_REVIEW_INCOMPLETE",
  );
  record = bindCompleteRecommendationReviewPackage(record);
  for (const gate of GATES.slice(2)) {
    record = approveGate(record, { gate, revision: 1, testerId: "tester-alpha", now });
  }
  assert.equal(record.status, "approved");
  assert.equal(nextGate(record), null);
});

test("a shared account-intelligence receipt persists only its provenance and is carried into full-plan review", () => {
  const accountRefDigest = "a".repeat(64);
  let record = createInventedCase({ scenario: "northstar-support", testerId: "tester-alpha", manifest, now });
  record = bindAccountIntelligenceCore(record, {
    contract: ACCOUNT_INTELLIGENCE_CORE_CONTRACT,
    schemaVersion: ACCOUNT_INTELLIGENCE_CORE_VERSION,
    contentDigest: "b".repeat(64),
    briefState: "partial",
    sectionStates: Object.fromEntries(ACCOUNT_INTELLIGENCE_CORE_SECTIONS.map((section) => [section, "checked"])),
    sourceGapCodes: ["RENEWAL_TIMING_NOT_ASSESSED"],
    accountRefDigest,
    revision: record.revision,
    testerId: "tester-alpha",
    now,
  });
  assert.equal(record.account_intelligence_core.raw_customer_content_retained, false);
  assert.equal(JSON.stringify(record.account_intelligence_core).includes("Northstar"), false);
  record.journey_state.account_ref_digest = accountRefDigest;
  for (const gate of GATES.slice(0, 2)) {
    record = approveGate(record, { gate, revision: record.revision, testerId: "tester-alpha", now });
  }
  record = bindCompleteRecommendationReviewPackage(record);
  assert.equal(record.recommendation_review_package.account_intelligence_core_digest, "b".repeat(64));
});

test("explicit workflow routing bypasses the daily layer while broad focus uses it", () => {
  assert.deepEqual(routeWorkflowIntent("broad_focus"), {
    intent: "broad_focus",
    route: "daily_operating_layer",
    requires_case: false,
    route_label: "Daily Focus",
  });
  assert.equal(routeWorkflowIntent("outreach").route, "journey_a");
  assert.equal(routeWorkflowIntent("outreach").route_label, "Account Prioritization and Outreach");
  assert.equal(routeWorkflowIntent("success_plan").route, "journey_b");
  assert.equal(routeWorkflowIntent("success_plan").route_label, "Customer Planning and Meeting Prep");
  assert.equal(routeWorkflowIntent("meeting_preparation").route, "journey_b");
  assert.equal(routeWorkflowIntent("renewal_conversation_brief").route, "journey_a");
  assert.equal(routeWorkflowIntent("renewal_conversation_brief").route_label, "Renewal Conversation Brief");
});

test("orchestration timing and source gaps bind to the shared case without source content", () => {
  const record = createInventedCase({ scenario: "northstar-support", testerId: "tester:one", manifest, now });
  const updated = recordOrchestrationRun(record, {
    journey: "journey_a", accountRefDigest: "a".repeat(64), durationMs: 24999,
    sourceGaps: ["EMAIL_TIMED_OUT"], testerId: "tester:one", now,
  });
  const status = publicJourneyStatus(updated);
  assert.equal(status.workflows.outreach.orchestration.duration_ms, 24999);
  assert.deepEqual(status.workflows.outreach.orchestration.source_gap_codes, ["EMAIL_TIMED_OUT"]);
});

test("a beta case starts with both journeys available and Journey B active", () => {
  const record = createInventedCase({ scenario: "northstar-support", testerId: "tester-alpha", manifest, now });
  const status = publicJourneyStatus(record);
  assert.equal(status.active_workflow, "meeting_prep");
  assert.equal(status.active_workflow_label, "Customer Planning and Meeting Prep");
  assert.equal(status.workflows.outreach.label, "Account Prioritization and Outreach");
  assert.equal(status.workflows.meeting_prep.label, "Customer Planning and Meeting Prep");
  assert.equal(status.workflows.outreach.status, "not_started");
  assert.equal(status.workflows.meeting_prep.status, "active");
});

test("Customer Planning and Meeting Prep cannot divert without explicit abandonment", () => {
  const record = createInventedCase({ scenario: "northstar-support", testerId: "tester-alpha", manifest, now });
  errorCode(
    () => startJourney(record, { journey: "journey_a", testerId: "tester-alpha", now }),
    "CUSTOMER_PLANNING_ABANDONMENT_REQUIRED",
  );
  const updated = startJourney(record, {
    journey: "journey_a", abandonCustomerPlanning: true, testerId: "tester-alpha", now,
  });
  assert.equal(updated.journey_state.active_journey, "journey_a");
});

test("Journey A binds privacy-safe shared context and enforces its review order", () => {
  let record = createInventedCase({ scenario: "northstar-support", testerId: "tester-alpha", manifest, now });
  record = startJourney(record, {
    journey: "journey_a", abandonCustomerPlanning: true, testerId: "tester-alpha", now,
  });
  record = bindJourneyContext(record, {
    journey: "journey_a",
    contextDigest: "a".repeat(64),
    accountRefDigest: "b".repeat(64),
    contextVersion: "1.0.0",
    itemCount: 12,
    warningCodes: ["MISSING_METRIC"],
    testerId: "tester-alpha",
    now,
  });
  errorCode(() => approveJourneyAGate(record, {
    gate: "contact_selection", revision: record.revision, testerId: "tester-alpha", now,
  }), "APPROVAL_ORDER_VIOLATION");
  record = approveJourneyAGate(record, {
    gate: "work_selection", revision: record.revision, testerId: "tester-alpha", now,
  });
  record = approveJourneyAGate(record, {
    gate: "account_evidence", revision: record.revision, testerId: "tester-alpha", now,
  });
  errorCode(() => approveJourneyAGate(record, {
    gate: "contact_selection", revision: record.revision, testerId: "tester-alpha", now,
  }), "CONTACT_VERIFICATION_REQUIRED");
  record = recordJourneyAContactVerification(record, {
    accountRefDigest: "b".repeat(64),
    salesforceIdentityState: "checked",
    salesforceActivityState: "checked",
    gmailMetadataState: "checked",
    gongMetadataState: "checked",
    gongLookbackDays: 180,
    candidateCount: 2,
    testerId: "tester-alpha",
    now,
  });
  for (const gate of JOURNEY_A_GATES.slice(2)) {
    record = approveJourneyAGate(record, { gate, revision: record.revision, testerId: "tester-alpha", now });
  }
  const status = publicJourneyStatus(record);
  assert.equal(status.workflows.outreach.status, "reviewed");
  assert.deepEqual(status.workflows.outreach.completed_gates, JOURNEY_A_GATES);
  assert.equal(status.workflows.outreach.contact_verification.gong_lookback_days, 180);
  assert.equal(JSON.stringify(record.journey_state).includes("Northstar"), false);
});

test("Journey A refuses an incomplete or short-window contact verification", () => {
  let record = createInventedCase({ scenario: "northstar-support", testerId: "tester-alpha", manifest, now });
  record = startJourney(record, {
    journey: "journey_a", abandonCustomerPlanning: true, testerId: "tester-alpha", now,
  });
  record = bindJourneyContext(record, {
    journey: "journey_a", contextDigest: "d".repeat(64), accountRefDigest: "e".repeat(64),
    contextVersion: "1.0.0", itemCount: 1, testerId: "tester-alpha", now,
  });
  errorCode(() => recordJourneyAContactVerification(record, {
    accountRefDigest: "e".repeat(64),
    salesforceIdentityState: "checked",
    salesforceActivityState: "checked",
    gmailMetadataState: "checked",
    gongMetadataState: "checked",
    gongLookbackDays: 30,
    candidateCount: 1,
    testerId: "tester-alpha",
    now,
  }), "GONG_LOOKBACK_REQUIRED");
  errorCode(() => recordJourneyAContactVerification(record, {
    accountRefDigest: "e".repeat(64),
    salesforceIdentityState: "unavailable",
    salesforceActivityState: "checked",
    gmailMetadataState: "checked",
    gongMetadataState: "checked",
    gongLookbackDays: 180,
    candidateCount: 1,
    testerId: "tester-alpha",
    now,
  }), "CONTACT_IDENTITY_NOT_VERIFIED");
});

test("Journey A records a shortlist when supporting activity sources are unavailable", () => {
  let record = createInventedCase({ scenario: "northstar-support", testerId: "tester-alpha", manifest, now });
  record = startJourney(record, {
    journey: "journey_a", abandonCustomerPlanning: true, testerId: "tester-alpha", now,
  });
  record = recordJourneyAContactVerification(record, {
    accountRefDigest: "e".repeat(64),
    salesforceIdentityState: "checked",
    salesforceActivityState: "unavailable",
    gmailMetadataState: "checked",
    gongMetadataState: "unavailable",
    gongLookbackDays: 180,
    candidateCount: 1,
    sourceGaps: ["SALESFORCE_ACTIVITY_UNAVAILABLE", "GONG_METADATA_UNAVAILABLE"],
    testerId: "tester-alpha",
    now,
  });
  assert.equal(record.journey_state.contexts.journey_a.contact_verification.source_states.salesforce_activity, "unavailable");
  assert.equal(record.journey_state.contexts.journey_a.contact_verification.source_states.gong_metadata, "unavailable");
});

test("Account contact evidence can arrive before the combined brief is bound and survives that binding", () => {
  let record = createInventedCase({ scenario: "northstar-support", testerId: "tester-alpha", manifest, now });
  record = startJourney(record, {
    journey: "journey_a", abandonCustomerPlanning: true, testerId: "tester-alpha", now,
  });
  record = recordJourneyAContactVerification(record, {
    accountRefDigest: "f".repeat(64),
    salesforceIdentityState: "checked",
    salesforceActivityState: "checked",
    gmailMetadataState: "checked",
    gongMetadataState: "checked",
    gongLookbackDays: 180,
    candidateCount: 1,
    testerId: "tester-alpha",
    now,
  });
  record = bindJourneyContext(record, {
    journey: "journey_a", contextDigest: "a".repeat(64), accountRefDigest: "f".repeat(64),
    contextVersion: "1.0.0", itemCount: 1, testerId: "tester-alpha", now,
  });
  const status = publicJourneyStatus(record);
  assert.equal(status.workflows.outreach.contact_verification.candidate_count, 1);
  assert.equal(status.workflows.outreach.context_bound, true);
});

test("Journey A can hand reviewed account context to Journey B and invalidates old Journey B approvals", () => {
  let record = createInventedCase({ scenario: "harbor-helpdesk", testerId: "tester-alpha", manifest, now });
  record = startJourney(record, {
    journey: "journey_a", abandonCustomerPlanning: true, testerId: "tester-alpha", now,
  });
  record = bindJourneyContext(record, {
    journey: "journey_a", contextDigest: "c".repeat(64), accountRefDigest: "d".repeat(64),
    contextVersion: "1.0.0", itemCount: 4, testerId: "tester-alpha", now,
  });
  errorCode(() => handoffJourney(record, {
    fromJourney: "journey_a", toJourney: "journey_b", reason: "discovery_or_success_plan",
    revision: record.revision, testerId: "tester-alpha", now,
  }), "HANDOFF_EVIDENCE_NOT_REVIEWED");
  record = approveJourneyAGate(record, {
    gate: "work_selection", revision: record.revision, testerId: "tester-alpha", now,
  });
  record = approveJourneyAGate(record, {
    gate: "account_evidence", revision: record.revision, testerId: "tester-alpha", now,
  });
  record.approvals = [{ gate: "identity", revision: record.revision }];
  const priorRevision = record.revision;
  record = handoffJourney(record, {
    fromJourney: "journey_a", toJourney: "journey_b", reason: "discovery_or_success_plan",
    revision: priorRevision, testerId: "tester-alpha", now,
  });
  assert.equal(record.revision, priorRevision + 1);
  assert.deepEqual(record.approvals, []);
  const status = publicJourneyStatus(record);
  assert.equal(status.active_workflow, "meeting_prep");
  assert.equal(status.handoffs.length, 1);
});

test("Journey B can hand context to Journey A and an account mismatch fails closed", () => {
  let record = createInventedCase({ scenario: "northstar-support", testerId: "tester-alpha", manifest, now });
  record = bindJourneyContext(record, {
    journey: "journey_b", contextDigest: "e".repeat(64), accountRefDigest: "f".repeat(64),
    contextVersion: "1.0.0", itemCount: 8, testerId: "tester-alpha", now,
  });
  errorCode(() => handoffJourney(record, {
    fromJourney: "journey_b", toJourney: "journey_a", reason: "outreach_or_follow_up",
    abandonCustomerPlanning: true, revision: record.revision, testerId: "tester-alpha", now,
  }), "HANDOFF_EVIDENCE_NOT_REVIEWED");
  record = approveGate(record, {
    gate: "identity", revision: record.revision, testerId: "tester-alpha", now,
  });
  record = approveGate(record, {
    gate: "evidence", revision: record.revision, testerId: "tester-alpha", now,
  });
  record = handoffJourney(record, {
    fromJourney: "journey_b", toJourney: "journey_a", reason: "outreach_or_follow_up",
    abandonCustomerPlanning: true, revision: record.revision, testerId: "tester-alpha", now,
  });
  errorCode(() => bindJourneyContext(record, {
    journey: "journey_a", contextDigest: "1".repeat(64), accountRefDigest: "2".repeat(64),
    contextVersion: "1.0.0", itemCount: 2, testerId: "tester-alpha", now,
  }), "CROSS_JOURNEY_ACCOUNT_MISMATCH");
});

test("feedback is prepared only after review and keeps version provenance", () => {
  let record = createInventedCase({
    scenario: "harbor-helpdesk",
    testerId: "tester-alpha",
    manifest,
    now,
    caseId: "22222222-2222-4222-8222-222222222222",
  });
  errorCode(
    () =>
      submitFeedback(record, {
        wouldUse: "yes",
        savedTime: "yes",
        biggestImprovement: "Improve spacing.",
        revision: 1,
        testerId: "tester-alpha",
        now,
      }),
    "REVIEW_INCOMPLETE",
  );
  record = approveAllJourneyBGates(record);
  record = submitFeedback(record, {
    wouldUse: "yes",
    savedTime: "yes",
    biggestImprovement: "Make the metric-to-recommendation link clearer.",
    revision: 1,
    testerId: "tester-alpha",
    now,
  });
  assert.equal(record.status, "feedback_pending_submission");
  assert.equal(record.feedback.package_version, "0.2.0");
  assert.equal(record.feedback.renderer_baseline, "v22.10");
  assert.equal(record.feedback.delivery_status, "prepared");
});

test("feedback form prefill contains only approved answers and version provenance", () => {
  let record = createInventedCase({
    scenario: "northstar-support",
    testerId: "tester-alpha",
    manifest,
    now,
    caseId: "33333333-3333-4333-8333-333333333333",
  });
  record = approveAllJourneyBGates(record);
  record = submitFeedback(record, {
    wouldUse: "yes",
    savedTime: "unsure",
    biggestImprovement: "Make the recommendation evidence easier to scan.",
    revision: 1,
    testerId: "tester-alpha",
    now,
  });
  record.language_review = {
    language: "fr",
    status: "review_required",
    outcome: "issues_found",
    issue_categories: ["product_term", "text_fit_or_layout"],
  };
  const delivery = prepareFeedbackForm(record, {
    enabled: true,
    mode: "google_forms_prefill",
    responder_url: "https://docs.google.com/forms/d/e/INVENTED_FORM/viewform",
    entries: {
      case_id: "entry.1001",
      package_version: "entry.1002",
      renderer_baseline: "entry.1003",
      revision: "entry.1004",
      would_use: "entry.1005",
      saved_time: "entry.1006",
      biggest_improvement: "entry.1007",
      language_review_status: "entry.1008",
      language_review_outcome: "entry.1009",
      translation_issue_categories: "entry.1010",
    },
  });
  const url = new URL(delivery.prefilled_form_url);
  assert.equal(delivery.status, "ready_for_review");
  assert.equal(url.searchParams.get("entry.1001"), record.case_id);
  assert.equal(url.searchParams.get("entry.1005"), "yes");
  assert.equal(url.searchParams.get("entry.1007"), "Make the recommendation evidence easier to scan.");
  assert.equal(url.searchParams.get("entry.1008"), "review_required");
  assert.equal(url.searchParams.get("entry.1009"), "issues_found");
  assert.equal(url.searchParams.get("entry.1010"), "product_term,text_fit_or_layout");
  assert.equal(delivery.translation_review_delivery, "included_in_form");
  assert.equal(delivery.prefilled_form_url.includes(record.invented_customer), false);
  assert.equal(delivery.prefilled_form_url.includes(record.tester_id), false);
});

test("disabled feedback form returns a safe configuration action without a URL", () => {
  let record = createInventedCase({ scenario: "harbor-helpdesk", testerId: "tester-alpha", manifest, now });
  record = approveAllJourneyBGates(record);
  record = submitFeedback(record, {
    wouldUse: "yes",
    savedTime: "yes",
    biggestImprovement: "Add clearer slide-selection context.",
    revision: 1,
    testerId: "tester-alpha",
    now,
  });
  const delivery = prepareFeedbackForm(record, { enabled: false });
  assert.equal(delivery.status, "configuration_required");
  assert.equal(delivery.prefilled_form_url, null);
});

test("tester confirmation completes feedback delivery", () => {
  let record = createInventedCase({ scenario: "harbor-helpdesk", testerId: "tester-alpha", manifest, now });
  record = approveAllJourneyBGates(record);
  record = submitFeedback(record, {
    wouldUse: "yes",
    savedTime: "yes",
    biggestImprovement: "Improve visual hierarchy.",
    revision: 1,
    testerId: "tester-alpha",
    now,
  });
  record = confirmFeedbackSubmitted(record, { revision: 1, testerId: "tester-alpha", now });
  assert.equal(record.status, "complete");
  assert.equal(record.feedback.delivery_status, "user_confirmed_submitted");
});

test("feedback rejects URLs, emails, and external-system identifiers", () => {
  let record = createInventedCase({ scenario: "northstar-support", testerId: "tester-alpha", manifest, now });
  record = approveAllJourneyBGates(record);
  errorCode(
    () =>
      submitFeedback(record, {
        wouldUse: "yes",
        savedTime: "yes",
        biggestImprovement: "Review https://example.com/customer/123.",
        revision: 1,
        testerId: "tester-alpha",
        now,
      }),
    "REAL_DATA_REJECTED",
  );
});

test("presentation preferences default to balanced and expose locked controls", () => {
  const profile = effectivePresentationPreferences();
  assert.equal(profile.preset, "balanced");
  assert.equal(profile.content_density, "medium");
  assert.equal(profile.locked_controls.includes("metric_and_chart_integrity"), true);
  assert.equal(profile.locked_controls.includes("internal_human_review_warning"), true);
});

test("presentation preferences persist privately and reset safely", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "csm-beta-prefs-"));
  const target = path.join(directory, "presentation-preferences.json");
  try {
    const saved = writePresentationPreferences(target, {
      preset: "consultative",
      metric_detail: "detailed",
    }, now);
    assert.equal(saved.product_explanation, "expanded");
    assert.equal(saved.metric_detail, "detailed");
    assert.equal(readPresentationPreferences(target).preset, "consultative");
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(resetPresentationPreferences(target).preset, "balanced");
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("presentation preferences reject arbitrary style keys and values", () => {
  errorCode(() => effectivePresentationPreferences({ font: "Invented Sans" }), "UNSUPPORTED_PRESENTATION_PREFERENCE");
  errorCode(() => effectivePresentationPreferences({ content_density: "extreme" }), "INVALID_PRESENTATION_PREFERENCE");
});

test("case presentation override creates a new revision and clears approvals", () => {
  let record = createInventedCase({ scenario: "northstar-support", testerId: "tester-alpha", manifest, now });
  record = approveGate(record, { gate: "identity", revision: 1, testerId: "tester-alpha", now });
  record = planCasePresentation(record, {
    overrides: { preset: "executive" },
    testerId: "tester-alpha",
    now,
  });
  assert.equal(record.revision, 2);
  assert.equal(record.approvals.length, 0);
  assert.equal(record.presentation_plan.preset, "executive");
  assert.equal(record.presentation_plan.content_density, "low");
  assert.equal(record.status, "in_review");
});

const limitedManifest = {
  ...manifest,
  status: "approved_for_limited_beta",
  constraints: {
    real_customer_data: true,
    external_reads: true,
    private_draft_writes: true,
    production_system_writes: false,
    generated_artifacts: true,
  },
};
const limitedRuntime = {
  mode: "limited_beta",
  organizational_controls: {
    company_identity: true,
    read_only_zdp: true,
    transcript_secondary_processing: true,
    private_draft_google_scope: true,
    approved_renderer_execution: true,
    retention_policy: true,
    operational_support: true,
  },
};

test("limited-beta package boundary allows reads and private drafts but no production writes", () => {
  const result = validatePackagePreflight({ manifest: limitedManifest, packageRoot: ".", now });
  assert.equal(result.boundaries.private_draft_writes, true);
  assert.equal(result.boundaries.production_system_writes, false);
  errorCode(
    () => validatePackagePreflight({
      manifest: { ...limitedManifest, constraints: { ...limitedManifest.constraints, production_system_writes: true } },
      packageRoot: ".",
      now,
    }),
    "BOUNDARY_MISMATCH",
  );
});

test("real-beta runtime fails closed until every organizational control is approved", () => {
  assert.equal(validateRealBetaRuntime({ credentialState: limitedRuntime, manifest: limitedManifest }), true);
  errorCode(
    () => validateRealBetaRuntime({
      credentialState: {
        ...limitedRuntime,
        organizational_controls: { ...limitedRuntime.organizational_controls, approved_renderer_execution: false },
      },
      manifest: limitedManifest,
    }),
    "REAL_BETA_CONTROL_MISSING",
  );
  errorCode(
    () => validateRealBetaRuntime({ credentialState: limitedRuntime, manifest }),
    "REAL_BETA_VERSION_NOT_APPROVED",
  );
});

test("authorized real case stores only opaque source provenance and eligibility decisions", () => {
  const digest = "a".repeat(64);
  let record = createAuthorizedCase({
    input: {
      source_locator_digest: digest,
      language: "en",
      recording_present: true,
      transcript_processing_authorized: true,
      no_service_data: true,
      no_sensitive_personal_data: true,
      no_suspected_l5: true,
    },
    testerId: "tester-alpha",
    manifest: limitedManifest,
    now,
  });
  assert.equal(record.case_kind, "real_authorized");
  assert.equal(record.source_locator_digest, digest);
  assert.equal(JSON.stringify(record).includes("gong.io"), false);
  record = bindDerivedEvidence(record, {
    digest: "b".repeat(64),
    findingCount: 7,
    warningCodes: ["MISSING_BASELINE"],
    testerId: "tester-alpha",
    now,
  });
  assert.equal(record.revision, 2);
  assert.equal(record.derived_evidence.raw_transcript_retained, false);
  record = bindPrivateArtifact(record, {
    artifactRefDigest: "c".repeat(64),
    auditRefDigest: "d".repeat(64),
    testerId: "tester-alpha",
    now,
  });
  assert.equal(record.artifact.private_draft, true);
  assert.equal(record.artifact.customer_shared, false);
});

test("authorized real case requires transcript consent and source eligibility without CSM repetition", () => {
  errorCode(
    () => createAuthorizedCase({
      input: {
        source_locator_digest: "a".repeat(64),
        language: "en",
        recording_present: true,
        transcript_processing_authorized: false,
        no_service_data: true,
        no_sensitive_personal_data: true,
        no_suspected_l5: true,
      },
      testerId: "tester-alpha",
      manifest: limitedManifest,
      now,
    }),
    "CALL_NOT_ELIGIBLE",
  );
  errorCode(
    () => createAuthorizedCase({
      input: {
        source_locator_digest: "a".repeat(64),
        language: "en",
        recording_present: false,
        transcript_processing_authorized: true,
        no_service_data: true,
        no_sensitive_personal_data: true,
        no_suspected_l5: true,
      },
      testerId: "tester-alpha",
      manifest: limitedManifest,
      now,
    }),
    "CALL_NOT_ELIGIBLE",
  );
});

test("owner-assisted testing requires private owner controls and consumes one exact authorization", () => {
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-owner-assisted-"));
  const authorizationPath = path.join(privateDir, "authorizations.json");
  const operatorRef = "operator_0123456789abcdefabcd";
  const controls = {
    mode: "owner_assisted_development",
    enabled: true,
    owner_operator_ref: operatorRef,
    cross_account_testing: {
      explicit_authorization_required: true,
      single_active_authorization: true,
      max_authorization_minutes: 60,
      private_draft_only: true,
      read_only_sources: true,
      retain_raw_transcript: false,
    },
  };
  assert.equal(ownerAssistedDevelopmentStatus({ controls, operatorRef }).status, "ready");
  assert.equal(ownerAssistedDevelopmentStatus({ controls: null, operatorRef }).status, "unavailable");
  const authorization = authorizeOwnerAssistedTest({
    controls,
    authorizationPath,
    operatorRef,
    input: {
      explicit_authorization_confirmed: true,
      authorization_reference_digest: "a".repeat(64),
      scope_kind: "gong_call",
      scope_digest: "b".repeat(64),
      account_ref_digest: "c".repeat(64),
      account_owner_ref_digest: "d".repeat(64),
    },
    now,
  });
  const used = consumeOwnerAssistedTestAuthorization({
    controls,
    authorizationPath,
    operatorRef,
    authorizationId: authorization.authorization_id,
    scopeKind: "gong_call",
    scopeDigest: "b".repeat(64),
    accountRefDigest: "c".repeat(64),
    accountOwnerRefDigest: "d".repeat(64),
    caseId: "66666666-6666-4666-8666-666666666666",
    now,
  });
  assert.equal(used.private_draft_only, true);
  assert.equal(used.raw_transcript_retained, false);
  const saved = JSON.parse(fs.readFileSync(authorizationPath, "utf8"));
  assert.equal(saved.authorizations[0].status, "consumed");
  errorCode(() => consumeOwnerAssistedTestAuthorization({
    controls,
    authorizationPath,
    operatorRef,
    authorizationId: authorization.authorization_id,
    scopeKind: "gong_call",
    scopeDigest: "b".repeat(64),
    accountRefDigest: "c".repeat(64),
    accountOwnerRefDigest: "d".repeat(64),
    caseId: "66666666-6666-4666-8666-666666666666",
    now,
  }), "OWNER_ASSISTED_AUTHORIZATION_NOT_FOUND");
});

test("owner-assisted testing rejects a source or account outside the explicit authorization", () => {
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-owner-assisted-"));
  const authorizationPath = path.join(privateDir, "authorizations.json");
  const operatorRef = "operator_0123456789abcdefabcd";
  const controls = {
    mode: "owner_assisted_development",
    enabled: true,
    owner_operator_ref: operatorRef,
    cross_account_testing: {
      explicit_authorization_required: true,
      single_active_authorization: true,
      max_authorization_minutes: 60,
      private_draft_only: true,
      read_only_sources: true,
      retain_raw_transcript: false,
    },
  };
  const authorization = authorizeOwnerAssistedTest({
    controls,
    authorizationPath,
    operatorRef,
    input: {
      explicit_authorization_confirmed: true,
      authorization_reference_digest: "a".repeat(64),
      scope_kind: "account_portfolio",
      scope_digest: "b".repeat(64),
      account_ref_digest: "c".repeat(64),
      account_owner_ref_digest: "d".repeat(64),
    },
    now,
  });
  errorCode(() => consumeOwnerAssistedTestAuthorization({
    controls,
    authorizationPath,
    operatorRef,
    authorizationId: authorization.authorization_id,
    scopeKind: "account_portfolio",
    scopeDigest: "e".repeat(64),
    accountRefDigest: "c".repeat(64),
    accountOwnerRefDigest: "d".repeat(64),
    caseId: "66666666-6666-4666-8666-666666666666",
    now,
  }), "OWNER_ASSISTED_SCOPE_MISMATCH");
});

test("authorized Journey A case does not require or retain a Gong locator", () => {
  const record = createAuthorizedJourneyACase({
    input: {
      language: "en",
    },
    testerId: "operator_0123456789abcdefabcd",
    manifest,
    now,
    caseId: "77777777-7777-4777-8777-777777777777",
  });
  assert.equal(record.case_kind, "real_authorized_journey_a");
  assert.equal(record.journey_state.active_journey, "journey_a");
  assert.equal("source_locator_digest" in record, false);
  assert.equal(record.portfolio_eligibility.read_only_authorized, true);
});

test("authorized Account Prioritization and Outreach cases support Spanish customer content", () => {
  const record = createAuthorizedJourneyACase({
    input: {
      language: "es",
    },
    testerId: "operator_0123456789abcdefabcd",
    manifest,
    now,
  });
  assert.equal(record.language, "es");
  assert.equal(record.language_review.status, "reviewed");
});

test("unreviewed customer languages remain available with a visible review warning", () => {
  let record = createAuthorizedJourneyACase({
    input: {
      language: "fr",
    },
    testerId: "operator_0123456789abcdefabcd",
    manifest,
    now,
  });
  assert.equal(record.language_review.status, "review_required");
  assert.equal(record.language_review.warning.code, "LANGUAGE_REVIEW_REQUIRED");
  record = recordLanguageReview(record, {
    outcome: "issues_found",
    issueCategories: ["product_term", "text_fit_or_layout"],
    testerId: "operator_0123456789abcdefabcd",
    now,
  });
  assert.deepEqual(record.language_review.issue_categories, ["product_term", "text_fit_or_layout"]);
  errorCode(() => recordLanguageReview(record, {
    outcome: "issues_found",
    issueCategories: [],
    testerId: "operator_0123456789abcdefabcd",
    now,
  }), "INVALID_INPUT");
});

test("authorized Account Prioritization and Outreach case does not require repeated consent fields", () => {
  const record = createAuthorizedJourneyACase({
    input: {
      language: "en",
    },
    testerId: "operator_0123456789abcdefabcd",
    manifest,
    now,
  });
  assert.equal(record.portfolio_eligibility.read_only_authorized, true);
  assert.equal(record.portfolio_eligibility.draft_only, true);
});
