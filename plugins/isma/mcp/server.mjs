#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import Native from "./approved-native-contract.js";
import { fileURLToPath } from "node:url";
import {
  BetaError,
  GATES,
  RECOMMENDATION_REVIEW_SECTIONS,
  SCENARIOS,
  approveGate,
  bindAccountIntelligenceCore,
  bindRecommendationReviewPackage,
  createInventedCase,
  publicCaseStatus,
  readJson,
  submitFeedback,
  evaluateOnboarding,
  evaluateCapabilityReadiness,
  evaluateJourneyAReadiness,
  validatePackagePreflight,
} from "./core.mjs";
import { appendLocalRegisterEvent, createTesterRegisterEvent } from "./tester-register.mjs";
import { confirmFeedbackSubmitted, prepareFeedbackForm } from "./feedback-form.mjs";
import {
  effectivePresentationPreferences,
  planCasePresentation,
  readPresentationPreferences,
  resetPresentationPreferences,
  writePresentationPreferences,
} from "./presentation-preferences.mjs";
import {
  authorizeSelectedCallProcessing,
  bindDerivedEvidence,
  bindPrivateArtifact,
  createAuthorizedCase,
  createConvergeMeetingPrepCase,
  createAuthorizedJourneyACase,
  recordLanguageReview,
  validateRealBetaRuntime,
} from "./real-beta.mjs";
import {
  authorizeOwnerAssistedTest,
  consumeOwnerAssistedTestAuthorization,
  ownerAssistedDevelopmentStatus,
} from "./owner-assisted-development.mjs";
import { probeSnowflakeZdp, writeCredentialState } from "./credential-bridges.mjs";
import {inspectSnowflakeSetup, configureSnowflakeSetup, applySnowflakeSetupStatus} from './snowflake-onboarding.mjs';
import { readOwnedCtaQueueWithSession } from "./journey-a-cta-queue.mjs";
import { presentDailyFocusWorkSignals } from "./daily-focus-work-signals.mjs";
import { readPortfolioRelationships, PortfolioRelationshipReadJobs } from "./journey-a-portfolio-relationships.mjs";
import {
  bookOfBusinessAnalyticsCapabilities,
  buildBookOfBusinessSummarySql,
  readBookOfBusinessSummaryWithSession,
} from "./book-of-business-analytics.mjs";
import { BookOfBusinessReadSession } from "./book-of-business-read-session.mjs";
import { BookOfBusinessReadJobs } from "./book-of-business-read-jobs.mjs";
import {
  bookOfBusinessPortfolioQueryCapabilities,
  normalizeBookOfBusinessPortfolioRequest,
  readBookOfBusinessPortfolioQueryWithSession,
} from "./book-of-business-portfolio-query.mjs";
import {
  authorizedMeetingPrepCallInput,
  buildMeetingPrepAccountScopeSql,
  buildMeetingPrepCallLinkValidationSql,
  parseGongCallUrl,
  presentMeetingPrepCallCandidates,
  readMeetingPrepCallCandidatesWithSession,
  readMeetingPrepCallCandidatesInRangeWithSession,
  requireMeetingPrepCallDateRange,
  resolveMeetingPrepAccountScope,
  validateMeetingPrepCallLinkWithSession,
} from "./meeting-prep-call-selection.mjs";
import { MeetingPrepCallLookupJobs } from "./meeting-prep-call-lookup-jobs.mjs";
import { ConvergeMeetingPrepBridge } from "./converge-meeting-prep.mjs";
import { MeetingPrepAccountBriefJobs, buildMeetingPrepCaseAccountScopeSql, readMeetingPrepAccountBriefWithSession, resolveMeetingPrepBriefAccount, projectMeetingPrepBrief } from "./meeting-prep-account-brief.mjs";
import { ManagerAccountSearches, verifyManagerSelectedAccountWithSession, verifyManagerReadOnlySession } from './manager-account-search.mjs';
import { nativeGmailSignatureHandling } from './gmail-native-signature.mjs';
import { SelectedCallEvidenceJobs, readSelectedCallEvidenceWithSession } from "./meeting-prep-selected-call-evidence.mjs";
import { bindMeetingPrepDraftInput } from "./meeting-prep-draft-binding.mjs";
import { prepareMeetingPrepDraftReview, recommendationRefs, reopenMeetingPrepRecommendationReview, meetingPrepDraftReviewPrompt } from "./meeting-prep-draft-review.mjs";
import { nativeBuildRequirements, validateMeetingPrepMasterPreflight } from "./meeting-prep-native-preflight.mjs";
import { assembleApprovedMeetingPrepInput } from "./meeting-prep-build-contract.mjs";
import { buildAccountIntelligenceDisplay, ACCOUNT_BRIEF_DISPLAY_FOCUS_SCHEMA, ACCOUNT_BRIEF_DISPLAY_DETAILS_SCHEMA } from "./account-intelligence-display.mjs";
import { accountBriefChartResult } from "./account-brief-chart-delivery.mjs";
import { TemporaryAccountBriefChartFiles } from "./account-brief-chart-files.mjs";
import { renewalRunDigest, createRenewalDraftHandoff, completeRenewalConversationRecord } from "./renewal-completion.mjs";
import { beginRenewalNativePreflight, renewalNativeLayoutRequest, bindRenewalNativePreflight, assertRenewalNativePreflight } from "./renewal-native-preflight.mjs";
import { assessLoadedPackageVersion, recordWorkflowOutcome, summarizeWorkflowReadiness } from "./workflow-readiness.mjs";
import { expectedReleaseComponents, assertRendererCompatibility } from "./release-compatibility.mjs";
import { bindOutreachDraftReview, claimOutreachDraft, completeOutreachDraft } from "./outreach-draft-delivery.mjs";
import { OutreachRecipientHandoffs } from "./outreach-recipient-handoff.mjs";
import { prepareOutreachEmail, projectOutreachEmail, saveOutreachEmail, outreachEmailReviewStatus } from "./outreach-email-preparation.mjs";
import {
  composeShortlistEvidence,
  mergeFastContactDetails,
  recommendContacts,
  readCoreContactEvidenceWithSession,
  readBulkCoreContactEvidenceWithSession,
  verifyBulkContactDetailsWithSession,
  readFastJourneyAContactEvidenceWithSession,
  readSlowJourneyAContactEvidenceWithSession,
} from "./journey-a-contact-evidence.mjs";
import {
  RENEWAL_CONVERSATION_DESIGN_CONTRACT,
  RENEWAL_CONVERSATION_RENDERER_BASELINE,
  assertRenewalConversationRendererRequest,
  activeRenewalTemplateBinding,
} from "./renewal-conversation-renderer.mjs";
import {
  RENEWAL_CONVERSATION_REVIEW_GATES,
  addRenewalCsmContext,
  buildRenewalDeckContent,
  buildRenewalConversationBrief,
  isRenewalCta,
  renewalCtaDeadlineStatus,
  readRenewalConversationEvidenceWithSession,
  renewalPreparationChoice,
} from "./renewal-conversation-brief.mjs";
import { PersistentSnowflakeSession } from "./persistent-snowflake-session.mjs";
import { continueRenewalPreparation } from "./renewal-preparation-delivery.mjs";
import { getRenewalSequenceGuidance } from "./renewal-sequence-guidance.mjs";
import { authorizeGoogleDesktop, googleAccessToken } from "./google-oauth.mjs";
import { NativeRenewalSourceBridge } from "./renewal-source-resolver.mjs";
import {
  confirmSignatureTest,
  readSignatureForApprovedDraft,
  removeSignatureProfile,
  saveSignatureProfile,
  signatureProfileStatus,
  signatureTestDraft,
} from "./signature-profile.mjs";
import { buildSetupWizardStatus, resumeSetupWizard, startSetupWizard } from "./setup-wizard.mjs";
import { DEPENDENCIES, buildDependencyChecklist, SetupDependencyInstallations } from './setup-dependencies.mjs';
import { buildOutreachPack } from "./outreach-pack.mjs";
import { bindNativeOutreachEvidence } from "./outreach-evidence-context.mjs";
import { invokeAppsScriptRenderer, probeAppsScriptRenderer } from "./renderer-client.mjs";
import { assertReferenceLockedRendererRequest } from "./reference-locked-renderer.mjs";
import { DESIGN_FAMILY, validateApprovedRecoveryDesignContract } from "./approved-recovery-design.mjs";
import {
  applyPresenterProfileStatus,
  confirmPersonalMaster,
  presenterProfileForRenderer,
  readPresenterProfile,
  writePresenterProfile,
} from "./presenter-profile.mjs";
import {
  HANDOFF_REASONS,
  JOURNEYS,
  JOURNEY_A_GATES,
  approveJourneyAGate,
  bindJourneyContext,
  handoffJourney,
  publicJourneyStatus,
  recordJourneyAContactVerification,
  recordOrchestrationRun,
  meetingPreparationMode,
  routeWorkflowIntent,
  startJourney,
} from "./journey-orchestrator.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installedPackageManifest = readJson(path.join(packageRoot, ".codex-plugin", "plugin.json"));
const workflowSourceObservations = {};
const stateNamespace = process.env.CSM_COPILOT_BETA_STATE_NAMESPACE || installedPackageManifest.name;
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(stateNamespace)) {
  throw new Error("CSM_COPILOT_BETA_STATE_NAMESPACE must be a lowercase plugin-style name.");
}
const ownerPrivateConfigDir = path.join(os.homedir(), ".codex", stateNamespace);
const ownerApprovedManifestPath = path.join(ownerPrivateConfigDir, "approved-version-manifest.json");
const stateDir = process.env.PLUGIN_DATA
  ? path.resolve(process.env.PLUGIN_DATA)
  : path.join(os.tmpdir(), `${stateNamespace}-invented`);
const manifestPath = process.env.CSM_COPILOT_BETA_MANIFEST_PATH
  ? path.resolve(process.env.CSM_COPILOT_BETA_MANIFEST_PATH)
  : fs.existsSync(ownerApprovedManifestPath)
    ? ownerApprovedManifestPath
    : path.join(packageRoot, "config", "approved-version-manifest.json");
const credentialStatePath = process.env.CSM_COPILOT_BETA_CREDENTIAL_STATE_PATH
  ? path.resolve(process.env.CSM_COPILOT_BETA_CREDENTIAL_STATE_PATH)
  : path.join(packageRoot, "config", "invented-onboarding-state.json");
const ownerLimitedBetaRuntimePath = path.join(ownerPrivateConfigDir, "limited-beta-runtime.json");
const ownerCredentialStatePath = path.join(ownerPrivateConfigDir, "credential-state.json");
const ownerPresenterProfilePath = path.join(ownerPrivateConfigDir, "presenter-profile.json");
const ownerSignatureProfilePath = path.join(ownerPrivateConfigDir, "gmail-signature-profile.json");
const activeSetupInstallations = new SetupDependencyInstallations({ directory: path.join(ownerPrivateConfigDir, 'dependency-installations'), packageVersion: installedPackageManifest.version,
  inspect: () => inspectSnowflakeSetup(snowflakeSetupOptions()) });
let activeDependencyObservations = [];

function dependencyChecklist({ workflow = 'all', observations = activeDependencyObservations } = {}) {
  const runtime = loadRuntime();
  const result = buildDependencyChecklist({ workflow, observations,
    snowflake: runtime.credentialState.mode === 'limited_beta' ? inspectSnowflakeSetup(snowflakeSetupOptions()) : null });
  activeDependencyObservations = observations;
  return result;
}
const ownerSetupWizardPath = path.join(ownerPrivateConfigDir, "setup-wizard.json");
const ownerAccountAccessModePath = path.join(ownerPrivateConfigDir, 'account-access-mode.json');
const ownerGoogleOAuthClientPath = path.join(ownerPrivateConfigDir, "google-oauth-client.json");
const ownerGoogleTokenPath = path.join(ownerPrivateConfigDir, "google-oauth-token.json");
const ownerSharedGoogleTokenPath = path.join(ownerPrivateConfigDir, "google-shared-sources-oauth-token.json");
const ownerRendererConfigPath = path.join(ownerPrivateConfigDir, "renderer-client.json");
const ownerApprovedRecoveryDesignPath = path.join(ownerPrivateConfigDir, "approved-recovery-design.json");
const ownerAssistedDevelopmentControlsPath = path.join(ownerPrivateConfigDir, "owner-assisted-development.json");
const ownerAssistedAuthorizationPath = path.join(ownerPrivateConfigDir, "owner-assisted-authorizations.json");
const sourceConnectionPolicyPath = path.join(packageRoot, "config", "source-connection-policy.json");
const limitedBetaRuntimePath = process.env.CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH
  ? path.resolve(process.env.CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH)
  : fs.existsSync(ownerLimitedBetaRuntimePath)
    ? ownerLimitedBetaRuntimePath
    : path.join(packageRoot, "config", "limited-beta-runtime.json");
const ownerFeedbackFormConfigPath = path.join(
  ownerPrivateConfigDir,
  "feedback-form.json",
);
const feedbackFormConfigPath = process.env.CSM_COPILOT_BETA_FEEDBACK_FORM_CONFIG_PATH
  ? path.resolve(process.env.CSM_COPILOT_BETA_FEEDBACK_FORM_CONFIG_PATH)
  : fs.existsSync(ownerFeedbackFormConfigPath)
    ? ownerFeedbackFormConfigPath
    : path.join(packageRoot, "config", "feedback-form.json");
const ownerPresentationPreferencesPath = path.join(
  ownerPrivateConfigDir,
  "presentation-preferences.json",
);
const presentationPreferencesPath = process.env.CSM_COPILOT_BETA_PRESENTATION_PREFERENCES_PATH
  ? path.resolve(process.env.CSM_COPILOT_BETA_PRESENTATION_PREFERENCES_PATH)
  : ownerPresentationPreferencesPath;
const registerPath = path.join(stateDir, "tester-register-events.json");
const ownerAssistedDisabled = process.env.CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED === "true";
const JOURNEY_A_RUNTIME_SELECTION_TTL_MS = 15 * 60 * 1000;
const activeJourneyAQueueSelections = new Map();
const activeJourneyAAccountSelections = new Map();
const activeJourneyAContactEvidenceRuns = new Map();
const activeBulkContactResearch = new Map();
const activeOutreachRecipientHandoffs = new OutreachRecipientHandoffs();
const activeJourneyASnowflakeSessions = new Map();
const activeRenewalConversationRuns = new Map();
const activeMeetingPrepCallSelections = new Map();
const activeMeetingPrepSelectedCalls = new Map();
const activeMeetingPrepCallReviewContexts = new Map();
const activeMeetingPrepBriefCases = new Map();
const activeMeetingPrepCallLookups = new MeetingPrepCallLookupJobs();
const activeConvergeMeetingPrep = new ConvergeMeetingPrepBridge();
const activeNativeRenewalSources = new NativeRenewalSourceBridge();
const activeMeetingPrepAccountBriefs = new MeetingPrepAccountBriefJobs();
const activeManagerAccountSearches = new ManagerAccountSearches();
const temporaryAccountBriefChartFiles = new TemporaryAccountBriefChartFiles();
const activeSelectedCallEvidence = new SelectedCallEvidenceJobs();
const activeBookOfBusinessReads = new BookOfBusinessReadJobs();
const activePortfolioRelationshipReads = new PortfolioRelationshipReadJobs();
const RENEWAL_EVIDENCE_NOTICE_MS = 25_000;
const ownerAssistedToolNames = new Set([
  "beta_owner_assisted_test_status",
  "beta_authorize_owner_assisted_test",
]);

function recordRegisterEvent({ eventType, result, caseId = null, status }) {
  if (!result?.operator_ref) return;
  appendLocalRegisterEvent(
    registerPath,
    createTesterRegisterEvent({
      eventType,
      operatorRef: result.operator_ref,
      packageVersion: result.package_version,
      rendererBaseline: result.renderer_baseline,
      caseId,
      status,
    }),
  );
}

function pruneJourneyARuntimeState(nowMs = Date.now()) {
  activeOutreachRecipientHandoffs.prune();
  activeMeetingPrepAccountBriefs.prune();
  for (const ref of activeMeetingPrepBriefCases.keys()) {
    if (!activeMeetingPrepAccountBriefs.jobs.has(ref)) activeMeetingPrepBriefCases.delete(ref);
  }
  for (const [key, value] of activeJourneyAQueueSelections) {
    if (value.expiresAt <= nowMs) activeJourneyAQueueSelections.delete(key);
  }
  for (const [key, value] of activeJourneyAAccountSelections) {
    if (value.expiresAt <= nowMs) activeJourneyAAccountSelections.delete(key);
  }
  for (const [key, value] of activeJourneyAContactEvidenceRuns) {
    if (value.expiresAt <= nowMs) {
      activeJourneyAContactEvidenceRuns.delete(key);
      closeJourneyASnowflakeSession(value.caseId);
    }
  }
  for (const [key, value] of activeBulkContactResearch) {
    if (value.expiresAt <= nowMs) activeBulkContactResearch.delete(key);
  }
  for (const [key, value] of activeRenewalConversationRuns) {
    if (value.expiresAt <= nowMs) activeRenewalConversationRuns.delete(key);
  }
  for (const [key, value] of activeMeetingPrepCallSelections) {
    if (value.expiresAt <= nowMs) activeMeetingPrepCallSelections.delete(key);
  }
  for (const [key, value] of activeMeetingPrepSelectedCalls) {
    if (value.expiresAt <= nowMs) activeMeetingPrepSelectedCalls.delete(key);
  }
  for (const [key, value] of activeMeetingPrepCallReviewContexts) {
    if (value.expiresAt <= nowMs) activeMeetingPrepCallReviewContexts.delete(key);
  }
  for (const [caseId, session] of activeJourneyASnowflakeSessions) {
    if (session.expiresAt <= nowMs) {
      session.close();
      activeJourneyASnowflakeSessions.delete(caseId);
    }
  }
}

function journeyASnowflakeSession(caseId, connectionName) {
  let session = activeJourneyASnowflakeSessions.get(caseId);
  if (!session || session.closed) {
    session = new PersistentSnowflakeSession({ connectionName });
    activeJourneyASnowflakeSessions.set(caseId, session);
  }
  session.expiresAt = Date.now() + JOURNEY_A_RUNTIME_SELECTION_TTL_MS;
  return session;
}

function closeJourneyASnowflakeSession(caseId) {
  const session = activeJourneyASnowflakeSessions.get(caseId);
  if (session) session.close();
  activeJourneyASnowflakeSessions.delete(caseId);
}

function startBulkContactVerification(run, caseId) {
  if (run.state !== "not_started") return;
  run.state = "pending";
  run.startedAt = Date.now();
  run.promise = verifyBulkContactDetailsWithSession({
    snapshotRows: run.snapshotRows,
    selections: run.selections,
    session: journeyASnowflakeSession(caseId, readJson(sourceConnectionPolicyPath).snowflake.connection_name),
    includeContactEmails: true,
  }).then((result) => {
    run.state = "completed";
    run.result = result;
    run.completedAt = Date.now();
  }).catch((error) => {
    run.state = "failed";
    run.errorCode = /^BULK_CONTACT_[A-Z_]+$/.test(error?.code || "") ? error.code : "BULK_CONTACT_DETAILS_FAILED";
    run.completedAt = Date.now();
  });
}

function retainMeetingPrepCallSelections({ candidateResult, testerId }) {
  pruneJourneyARuntimeState();
  for (const [selectionRef, selection] of candidateResult.runtimeSelectionByRef || []) {
    activeMeetingPrepCallSelections.set(selectionRef, {
      ...selection,
      testerId,
      expiresAt: Date.now() + JOURNEY_A_RUNTIME_SELECTION_TTL_MS,
    });
  }
}

function startMeetingPrepCallLookup({ testerId, kind, read }) {
  const policy = readJson(sourceConnectionPolicyPath).snowflake;
  const startedAt = Date.now();
  return activeMeetingPrepCallLookups.start({
    ownerRef: testerId,
    kind,
    read: async (onProgress) => {
      const session = new PersistentSnowflakeSession({ connectionName: policy.connection_name });
      try {
        const candidates = await read({ session, onProgress });
        retainMeetingPrepCallSelections({ candidateResult: candidates, testerId });
        return { ...candidates, first_response_ms: Date.now() - startedAt, read_at: candidates.read_at };
      } finally {
        session.close();
      }
    },
  });
}

function consumeMeetingPrepCallSelection({ selectionRef, testerId }) {
  pruneJourneyARuntimeState();
  const selection = activeMeetingPrepCallSelections.get(selectionRef);
  if (!selection || selection.testerId !== testerId) {
    throw new BetaError("MEETING_PREP_CALL_SELECTION_EXPIRED", "The selected Gong call is no longer available. Search or validate the call again; no customer data was saved.");
  }
  // The source reference is held only for this hand-off to the authorized
  // case constructor. Removing it first prevents a stale selection or raw
  // reference from being reused by another call.
  activeMeetingPrepCallSelections.delete(selectionRef);
  return selection;
}

function renewalRunFor({ caseId, runId, testerId }) {
  const run = activeRenewalConversationRuns.get(runId);
  if (!run || run.expiresAt <= Date.now() || run.caseId !== caseId || run.testerId !== testerId) {
    throw new BetaError("RENEWAL_EVIDENCE_RUN_EXPIRED", "The renewal evidence is no longer available. Select the renewal CTA again; no customer data was saved.");
  }
  return run;
}

function activeRenewalRunForCase({ caseId, testerId }) {
  return [...activeRenewalConversationRuns.entries()].find(([, run]) => (
    run.caseId === caseId
      && run.testerId === testerId
      && run.expiresAt > Date.now()
      && ["collecting", "needs_csm_decision", "evidence_ready", "evidence_ready_with_gaps", "native_fit_required", "review_ready", "draft_action_pending"].includes(run.state)
  )) || null;
}

function activeRenewalBlocksContactResearch(record) {
  const state = record.renewal_conversation?.evidence_state;
  return ["collecting", "needs_csm_decision", "evidence_ready", "evidence_ready_with_gaps", "native_fit_required", "review_ready", "draft_action_pending"].includes(state);
}

function renewalCsmEvidence(run, displayFocus = null, displayDetails = null) {
  if (!run.evidence) {
    return {
      status: "collecting",
      selected_cta: run.selectedCta,
      next_action: "Still preparing this selected renewal account. No action is needed from you.",
    };
  }
  return {
    case_id: run.caseId,
    status: ["native_fit_required", "review_ready", "draft_action_pending"].includes(run.state) ? run.state : run.evidence.status,
    selected_cta: run.selectedCta,
    source_gap_codes: run.evidence.review_package.source_gaps,
    content_readiness: run.evidence.review_package.content_readiness,
    customer_content_review: run.evidence.review_package.csm_content_review_display,
    frozen_deck_content: run.deckContent || null,
    execution_receipt: run.executionReceipt,
    review_window: renewalReviewWindow(run),
    account_brief_display: buildAccountIntelligenceDisplay(run.evidence.review_package.shared_account_intelligence, { displayFocus, displayDetails }),
    default_presentation: "Show account_brief_display.markdown as the one concise CSM brief. Deliver available charts and the short data limits. Detailed monthly values and source definitions are available on request; do not rewrite the brief as bullets.",
  };
}

function renewalReviewWindow(run) {
  return {
    begins_after: "evidence_collection_finishes",
    duration_seconds: JOURNEY_A_RUNTIME_SELECTION_TTL_MS / 1000,
    expires_at: new Date(run.expiresAt).toISOString(),
    remaining_seconds: Math.max(0, Math.ceil((run.expiresAt - Date.now()) / 1000)),
    extends_on_activity: false,
    after_expiry: "Repeat the governed CTA and account reads. Expired evidence and wording cannot be recovered from saved receipts.",
  };
}

function beginRenewalReviewWindow(runId, run) {
  const now = Date.now();
  // A late result from a stopped/expired run must not revive evidence or case
  // approvals. Only a still-active managed collection gets one review window.
  if (activeRenewalConversationRuns.get(runId) !== run || run.expiresAt <= now) {
    if (activeRenewalConversationRuns.get(runId) === run) activeRenewalConversationRuns.delete(runId);
    return false;
  }
  if (run.reviewStartedAt == null) {
    run.reviewStartedAt = now;
    run.expiresAt = now + JOURNEY_A_RUNTIME_SELECTION_TTL_MS;
  }
  return true;
}

function queueSelectionKey(caseId, workItemRef) {
  return `${caseId}:${workItemRef}`;
}

function loadRuntime() {
  if (
    process.env.CSM_COPILOT_BETA_REQUIRE_CENTRAL === "true" &&
    !process.env.CSM_COPILOT_BETA_MANIFEST_PATH
  ) {
    throw new BetaError(
      "CENTRAL_CONTROL_REQUIRED",
      "The central approved-version manifest path is required for this beta configuration.",
    );
  }
  const limitedBetaRuntime = readJson(limitedBetaRuntimePath);
  const privateCredentialState = fs.existsSync(ownerCredentialStatePath)
    ? readJson(ownerCredentialStatePath)
    : null;
  const presenterProfileStatus = readPresenterProfile(ownerPresenterProfilePath);
  const baseCredentialState = limitedBetaRuntime.mode === "limited_beta"
    ? {
      ...limitedBetaRuntime,
      ...(privateCredentialState || {}),
    }
    : readJson(credentialStatePath);
  return {
    manifest: readJson(manifestPath),
    credentialState: applyPresenterProfileStatus(baseCredentialState, presenterProfileStatus),
    signatureProfile: signatureProfileStatus(ownerSignatureProfilePath),
    feedbackFormConfig: readJson(feedbackFormConfigPath),
    limitedBetaRuntime,
    privateCredentialState,
    ownerAssistedDevelopmentControls: fs.existsSync(ownerAssistedDevelopmentControlsPath)
      ? readJson(ownerAssistedDevelopmentControlsPath)
      : null,
  };
}

function assertWorkflow(workflow) {
  if (!["daily_focus", "outreach", "portfolio_analytics", "meeting_prep", "renewal_conversation_brief"].includes(workflow)) {
    throw new BetaError(
      "WORKFLOW_REQUIRED",
      "Choose Daily Focus, Account Prioritization and Outreach, Book of Business Analysis, Customer Planning and Meeting Prep, or Renewal Conversation Brief before checking setup.",
    );
  }
}

function workflowJourney(workflow) {
  return workflow === "meeting_prep" ? "journey_b" : "journey_a";
}

function snowflakeSetupOptions() {
  const policy = readJson(sourceConnectionPolicyPath).snowflake;
  return {connectionName: policy.connection_name, approvedReadOnlyRoles: policy.approved_read_only_roles,
    templatePath: path.join(ownerPrivateConfigDir, 'snowflake-setup-template.json'),
    descriptorPath: path.join(ownerPrivateConfigDir, 'release-descriptor.json'), packageVersion: installedPackageManifest.version};
}

function pendingSnowflakePrerequisites(runtime) {
  // Invented workflows never inspect the operator's local source configuration.
  // An already verified connection remains governed by its normal live checks.
  if (runtime.credentialState.mode !== 'limited_beta' || runtime.credentialState.snowflake?.state === 'connected'
      && runtime.credentialState.snowflake?.read_only_verified === true) return null;
  return inspectSnowflakeSetup(snowflakeSetupOptions());
}

function requireSnowflakeSetupApproval() {
  const runtime = loadRuntime();
  validatePackagePreflight({manifest: runtime.manifest, packageRoot,
    expectedPackageName: installedPackageManifest.name, expectedPackageVersion: installedPackageManifest.version});
  if (runtime.manifest.status !== 'approved_for_limited_beta' || runtime.limitedBetaRuntime?.mode !== 'limited_beta') {
    throw new BetaError('SNOWFLAKE_LOCAL_SETUP_NOT_APPROVED', 'This package is not approved for real Snowflake setup. No software, configuration or source permissions were changed.');
  }
  return runtime;
}

function capabilitySetupStatus(workflow) {
  assertWorkflow(workflow);
  const runtime = loadRuntime();
  const packageResult = validatePackagePreflight({
    manifest: runtime.manifest,
    packageRoot,
    expectedPackageName: installedPackageManifest.name,
    expectedPackageVersion: installedPackageManifest.version,
  });
  const result = applySnowflakeSetupStatus(evaluateCapabilityReadiness({
    credentialState: runtime.credentialState,
    packageResult,
    workflow,
    signatureStatus: runtime.signatureProfile,
  }), pendingSnowflakePrerequisites(runtime));
  if (result.status === "ready") recordRegisterEvent({ eventType: "setup_ready", result, status: "ready" });
  return { runtime: { ...runtime, testerId: result.operator_ref }, packageResult, result };
}

function currentPackageStatus() {
  const approved = readJson(manifestPath);
  const onDisk = readJson(path.join(packageRoot, ".codex-plugin", "plugin.json"));
  return assessLoadedPackageVersion({
    loadedVersion: installedPackageManifest.version,
    diskVersion: onDisk.version,
    approvedVersion: approved.package_version,
  });
}

function publicWorkflowStatus(workflow, setupStatus, preparationMode) {
  const mode = meetingPreparationMode(workflow, preparationMode);
  const packageStatus = currentPackageStatus();
  const runtime = loadRuntime();
  let executionApproval = "approval_required";
  let components=null,rendererCompatibility={state:"not_checked"};
  try { components=expectedReleaseComponents(); }
  catch { rendererCompatibility={state:"component_mismatch",next_action:"Reconcile the plugin, exact renderer bundle and approved master binding before creating a draft. Read-only workflows are unaffected."}; }
  if (runtime.manifest?.constraints?.external_reads === true) {
    try {
      validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
      executionApproval = "approved";
    } catch {
      // Readiness reports only the approval state, never private control details.
    }
  }
  return {
    package_status: packageStatus,
    connection_setup: { state: setupStatus },
    release_components: rendererCompatibility.state==="component_mismatch" ? rendererCompatibility : components ? { state: "frozen_component_contract_available", native_contract: components.native_contract, renderer_verification:"not_checked_this_session" }
      : { state: "development_unfrozen", meaning: "Read-only checks may run; no compatible release is frozen for sharing." },
    execution_approval: { state: executionApproval },
    workflow_readiness: summarizeWorkflowReadiness({
      workflow,
      availableTools: visibleTools.map((tool) => tool.name),
      setupStatus,
      packageStatus,
      executionApproval,
      observations: workflowSourceObservations,
      rendererCompatibility,
      ...(mode ? { preparationMode: mode } : {}),
    }),
  };
}

function connectionStatus({ workflow, preparation_mode } = {}) {
  assertWorkflow(workflow);
  const mode = meetingPreparationMode(workflow, preparation_mode);
  const version = currentPackageStatus();
  if (version.state !== "matched") return {
    status: version.state,
    workflow,
    ...publicWorkflowStatus(workflow, "not_checked", mode || undefined),
    next_action: version.next_action,
  };
  const status = setupStatus({ workflow, preparation_mode });
  if (workflow !== "meeting_prep" || mode === "account_brief") {
    const snowflake = status.runtime.privateCredentialState?.snowflake || { state: "not_connected", read_only_verified: false };
    const readiness = publicWorkflowStatus(workflow, status.result.status, mode || undefined);
    const { capabilities, ...setupResult } = status.result;
    return {
      ...setupResult,
      setup_capabilities: capabilities,
      ...readiness,
      status: readiness.workflow_readiness.state,
      workflow,
      snowflake_zdp: snowflake,
      google_renderer: { state: "not_required" },
      presenter_profile: { state: "not_required" },
      renderer_mode: "not_required",
      gmail_signature: status.runtime.signatureProfile,
    };
  }
  const runtime = loadRuntime();
  const profile = readPresenterProfile(ownerPresenterProfilePath);
  const snowflake = runtime.privateCredentialState?.snowflake || { state: "not_connected", read_only_verified: false };
  const google = runtime.privateCredentialState?.google || { state: "not_connected", private_draft_scope_verified: false };
  const manualRenderer = runtime.privateCredentialState?.manual_renderer || { state: "not_configured" };
  const rendererMode = runtime.limitedBetaRuntime?.renderer_mode || "api_executable";
  let nextAction = null;
  if (snowflake.state !== "connected" || snowflake.read_only_verified !== true) {
    nextAction = status.result.next_action || { code: "CONNECT_SNOWFLAKE_ZDP", title: "Connect Snowflake/ZDP", instruction: "Run the Snowflake connection step and complete browser SSO if prompted." };
  } else if (profile.status !== "ready") {
    nextAction = profile.next_action;
  } else if (rendererMode === "manual_bound_script" && manualRenderer.state !== "ready") {
    nextAction = { code: "AUTHORIZE_MANUAL_RENDERER", title: "Authorize the private master-deck renderer", instruction: "Open your private master deck, choose CSM Copilot > Open private renderer, complete Google's authorization prompt, then confirm that the renderer opened." };
  } else if (rendererMode !== "manual_bound_script" && (google.state !== "connected" || google.private_draft_scope_verified !== true)) {
    nextAction = { code: "CONNECT_GOOGLE_RENDERER", title: "Connect Google and the renderer", instruction: "Run the Google renderer connection step and complete browser sign-in." };
  }
  const readiness = publicWorkflowStatus(workflow, nextAction ? "action_required" : status.result.status, mode || undefined);
  return {
    ...readiness,
    status: readiness.workflow_readiness.state,
    snowflake_zdp: snowflake,
    google_renderer: rendererMode === "manual_bound_script" ? { state: "manual", authorized: manualRenderer.state === "ready" } : google,
    renderer_mode: rendererMode,
    presenter_profile: profile,
    next_action: nextAction,
  };
}

function baseSetupStatus() {
  const runtime = loadRuntime();
  const packageResult = validatePackagePreflight({
    manifest: runtime.manifest,
    packageRoot,
    expectedPackageName: installedPackageManifest.name,
    expectedPackageVersion: installedPackageManifest.version,
  });
  const result = applySnowflakeSetupStatus(evaluateOnboarding({ credentialState: runtime.credentialState, packageResult }), pendingSnowflakePrerequisites(runtime));
  if (result.status === "ready") {
    recordRegisterEvent({ eventType: "setup_ready", result, status: "ready" });
  }
  return { runtime: { ...runtime, testerId: result.operator_ref }, packageResult, result };
}

function journeyASetupStatus() {
  const status = baseSetupStatus();
  const result = evaluateJourneyAReadiness({
    credentialState: status.runtime.credentialState,
    packageResult: status.packageResult,
  });
  if (result.status === "ready") {
    recordRegisterEvent({ eventType: "setup_ready", result, status: "ready" });
  }
  return { ...status, result };
}

function setupStatus({ workflow, preparation_mode } = {}) {
  const mode = meetingPreparationMode(workflow, preparation_mode);
  const status = capabilitySetupStatus(mode === "account_brief" ? "portfolio_analytics" : workflow);
  return mode ? { ...status, result: { ...status.result, workflow, preparation_mode: mode } } : status;
}

async function sharedSourcesHealth(runtime) {
  return activeNativeRenewalSources.health(runtime.testerId);
}

async function setupWizardStatus(workflow = 'all') {
  const outreach = capabilitySetupStatus("outreach");
  const runtime = outreach.runtime;
  const presenter = readPresenterProfile(ownerPresenterProfilePath);
  const rendererMode = runtime.limitedBetaRuntime?.renderer_mode || "api_executable";
  const manualRenderer = runtime.privateCredentialState?.manual_renderer || { state: "not_configured" };
  const renderer = rendererMode === "manual_bound_script"
    ? { state: manualRenderer.state === "ready" ? "ready" : "action_required", next_action: manualRenderer.state === "ready" ? null : {
      code: "AUTHORIZE_MANUAL_RENDERER",
      title: "Authorize the private deck renderer",
      instruction: "Open your private master deck, choose CSM Copilot > Open private renderer, complete Google authorization, then resume the setup wizard.",
    } }
    : { state: runtime.privateCredentialState?.google?.state === "connected" ? "ready" : "action_required", next_action: {
      code: "CONNECT_GOOGLE_RENDERER", title: "Connect the private deck renderer", instruction: "Complete the approved Google browser sign-in, then resume the setup wizard.",
    } };
  const sharedSources = await sharedSourcesHealth(runtime);
  return buildSetupWizardStatus({
    core: outreach.result,
    signature: runtime.signatureProfile,
    salesforce: runtime.privateCredentialState?.salesforce_cli || { state: "not_configured" },
    presenter,
    renderer,
    sharedSources,
    dependencyChecklist: dependencyChecklist({ workflow }),
  });
}

function requireReady() {
  const status = baseSetupStatus();
  if (status.result.status !== "ready") {
    throw new BetaError("SETUP_REQUIRED", status.result.next_action.title, status.result.next_action);
  }
  return status;
}

function requireJourneyAReady() {
  const status = setupStatus({ workflow: "outreach" });
  if (status.result.status !== "ready") {
    throw new BetaError("SETUP_REQUIRED", status.result.next_action.title, status.result.next_action);
  }
  return status;
}

function requireDailyFocusReady() {
  const status = setupStatus({ workflow: "daily_focus" });
  if (status.result.status !== "ready") {
    throw new BetaError("SETUP_REQUIRED", status.result.next_action.title, status.result.next_action);
  }
  return status;
}

function requirePortfolioAnalyticsReady() {
  const status = setupStatus({ workflow: "portfolio_analytics" });
  if (status.result.status !== "ready") {
    throw new BetaError("SETUP_REQUIRED", status.result.next_action.title, status.result.next_action);
  }
  return status;
}

function accountAccessMode(runtime) {
  const saved = fs.existsSync(ownerAccountAccessModePath) ? readJson(ownerAccountAccessModePath).mode : 'csm_book';
  return { mode: saved === 'manager_account_search' ? saved : 'csm_book',
    manager_search_enabled: runtime.manifest?.constraints?.manager_account_search === true,
    source_permissions_granted: false, owned_book_inherited: false };
}

function managerAuthority(runtime) {
  validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
  if (runtime.manifest?.constraints?.manager_account_search !== true) {
    throw new BetaError('MANAGER_SEARCH_NOT_ENABLED', 'This release has not enabled bounded manager account lookup. No account read or permission change occurred.');
  }
  const policy = readJson(sourceConnectionPolicyPath).snowflake;
  return { identitySubject: runtime.credentialState.identity?.subject,
    connectionName: policy.connection_name, approvedReadOnlyRoles: policy.approved_read_only_roles };
}

function managerSelection(args, runtime) {
  if (!args.manager_account_selection_ref) return null;
  managerAuthority(runtime);
  return activeManagerAccountSearches.select({ ownerRef: runtime.testerId, selectionRef: args.manager_account_selection_ref });
}

function casePath(caseId) {
  if (!/^[0-9a-f-]{36}$/i.test(caseId || "")) {
    throw new BetaError("INVALID_CASE_ID", "case_id is invalid.");
  }
  return path.join(stateDir, `${caseId}.json`);
}

function readCase(caseId) {
  const target = casePath(caseId);
  if (!fs.existsSync(target)) throw new BetaError("CASE_NOT_FOUND", "The beta case was not found.");
  return readJson(target);
}

function currentMeetingPrepBriefCase(caseId, runtime) {
  const record = readCase(caseId);
  if (record.tester_id !== runtime.testerId) throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  if (record.package_version !== runtime.manifest.package_version || record.renderer_baseline !== runtime.manifest.renderer_baseline) {
    throw new BetaError("CASE_VERSION_MISMATCH", "The case was created with a different approved package.");
  }
  if (record.case_kind !== "real_authorized" || !record.account_ref_digest) {
    throw new BetaError("MEETING_PREP_ACCOUNT_SCOPE_REQUIRED", "This case has no selected in-book account reference. Start the brief with the account name.");
  }
  return record;
}

function writeCase(record) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(casePath(record.case_id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

const outreachEmailScopeProperties = {
  email_ref: { type: "string", pattern: "^[a-f0-9-]{36}$", description: "Individual email reference from beta_prepare_outreach_email; always pair with email_revision." },
  email_revision: { type: "integer", minimum: 1, description: "This email's wording revision; revision remains the shared case revision." },
};
const tools = [
  {
    name: "beta_setup_status",
    description: "Check workflow readiness. Meeting preparation defaults to account_brief: read-only source access only, no recording, case, presenter or Slides setup. Use selected_call only for explicitly requested recording-backed preparation. Other workflow requirements are unchanged.",
    inputSchema: {
      type: "object",
      properties: { workflow: { type: "string", enum: ["daily_focus", "outreach", "portfolio_analytics", "meeting_prep", "renewal_conversation_brief"] },
        preparation_mode: { type: "string", enum: ["account_brief", "selected_call"], description: "Meeting preparation only. Default account_brief never needs a recording or Slides." } },
      required: ["workflow"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_connection_status",
    description: "Check workflow connections without exposing credentials. Meeting preparation defaults to account_brief and does not require a recording or private renderer; selected_call preserves draft-workflow setup.",
    inputSchema: {
      type: "object",
      properties: { workflow: { type: "string", enum: ["daily_focus", "outreach", "portfolio_analytics", "meeting_prep", "renewal_conversation_brief"] },
        preparation_mode: { type: "string", enum: ["account_brief", "selected_call"] } },
      required: ["workflow"],
      additionalProperties: false,
    },
  },
  {
    name: 'beta_get_dependency_checklist',
    description: 'Show the complete ISMA dependency checklist before installing anything. Distinguish installed software, exposed tools, actual sign-in checks, missing components, blocked steps and optional dependencies. The host supplies bounded states from real plugin inventory and harmless probes; no credentials or source content. This never grants source permissions or reads customer data.',
    inputSchema: { type: 'object', properties: {
      workflow: { type: 'string', enum: ['all', 'daily_focus', 'portfolio_analytics', 'outreach', 'meeting_prep', 'renewal_conversation_brief', 'selected_call_deck', 'service_ownership'] },
      observations: { type: 'array', maxItems: 10, items: { type: 'object', properties: {
        dependency_id: { type: 'string', enum: DEPENDENCIES.map(item => item.id) }, installed: { type: 'boolean' }, tools_available: { type: 'boolean' },
        connection_state: { type: 'string', enum: ['verified', 'not_checked', 'sign_in_needed', 'blocked'] },
        evidence_source: { type: 'string', enum: ['host_inventory', 'native_probe'] },
      }, required: ['dependency_id', 'evidence_source'], additionalProperties: false } },
    }, additionalProperties: false },
  },
  {
    name: 'beta_install_setup_dependency',
    description: 'After explicit approval, execute the fixed approved installation recipe for missing Snowflake software or the Cerebro plugin. Reuse the same running job and approval across setup resumes. It never installs a package manager, uses sudo, changes security policy or source permissions. Other providers use their native host install/connect flow and return an honest handoff. Continue the returned installation rather than repeating approval or starting another job.',
    inputSchema: { type: 'object', properties: { dependency_id: { type: 'string', enum: DEPENDENCIES.map(item => item.id) },
      installation_authorized: { type: 'boolean' }, retry_failed: { type: 'boolean' } }, required: ['dependency_id', 'installation_authorized'], additionalProperties: false },
  },
  {
    name: 'beta_continue_setup_installation',
    description: 'Read the same approved installation progress or verified result. Give progress roughly every 20 seconds while running. A failed or uncertain installation gets one concrete recovery action; never request the same permission again or claim sign-in from installation success.',
    inputSchema: { type: 'object', properties: { install_ref: { type: 'string', pattern: '^[0-9a-f-]{36}$' } }, required: ['install_ref'], additionalProperties: false },
  },
  {
    name: "beta_start_setup_wizard",
    description: "Start the optional one-time setup wizard. It checks only local readiness and never creates a case or reads customer data.",
    inputSchema: { type: "object", properties: { workflow: { type: 'string', enum: ['all', 'daily_focus', 'portfolio_analytics', 'outreach', 'meeting_prep', 'renewal_conversation_brief', 'selected_call_deck', 'service_ownership'] } }, additionalProperties: false },
  },
  {
    name: "beta_setup_wizard_status",
    description: "Show the private setup wizard's next manual step and all completed steps.",
    inputSchema: { type: "object", properties: { workflow: { type: 'string', enum: ['all', 'daily_focus', 'portfolio_analytics', 'outreach', 'meeting_prep', 'renewal_conversation_brief', 'selected_call_deck', 'service_ownership'] } }, additionalProperties: false },
  },
  {
    name: "beta_resume_setup_wizard",
    description: "Resume the optional setup wizard after a browser sign-in or another manual step.",
    inputSchema: { type: "object", properties: { workflow: { type: 'string', enum: ['all', 'daily_focus', 'portfolio_analytics', 'outreach', 'meeting_prep', 'renewal_conversation_brief', 'selected_call_deck', 'service_ownership'] } }, additionalProperties: false },
  },
  {
    name: "beta_check_shared_sources",
    description: "Run the non-customer-data health check for shared renewal guidance. It never asks the CSM to configure templates.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "beta_record_salesforce_direct_verification",
    description: "Record that the CSM completed or skipped the optional Salesforce direct-verification browser setup. No credentials are accepted.",
    inputSchema: {
      type: "object",
      properties: { outcome: { type: "string", enum: ["ready", "skipped", "unavailable"] } },
      required: ["outcome"], additionalProperties: false,
    },
  },
  {
    name: "beta_get_gmail_signature_profile_status",
    description: "Check whether the CSM's private rich Gmail signature profile is ready. It does not return signature content.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "beta_save_gmail_signature_profile",
    description: "Save only a reviewed rich Gmail signature block and its inline images in private local Copilot state. Do not include any source email body, recipients, subject, or thread data.",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", minLength: 1, maxLength: 160000 },
        inline_assets: { type: "array", maxItems: 12, items: { type: "object", properties: {
          cid: { type: "string", maxLength: 120 }, mime_type: { type: "string", maxLength: 32 }, data_base64: { type: "string", maxLength: 2000000 },
        }, required: ["cid", "mime_type", "data_base64"], additionalProperties: false } },
      },
      required: ["html"], additionalProperties: false,
    },
  },
  {
    name: "beta_prepare_gmail_signature_test",
    description: "Return one recipient-free, unsent Gmail draft specification for verifying the saved signature. Call only after the CSM explicitly authorizes this test draft.",
    inputSchema: { type: "object", properties: { test_draft_authorized: { type: "boolean" } }, required: ["test_draft_authorized"], additionalProperties: false },
  },
  {
    name: "beta_confirm_gmail_signature_test",
    description: "Record that the CSM visually verified the private recipient-free Gmail signature test draft.",
    inputSchema: { type: "object", properties: { displayed_correctly: { type: "boolean" } }, required: ["displayed_correctly"], additionalProperties: false },
  },
  {
    name: "beta_get_gmail_signature_for_approved_draft",
    description: "Return the private signature MIME content only after the CSM approved the exact outreach email displayed in chat.",
    inputSchema: { type: "object", properties: { chat_draft_approved: { type: "boolean" } }, required: ["chat_draft_approved"], additionalProperties: false },
  },
  {
    name: "beta_remove_gmail_signature_profile",
    description: "Remove the private saved Gmail signature profile. Existing Gmail drafts are unchanged.",
    inputSchema: { type: "object", properties: { removal_confirmed: { type: "boolean" } }, required: ["removal_confirmed"], additionalProperties: false },
  },
  {
    name: "beta_prepare_snowflake_setup",
    description: "Read-only, offline first-run prerequisite check. Distinguishes missing software, missing connection configuration and readiness for browser sign-in. Returns one next action; never installs software, changes configuration or reads customer data.",
    inputSchema: {type: "object", properties: {}, additionalProperties: false},
  },
  {
    name: "beta_configure_snowflake_zdp",
    description: "After explicit local-setup approval, create only a missing named browser-SSO profile using the owner-private setup template and named handoff login hint. Preserves existing profiles, installs no software, never authenticates and does not establish identity or access.",
    inputSchema: {type: "object", properties: {local_configuration_authorized: {type: "boolean"}}, required: ["local_configuration_authorized"], additionalProperties: false},
  },
  {
    name: "beta_connect_snowflake_zdp",
    description: "Check local prerequisites first, then verify the named browser-SSO connection and approved read-only role. Missing software or configuration returns its setup action without opening sign-in. No customer data is queried.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "beta_connect_google_renderer",
    description: "Open the approved company Google browser sign-in and verify the private Apps Script renderer without creating a deck.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "beta_connect_google_shared_sources",
    description: "Check the Google Drive connection already available in the desktop app. Returns its native get_profile request; no separate OAuth client, credentials or browser grant is needed. This does not read sequence copy or create a presentation.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "beta_complete_google_shared_sources_connection",
    description: "Complete the issued native Google Drive profile check with its digest only. Connection readiness is not proof that renewal sequence copy was read. No credentials or personal profile fields are accepted.",
    inputSchema: { type: "object", properties: { connection_ref: { type: "string" }, connected: { type: "boolean" },
      profile_digest: { type: "string", pattern: "^[a-f0-9]{64}$" } }, required: ["connection_ref", "connected", "profile_digest"], additionalProperties: false },
  },
  {
    name: "beta_confirm_manual_renderer_ready",
    description: "Record that the CSM opened and authorized the approved renderer embedded in their private personal master deck.",
    inputSchema: {
      type: "object",
      properties: { renderer_opened: { type: "boolean" }, google_authorization_completed: { type: "boolean" } },
      required: ["renderer_opened", "google_authorization_completed"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_approve_recovery_design",
    description: "Owner-only: record the ID-free approved Customer Planning and Meeting Prep v3 fingerprint contract. This creates no deck and accepts no source binding, Drive ID, or customer content.",
    inputSchema: {
      type: "object",
      properties: {
        owner_approval_confirmed: { type: "boolean" },
        approved_design_contract: { type: "object" },
      },
      required: ["owner_approval_confirmed", "approved_design_contract"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_get_presenter_profile",
    description: "Check whether the CSM has confirmed their private personal master deck. The deck remains the authority for the presenter name, title, and photo.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "beta_confirm_personal_master",
    description: "Save the CSM's one-time confirmation that their private personal master deck contains their name, title, and photo. It does not collect or retain those details.",
    inputSchema: {
      type: "object",
      properties: { private_master_confirmed: { type: "boolean" } },
      required: ["private_master_confirmed"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_update_presenter_profile",
    description: "Save the CSM's presenter name and title privately after they personalize their own private master-deck copy and photo.",
    inputSchema: {
      type: "object",
      properties: {
        display_name: { type: "string", minLength: 1, maxLength: 80 },
        job_title: { type: "string", minLength: 1, maxLength: 100 },
        master_deck_personalized: { type: "boolean" },
        photo_personalized: { type: "boolean" },
      },
      required: ["display_name", "job_title", "master_deck_personalized", "photo_personalized"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_preflight",
    description: "Compatibility alias for beta_setup_status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "beta_route_workflow",
    description: "Route the request. Ordinary meeting preparation defaults to a case-free account_brief with recent-call summaries, not a recording search. Use selected_call only when the CSM explicitly asks to analyze a recording. An upcoming meeting date is not a recording-search date.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", enum: ["broad_focus", "outreach", "meeting_preparation", "success_plan", "presentation", "renewal_conversation_brief", "follow_up"] },
        preparation_mode: { type: "string", enum: ["account_brief", "selected_call"], description: "Meeting preparation only; defaults to account_brief." },
      },
      required: ["intent"],
      additionalProperties: false,
    },
  },
  {
    name: 'beta_get_account_access_mode',
    description: 'Show the account working mode and whether this release enables bounded manager lookup. A mode never grants permissions or inherits a CSM book.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'beta_set_account_access_mode',
    description: 'Save the user-selected account working mode. Manager mode searches named accounts under the actual approved source role and requires exact selection; it does not grant access or change owned CTAs or portfolio scope.',
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['csm_book', 'manager_account_search'] } }, required: ['mode'], additionalProperties: false },
  },
  {
    name: 'beta_search_manager_accounts',
    description: 'Search up to 25 account-name candidates under the signed-in user and actual approved read-only source role. Use for explicitly requested manager account work. No assigned CSM book, customer export, permission grant, recipient or approval is created. Select the exact returned account before existing brief or outreach reads.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 3, maxLength: 160 }, limit: { type: 'integer', minimum: 1, maximum: 25 }, exact: { type: 'boolean' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'beta_continue_manager_account_search',
    description: 'Continue the same owner-bound manager account search. Polling does not reread sources or extend the original selection window.',
    inputSchema: { type: 'object', properties: { manager_search_ref: { type: 'string', pattern: '^[0-9a-f-]{36}$' }, wait_seconds: { type: 'integer', minimum: 0, maximum: 20 } }, required: ['manager_search_ref'], additionalProperties: false },
  },
  {
    name: "beta_start_converge_call_lookup",
    description: "Resolve one named in-book account or an exact manager search selection, then return the scoped request for the approved native Converge MCP. Poll beta_continue_meeting_prep_call_lookup while account resolution runs. No CTA or transcript safety questionnaire is required.",
    inputSchema: {
      type: "object", properties: {
        account_name: { type: "string", minLength: 1, maxLength: 160 },
        manager_account_selection_ref: { type: 'string', pattern: '^[0-9a-f-]{36}$' },
        start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        query: { type: "string", minLength: 1, maxLength: 500, description: "Optional keywords; searches summaries lexically, not transcripts or semantic meaning." },
        keyword_search_requested: { type: "boolean", description: "True only when the CSM explicitly requested a keyword filter, not merely meeting preparation." },
      }, required: ["start_date", "end_date"], additionalProperties: false,
    },
  },
  {
    name: "beta_accept_converge_call_candidates",
    description: "Register a minimal projection of the executed native Converge list/search response. Return the next native page request when truncated, otherwise an opaque call picker. Never pass transcript text or arbitrary raw tool output.",
    inputSchema: {
      type: "object", properties: {
        converge_lookup_ref: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        calls: { type: "array", maxItems: 50, items: { type: "object", properties: {
          conversation_key: { type: "string", minLength: 1, maxLength: 512 },
          call_start_datetime: { type: "string", minLength: 1, maxLength: 64 },
          title: { type: "string", maxLength: 500 }, summary: { type: "string", maxLength: 6000 },
        }, required: ["conversation_key", "call_start_datetime"], additionalProperties: false } },
        truncated: { type: "boolean" },
      }, required: ["converge_lookup_ref", "calls", "truncated"], additionalProperties: false,
    },
  },
  {
    name: "beta_get_selected_converge_call_request",
    description: "Return the native get_customer_call request for the already chosen call. Execute it through Converge directly; do not run the legacy Snowflake transcript reader or ask additional eligibility questions.",
    inputSchema: { type: "object", properties: { case_id: { type: "string", pattern: "^[0-9a-f-]{36}$" } }, required: ["case_id"], additionalProperties: false },
  },
  {
    name: "beta_bind_converge_call_evidence",
    description: "Bind digests of the executed native full-call result and paraphrased findings to the selected case/account. Source status and linked account IDs come from the tool response, not user attestations. Never pass raw transcript text. This records evidence, not any CSM review approval.",
    inputSchema: {
      type: "object", properties: {
        case_id: { type: "string", pattern: "^[0-9a-f-]{36}$" }, revision: { type: "integer", minimum: 1 },
        call_read_ref: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        source_status: { type: "string", enum: ["transcript_available", "transcript_missing", "not_found", "source_failed"] },
        linked_account_ids: { type: "array", maxItems: 500, items: { type: "string", pattern: "^001[A-Za-z0-9]{15}$" } },
        source_result_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        evidence_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        finding_count: { type: "integer", minimum: 0, maximum: 500 },
        warning_codes: { type: "array", maxItems: 100, items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" } },
      }, required: ["case_id", "revision", "call_read_ref", "source_status", "linked_account_ids", "source_result_digest", "evidence_digest", "finding_count"], additionalProperties: false,
    },
  },
  {
    name: "beta_find_meeting_prep_call_candidates",
    description: "Compatibility-only synchronous call search; for new meeting-prep requests use beta_start_meeting_prep_call_candidates and beta_continue_meeting_prep_call_lookup so progress is visible. Finds up to 12 account-linked, metadata-only Gong calls on one Europe/Lisbon date. The result is a picker, not an automatic selection.",
    inputSchema: {
      type: "object",
      properties: {
        account_name: { type: "string", minLength: 1, maxLength: 160, description: "CSM's account wording, a distinctive name fragment, or a Salesforce account ID; exact Gainsight spelling is not required." },
        call_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Europe/Lisbon calendar date" },
      },
      required: ["account_name", "call_date"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_find_meeting_prep_call_candidates_in_range",
    description: "Compatibility-only synchronous range search; for new meeting-prep requests use beta_start_meeting_prep_call_candidates_in_range and beta_continue_meeting_prep_call_lookup so progress is visible. Searches one inclusive Europe/Lisbon window of up to 31 days; returned calls require an explicit choice.",
    inputSchema: {
      type: "object",
      properties: {
        account_name: { type: "string", minLength: 1, maxLength: 160, description: "CSM's account wording, a distinctive name fragment, or a Salesforce account ID; exact Gainsight spelling is not required." },
        start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "First included Europe/Lisbon calendar date" },
        end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Last included Europe/Lisbon calendar date; maximum 31 days from start" },
      },
      required: ["account_name", "start_date", "end_date"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_validate_meeting_prep_call_link",
    description: "Compatibility-only synchronous link validation; for new meeting-prep requests use beta_start_meeting_prep_call_link_validation and beta_continue_meeting_prep_call_lookup so progress is visible. Validates one pasted Gong call link against an in-book account without retaining the link or reading a transcript.",
    inputSchema: {
      type: "object",
      properties: {
        account_name: { type: "string", minLength: 1, maxLength: 160, description: "CSM's account wording, a distinctive name fragment, or a Salesforce account ID; exact Gainsight spelling is not required." },
        gong_call_url: { type: "string", minLength: 1, maxLength: 2048 },
      },
      required: ["account_name", "gong_call_url"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_create_meeting_prep_case_from_call_selection",
    description: "When the CSM chooses a shown call, call this immediately with its call_selection_ref. Do not search again. The current process holds it for up to 15 minutes. Creates a read-only meeting-prep case and stores only digests; an approved Converge selection needs no legacy transcript eligibility questionnaire.",
    inputSchema: {
      type: "object",
      properties: {
        call_selection_ref: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        language: { type: "string", pattern: "^[a-z]{2,3}(?:-[A-Z]{2})?$" },
      },
      required: ["call_selection_ref", "language"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_start_meeting_prep_account_brief",
    description: "Start the full read-only account brief. Use exactly one active case, in-book account name or opaque manager account selection. Manager selections are rechecked under the signed-in user's actual read-only role. No CTA or transcript is required.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        account_name: { type: "string", minLength: 1, maxLength: 160 },
        manager_account_selection_ref: { type: 'string', pattern: '^[0-9a-f-]{36}$' },
        refresh_requested_by_csm: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "beta_continue_meeting_prep_account_brief",
    description: "Wait up to 20 seconds for the account brief. When finished, execute display_delivery_request to get the approved final Markdown and copy it. Do not request display_details for ordinary preparation: those are optional raw fields only for an explicit detailed-evidence request. display_focus is a cache-only metric/peer selection. Keep the CSM informed while in_progress; no rereads or approvals.",
    inputSchema: {
      type: "object",
      properties: {
        account_brief_ref: { type: "string", pattern: "^[A-Za-z0-9_-]{24}$" },
        case_id: { type: "string", description: "Attach this fresh standalone brief to a case created after the read started. The owner, package and account must match; no repeat source read is needed." },
        wait_seconds: { type: "integer", minimum: 0, maximum: 20, default: 20 },
        display_focus: ACCOUNT_BRIEF_DISPLAY_FOCUS_SCHEMA,
        display_details: ACCOUNT_BRIEF_DISPLAY_DETAILS_SCHEMA,
      },
      required: ["account_brief_ref"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_get_meeting_prep_brief_display",
    description: "Get the finished account brief's approved final Markdown from the existing owner-bound cache. No source reread, case, approval or artifact. Copy the first text block verbatim into the final reply, with only the established recent-call Summary/Next steps edits; optional meeting questions go after it. Metadata is not part of the answer. Use this for ordinary meeting preparation, not display_details.",
    inputSchema: { type: "object", properties: {
      account_brief_ref: { type: "string", pattern: "^[A-Za-z0-9_-]{24}$" },
    }, required: ["account_brief_ref"], additionalProperties: false },
  },
  {
    name: "beta_get_account_brief_chart",
    description: "Return one native PNG from an existing owner-bound account brief without another source read. With explicit CSM authorization, create an expiring private local image outside the repository and embed its returned Markdown directly in the final reply. Images expire within 15 minutes and cleanup survives a stopped Copilot process. A tool image alone is not visible-delivery proof. No uploads or Slides.",
    inputSchema: { type: "object", properties: {
      account_brief_ref: { type: "string", pattern: "^[A-Za-z0-9_-]{24}$" },
      renewal_conversation_run_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
      case_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
      chart_id: { type: "string", minLength: 1, maxLength: 64 },
      local_file_delivery_authorized: { type: "boolean", default: false, description: "True only after the CSM authorized temporary local chart images with expiry and cleanup. Applies to this conversation's chart delivery only." },
    }, required: ["chart_id"], additionalProperties: false },
  },
  {
    name: "beta_start_selected_call_evidence",
    description: "After the CSM explicitly authorizes processing of the selected call and confirms no known restricted content, begin a managed, read-only source-side safety and transcript derivation. A call choice alone is not a content-safety confirmation. Return progress immediately; no raw transcript is returned.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        revision: { type: "integer", minimum: 1 },
        transcript_processing_authorized: { type: "boolean" },
        no_service_data: { type: "boolean" },
        no_sensitive_personal_data: { type: "boolean" },
        no_suspected_l5: { type: "boolean" },
      },
      required: ["case_id", "revision", "transcript_processing_authorized", "no_service_data", "no_sensitive_personal_data", "no_suspected_l5"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_continue_selected_call_evidence",
    description: "Wait up to 20 seconds for the selected call's source-side safety screen and derived findings. Keep the CSM informed; a failed safety or coverage check returns no findings.",
    inputSchema: {
      type: "object",
      properties: {
        evidence_ref: { type: "string", pattern: "^[A-Za-z0-9_-]{24}$" },
        wait_seconds: { type: "integer", minimum: 0, maximum: 20, default: 20 },
      },
      required: ["evidence_ref"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_create_authorized_case",
    description: "Owner-assisted compatibility path only. Standard meeting preparation must use the native call picker and beta_create_meeting_prep_case_from_call_selection; an unverified digest cannot select a call.",
    inputSchema: {
      type: "object",
      properties: {
        source_locator_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        language: { type: "string", pattern: "^[a-z]{2,3}(?:-[A-Z]{2})?$" },
        recording_present: { type: "boolean", description: "Source-derived eligibility check; do not ask the CSM to attest this." },
        transcript_processing_authorized: { type: "boolean" },
        no_service_data: { type: "boolean", description: "Source-derived eligibility check; do not ask the CSM to attest this." },
        no_sensitive_personal_data: { type: "boolean", description: "Source-derived eligibility check; do not ask the CSM to attest this." },
        no_suspected_l5: { type: "boolean", description: "Source-derived eligibility check; do not ask the CSM to attest this." },
        owner_assisted_authorization_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        account_ref_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        account_owner_ref_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["source_locator_digest", "language", "recording_present", "transcript_processing_authorized", "no_service_data", "no_sensitive_personal_data", "no_suspected_l5"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_owner_assisted_test_status",
    description: "Check whether this private owner development installation can run an explicitly authorized cross-account test. It is unavailable in the shared beta package.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "beta_authorize_owner_assisted_test",
    description: "Open one short-lived, one-time owner-only authorization for an explicitly approved cross-account test. Accepts privacy-safe digests only.",
    inputSchema: {
      type: "object",
      properties: {
        explicit_authorization_confirmed: { type: "boolean" },
        authorization_reference_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        scope_kind: { type: "string", enum: ["gong_call", "account_portfolio"] },
        scope_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        account_ref_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        account_owner_ref_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["explicit_authorization_confirmed", "authorization_reference_digest", "scope_kind", "scope_digest", "account_ref_digest", "account_owner_ref_digest"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_create_authorized_journey_a_case",
    description: "Create a read-only, draft-only Account Prioritization and Outreach case for the authenticated CSM after a direct CSM request. It does not require repeated consent fields.",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", pattern: "^[a-z]{2,3}(?:-[A-Z]{2})?$" },
        owner_assisted_authorization_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        owner_assisted_scope_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        account_ref_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        account_owner_ref_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["language"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_record_language_review",
    description: "Record a safe, structured review of customer-facing language. Do not paste customer text, names, emails, links, or source data.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        outcome: { type: "string", enum: ["reviewed_no_issue", "issues_found", "not_reviewed"] },
        issue_categories: {
          type: "array",
          items: { type: "string", enum: ["meaning_changed", "product_term", "grammar_or_wording", "tone_or_formality", "locale_formatting", "mixed_language", "text_fit_or_layout", "other"] },
          uniqueItems: true,
          maxItems: 8,
        },
      },
      required: ["case_id", "outcome"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_read_daily_focus_work_signals",
    description: "Read a small, transient digest of current-book owned CTA work signals for Daily Focus. This read does not create a case, select a CTA, save source content, or start outreach. It uses the governed 25-second CTA source deadline; a source limit or failure must remain visible.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "beta_read_owned_cta_queue",
    description: "Read one current, read-only CTA queue for this signed-in CSM. It shows only CTAs the CSM owns for accounts in their book, plus separate moved-account ownership warnings. For an unfiltered request, return the queue_display_table verbatim: it includes every returned CTA as rows in groups P0, P1, P2, P3, P4, then other open CTAs. Never collapse a group into a semicolon-separated paragraph, an ‘and others’ summary, a newest-items preview, or a New/P0-only subset.",
    inputSchema: {
      type: "object",
      properties: { case_id: { type: "string" } },
      required: ["case_id"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_get_renewal_sequence_guidance",
    description: "Show the approved renewal-sequence review rules for one P0 to P4 CTA. The sequence remains a guide and is never sent automatically.",
    inputSchema: {
      type: "object",
      properties: { case_id: { type: "string" }, priority: { type: "string", enum: ["P0", "P1", "P2", "P3", "P4"] } },
      required: ["case_id", "priority"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_resolve_renewal_sequence",
    description: "Start a case/account-bound read of the current approved renewal tracker through the Google Drive connection in the app. Execute each issued native request and continue with beta_continue_renewal_sequence. It is not ready until the exact reviewed guide's full text is read and its revision rechecked. No separate OAuth client, email approval or draft is created.",
    inputSchema: {
      type: "object",
      properties: { case_id: { type: "string" }, priority: { type: "string", enum: ["P0", "P1", "P2", "P3", "P4"] }, language: { type: "string", pattern: "^[a-z]{2,3}(?:-[A-Z]{2})?$" },
        language_variant: { type: "string", enum: ["EMEA", "LATAM", "Simplified", "Traditional"] } },
      required: ["case_id", "priority", "language"], additionalProperties: false,
    },
  },
  {
    name: "beta_continue_renewal_sequence",
    description: "Continue only the issued read-only native Google Drive request for the same case and account. Supply bounded file metadata or tracker values; for guide content supply only its file/content digests, complete character count and truncation state. Keep actual guide text in transient host memory, never pass raw copy, email, customer data or transcripts. A source failure is an incomplete result, not permission to invent guidance or create Gmail drafts.",
    inputSchema: { type: "object", properties: { case_id: { type: "string" }, renewal_source_ref: { type: "string" },
      tool_name: { type: "string", enum: ["get_profile", "search", "get_spreadsheet_metadata", "get_spreadsheet_range", "get_file_metadata", "get_document_text", "fetch"] },
      source_status: { type: "string", enum: ["ok", "timed_out", "unavailable"] }, result: { type: "object" } },
      required: ["case_id", "renewal_source_ref", "tool_name", "source_status", "result"], additionalProperties: false },
  },
  {
    name: "beta_read_portfolio_recent_relationships",
    description: "Start one managed read-only portfolio check for recent Salesforce relationship activity across the signed-in CSM's owned in-book CTA accounts. Returns temporary progress; continue it with beta_continue_portfolio_recent_relationships. The statement has its own 60-second execution limit, separate from connection startup and the CTA queue. Never reads Gong or transcripts; no automatic Salesforce retry.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        lookback_days: { type: "integer", minimum: 1, maximum: 180, default: 60 },
      },
      required: ["case_id"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_continue_portfolio_recent_relationships",
    description: "Continue the same temporary owner-and-case-bound relationship read. Reports progress or a completed bounded result; never starts or retries a query. A failed read cannot establish no recent contact.",
    inputSchema: {
      type: "object",
      properties: { case_id: { type: "string" }, relationship_read_ref: { type: "string" },
        wait_seconds: { type: "integer", minimum: 0, maximum: 20, default: 20 } },
      required: ["case_id", "relationship_read_ref"], additionalProperties: false,
    },
  },
  {
    name: "beta_get_book_of_business_analysis_capabilities",
    description: "Describe the read-only aggregate measures and dimensions available for Book of Business Analysis. It makes no customer-data read and clearly identifies dimensions whose authoritative source field is not yet mapped.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "beta_read_book_of_business_summary",
    description: "Compatibility-only synchronous book summary. Use beta_start_book_of_business_summary in CSM conversations so progress can be reported while the read runs. Returns current-book account count and Net ARR, optionally grouped by up to two approved dimensions.",
    inputSchema: {
      type: "object",
      properties: {
        dimensions: {
          type: "array",
          maxItems: 2,
          uniqueItems: true,
          items: { type: "string", enum: ["account_executive", "industry", "crm_region", "crm_sub_region", "cs_segment", "market_segment", "account_health", "renewal_manager"] },
          default: [],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "beta_query_book_of_business_accounts",
    description: "Compatibility-only synchronous current-book account query. Use beta_start_book_of_business_accounts in CSM conversations so progress can be reported while the read runs. It accepts only approved filters and columns, returns no raw identifiers or contacts, and writes nowhere.",
    inputSchema: {
      type: "object",
      properties: {
        filters: {
          type: "array",
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              field: { type: "string", enum: ["account_name", "industry", "company_type", "billing_country", "account_executive", "crm_region", "crm_sub_region", "cs_segment", "market_segment", "account_health", "renewal_manager", "copilot_paid_status", "copilot_snapshot_date"] },
              operator: { type: "string", enum: ["equals", "is_missing", "is_not_missing"] },
              value: { type: "string", minLength: 1, maxLength: 160 },
            },
            required: ["field", "operator"],
            additionalProperties: false,
          },
          default: [],
        },
        columns: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          uniqueItems: true,
          items: { type: "string", enum: ["account_name", "net_arr_usd", "industry", "company_type", "billing_country", "account_executive", "crm_region", "crm_sub_region", "cs_segment", "market_segment", "account_health", "renewal_manager", "copilot_paid_status", "copilot_snapshot_date", "account_mapping_state"] },
          default: ["account_name", "net_arr_usd"],
        },
        sort: {
          type: "object",
          properties: {
            field: { type: "string", enum: ["account_name", "net_arr_usd"] },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
          required: ["field", "direction"],
          additionalProperties: false,
        },
        limit: { type: "integer", minimum: 1, maximum: 250, default: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "beta_bind_derived_evidence",
    description: "Bind a privacy-safe digest and counts for transiently derived evidence. Raw transcript content is never accepted.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        evidence_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        finding_count: { type: "integer", minimum: 0, maximum: 500 },
        warning_codes: { type: "array", items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" }, maxItems: 50 },
      },
      required: ["case_id", "evidence_digest", "finding_count"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_bind_private_artifact",
    description: "Bind private draft and audit digests after an approved renderer completes. Raw Drive identifiers are never persisted.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        artifact_ref_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        audit_ref_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["case_id", "artifact_ref_digest", "audit_ref_digest"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_reopen_meeting_prep_recommendation_review",
    description: "When the CSM requests revised recommendations, reopen their review while retaining same-account evidence. Clears downstream approvals and creates no artifact or source read.",
    inputSchema: { type: "object", properties: { case_id: { type: "string" }, revision: { type: "integer", minimum: 1 },
      revision_requested_by_csm: { type: "boolean" } }, required: ["case_id", "revision", "revision_requested_by_csm"], additionalProperties: false },
  },
  {
    name: "beta_bind_meeting_prep_master_preflight",
    description: "Bind the read-only identifier-free inventory and exact component receipt captured from the current approved v3 private master to this case before slide-wording review. This creates no deck and records no customer content.",
    inputSchema: { type: "object", properties: {
      case_id: { type: "string" }, revision: { type: "integer", minimum: 1 }, master_inventory: { type: "object" },
    }, required: ["case_id", "revision", "master_inventory"], additionalProperties: false },
  },
  {
    name: "beta_prepare_meeting_prep_draft_review",
    description: "Validate and freeze the proposed customer content, optional metric decisions, current master inventory and exact maintained-library selections before human approval. Saves only digests, never customer copy, and creates no draft.",
    inputSchema: {
      type: "object", properties: {
        case_id: { type: "string" }, revision: { type: "integer", minimum: 1 }, bridge_input: { type: "object" },
        master_inventory: { type: "object", properties: { slide_count: { type: "integer" }, provider_revision: { type: "string", maxLength: 200 },
          renderer_components: { type: "object" }, native_fields: { type: "object" },
          supporting_templates: { type: "object", properties: Object.fromEntries([8,11,12,14,16,17].map(number=>[number,{type:"object"}])), additionalProperties:false },
        }, required: ["slide_count", "provider_revision"], additionalProperties: false },
      }, required: ["case_id", "revision", "bridge_input", "master_inventory"], additionalProperties: false,
    },
  },
  {
    name: "beta_render_private_draft",
    description: "Create one private native Google Slides draft with the approved Apps Script renderer and the CSM's private personalized master deck. PPTX, PowerPoint, export, conversion, and fallback renderers are not supported.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        revision: { type: "integer", minimum: 1 },
        private_draft_authorized: { type: "boolean" },
        bridge_input: { type: "object" },
      },
      required: ["case_id", "revision", "private_draft_authorized", "bridge_input"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_get_presentation_preferences",
    description: "Return the CSM's private default presentation style and the controls that cannot be overridden.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "beta_get_meeting_prep_build_requirements",
    description: "Read the packaged native field types, exact fit limits, allowed supporting layouts and source fingerprint algorithm before authoring slide copy. No customer sources, case mutation or artifact creation.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "beta_update_presentation_preferences",
    description: "Save approved presentation preferences privately on this computer.",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["balanced", "executive", "consultative", "operational"] },
        content_density: { type: "string", enum: ["low", "medium", "high"] },
        metric_detail: { type: "string", enum: ["selective", "detailed"] },
        product_explanation: { type: "string", enum: ["concise", "standard", "expanded"] },
        next_steps_tone: { type: "string", enum: ["direct", "collaborative", "action_oriented"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "beta_reset_presentation_preferences",
    description: "Remove the private preference file and return to the balanced default.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "beta_plan_case_presentation_style",
    description: "Bind an approved presentation style to a case revision. Changing it clears prior approvals.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        preset: { type: "string", enum: ["balanced", "executive", "consultative", "operational"] },
        content_density: { type: "string", enum: ["low", "medium", "high"] },
        metric_detail: { type: "string", enum: ["selective", "detailed"] },
        product_explanation: { type: "string", enum: ["concise", "standard", "expanded"] },
        next_steps_tone: { type: "string", enum: ["direct", "collaborative", "action_oriented"] },
      },
      required: ["case_id"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_create_invented_case",
    description: "Create a resumable invented-only beta case. No real customer data is accepted.",
    inputSchema: {
      type: "object",
      properties: { scenario: { type: "string", enum: Object.keys(SCENARIOS) } },
      required: ["scenario"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_case_status",
    description: "Return the package-bound status and next approval gate for an invented beta case.",
    inputSchema: {
      type: "object",
      properties: { case_id: { type: "string" } },
      required: ["case_id"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_case_journey_status",
    description: "Return the active workflow, its plain-language name, shared-context state, review gates, and completed handoffs.",
    inputSchema: {
      type: "object",
      properties: { case_id: { type: "string" } },
      required: ["case_id"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_workflow_status",
    description: "Return the active workflow, its plain-language name, shared-context state, review gates, and completed handoffs.",
    inputSchema: {
      type: "object",
      properties: { case_id: { type: "string" } },
      required: ["case_id"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_start_journey",
    description: "Start an approved workflow inside an existing package-bound beta case. Leaving active Customer Planning and Meeting Prep requires an explicit CSM abandonment confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" }, journey: { type: "string", enum: JOURNEYS },
        abandon_customer_planning: { type: "boolean" },
      },
      required: ["case_id", "journey"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_record_orchestration_run",
    description: "Bind one privacy-safe daily or account-evidence orchestration result to the shared case. It accepts no customer content or source identifiers.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" }, journey: { type: "string", enum: JOURNEYS },
        account_ref_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        duration_ms: { type: "integer", minimum: 0, maximum: 30000 },
        source_gap_codes: { type: "array", items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" }, maxItems: 10 },
      },
      required: ["case_id", "journey", "account_ref_digest", "duration_ms"], additionalProperties: false,
    },
  },
  {
    name: "beta_bind_journey_context",
    description: "Bind a CrossJourneyContextV1 digest, account digest, counts, and warnings. Customer content is never accepted by the control plugin.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        journey: { type: "string", enum: JOURNEYS },
        context_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        account_ref_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        context_version: { type: "string", enum: ["1.0.0"] },
        item_count: { type: "integer", minimum: 0, maximum: 1000 },
        warning_codes: { type: "array", items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" }, maxItems: 50 },
      },
      required: ["case_id", "journey", "context_digest", "account_ref_digest", "context_version", "item_count"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_register_selected_account",
    description: "Register one account selected from any approved, read-only in-book query. The runtime account ID is transient, is never written to the case, and lets account research continue without a CTA.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        account_runtime_id: { type: "string", pattern: "^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$" },
        selection_origin: { type: "string", enum: ["portfolio_query", "account_question", "handoff"] },
      },
      required: ["case_id", "account_runtime_id", "selection_origin"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_run_journey_a_contact_evidence",
    description: "Start Account Prioritization and Outreach evidence for one selected account. It returns the ranked shortlist immediately from the current selected-account contact snapshot within 25 seconds. Gmail, Salesforce activity, and Gong are optional context and never delay contacts.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        work_item_ref: { type: "string", pattern: "^[a-f0-9]{64}$" },
        account_selection_ref: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        manager_account_selection_ref: { type: 'string', pattern: '^[0-9a-f-]{36}$' },
      },
      required: ["case_id"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_run_bulk_contact_research",
    description: "Research contacts for 2 to 50 selected current CTA accounts in one 25-second read-only snapshot query. Return the priority shortlist immediately. Set include_copy_ready_emails only when explicitly requested; this starts a separate bounded same-account Salesforce verification, whose result is obtained with beta_get_bulk_contact_email_verification. It does not run Gmail, Salesforce activity, or Gong checks, or create a Clari Groove enrollment.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        work_item_refs: { type: "array", minItems: 2, maxItems: 50, uniqueItems: true, items: { type: "string", pattern: "^[a-f0-9]{64}$" } },
        include_copy_ready_emails: { type: "boolean", description: "Set true only for an explicit CSM request to show copy-ready email addresses. Addresses are returned only in this response and are never saved to the beta case." },
      },
      required: ["case_id", "work_item_refs"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_verify_bulk_contact_emails",
    description: "Start one managed 120-second Salesforce detail read for the same account/contact IDs in an existing bulk shortlist, when the CSM explicitly asks for actual email addresses. This never starts a new case or rereads the snapshot.",
    inputSchema: { type: "object", properties: {
      case_id: { type: "string" }, bulk_contact_research_ref: { type: "string", pattern: "^[0-9a-f-]{36}$" },
      explicit_email_request: { type: "boolean", const: true },
    }, required: ["case_id", "bulk_contact_research_ref", "explicit_email_request"], additionalProperties: false },
  },
  {
    name: "beta_get_bulk_contact_email_verification",
    description: "Read the progress or verified result of the same bulk contact email check. While pending, give the CSM a progress update roughly every 20 seconds. A failed check preserves the earlier snapshot shortlist and returns no addresses.",
    inputSchema: { type: "object", properties: {
      case_id: { type: "string" }, bulk_contact_research_ref: { type: "string", pattern: "^[0-9a-f-]{36}$" },
    }, required: ["case_id", "bulk_contact_research_ref"], additionalProperties: false },
  },
  {
    name: "beta_continue_journey_a_contact_evidence",
    description: "Automatically continue the same selected-account evidence run. Background account context, Salesforce activity and 180-day Gong metadata use serial statements capped at 120 seconds, a five-minute first pass and one five-minute timeout recovery. Report source_progress about every 20 seconds while running; return the finished state and gaps when complete. Existing metrics and contact rejection reasons stay visible. Read-only; no new account selection or approval is required.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        contact_evidence_run_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
      },
      required: ["case_id", "contact_evidence_run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_get_renewal_preparation_options",
    description: "For a selected P0–P4 renewal CTA, return the choice between the focused Renewal Conversation Brief and the existing full customer plan. An explicit Renewal Conversation Brief request can start the focused option directly.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        work_item_ref: { type: "string", pattern: "^[a-f0-9]{64}$" },
        explicitly_requested: { type: "boolean", default: false },
      },
      required: ["case_id", "work_item_ref"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_prepare_renewal_conversation_brief",
    description: "Start one managed renewal-evidence run for a selected P0–P4 renewal CTA. Immediately execute its continuation_request through beta_continue_renewal_preparation until it returns the complete prepared answer; do not ask the CSM for another prompt. It returns AccountIntelligenceCoreV1: the shared CSM account brief used by renewal and full planning, with every unavailable field stated explicitly. It includes CTA, Gainsight account context, profile, entitlement/adoption, team/setup, tech stack, support trends, and a non-blocking 180-day account-level Gong metadata digest. It never runs contact research, Gmail, Salesforce activity, transcript processing, QBR Express, raw CLI tools, or toolkit reports.",
    inputSchema: {
      type: "object",
      properties: { case_id: { type: "string" }, work_item_ref: { type: "string", pattern: "^[a-f0-9]{64}$" } },
      required: ["case_id", "work_item_ref"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_continue_renewal_preparation",
    description: "Default renewal continuation: wait on the existing selected-account read and return the complete approved brief, all customer-content candidates, authorized temporary chart Markdown and one next action. Never restart sources, create a draft or record approvals. Copy its first text block verbatim as the answer, including the opening note, headings, capitalization, punctuation and next action. Do not polish, restyle or append another chart offer or selection request; only the existing recent-call Summary/Next steps cells may be paraphrased from the same cached notes.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        renewal_conversation_run_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        wait_seconds: { type: "integer", minimum: 0, maximum: 25, default: 25 },
        local_file_delivery_authorized: { type: "boolean", default: false },
      },
      required: ["case_id", "renewal_conversation_run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_wait_for_renewal_conversation_evidence",
    description: "Continue waiting for the active selected renewal account. Call automatically after preparation starts; do not ask the CSM to send another message. At 25 seconds it returns a short still-preparing status, then this tool returns the final evidence state.",
    inputSchema: {
      type: "object",
      properties: { case_id: { type: "string" }, renewal_conversation_run_id: { type: "string", pattern: "^[0-9a-f-]{36}$" }, wait_seconds: { type: "integer", minimum: 1, maximum: 60, default: 25 } },
      required: ["case_id", "renewal_conversation_run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_get_renewal_conversation_evidence",
    description: "Show the cached CSM-only account overview and complete customer-content candidates. Optional display_details requests full sections from detail_catalog; display_focus chooses returned metric/peer refs. Full evidence remains in the same cache. No reread, receipt change, deck selection or approval occurs.",
    inputSchema: {
      type: "object",
      properties: { case_id: { type: "string" }, renewal_conversation_run_id: { type: "string", pattern: "^[0-9a-f-]{36}$" }, display_focus: ACCOUNT_BRIEF_DISPLAY_FOCUS_SCHEMA, display_details: ACCOUNT_BRIEF_DISPLAY_DETAILS_SCHEMA },
      required: ["case_id", "renewal_conversation_run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_add_renewal_csm_context",
    description: "Add one explicit CSM-provided fact to the current renewal review without changing approved source results. For AI Agents non-use, show its CSM provenance, customer-validation need, and unverified commercial access; offer one grounded prospective opportunity when measured ticket volume is available. No source read or external write occurs.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        renewal_conversation_run_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        revision: { type: "integer", minimum: 1 },
        context: { type: "string", enum: ["ai_agents_not_in_use"] },
        confirmed_by_csm: { type: "boolean", const: true },
      },
      required: ["case_id", "renewal_conversation_run_id", "revision", "context", "confirmed_by_csm"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_select_renewal_deck_content",
    description: "Select one to three progress cards and one to three linked opportunity/focus pairs. It proposes exact customer wording and issues a read-only native layout request with no customer content. Bind the actual capture before wording approval; rendering never shortens the approved text or drops selected cards.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        renewal_conversation_run_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        revision: { type: "integer", minimum: 1 },
        selected_metric_ids: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", minLength: 1 }, uniqueItems: true },
        selected_pair_ids: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", minLength: 1 }, uniqueItems: true },
      },
      required: ["case_id", "renewal_conversation_run_id", "revision", "selected_metric_ids", "selected_pair_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_bind_renewal_native_fit",
    description: "Bind the read-only layout returned by the compatible private renewal builder and check every selected subtitle and card before wording approval. The result must be the unedited native capture, not guessed dimensions or a fit claim. It creates no artifact and records no human approval.",
    inputSchema: {
      type: "object", properties: {
        case_id: { type: "string" }, revision: { type: "integer", minimum: 1 },
        renewal_conversation_run_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        native_fit_request_ref: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        native_result: { type: "object" },
      },
      required: ["case_id", "revision", "renewal_conversation_run_id", "native_fit_request_ref", "native_result"], additionalProperties: false,
    },
  },
  {
    name: "beta_revise_renewal_customer_copy",
    description: "Rebuild customer wording from the already reviewed renewal evidence and card selections under the installed copy contract. This tool cannot accept free-text edits. If the wording is unchanged, it does not create a revision or imply that CSM feedback was applied. A changed revision retains identity, evidence, and renewal-hypothesis review and requires customer-content review again.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        renewal_conversation_run_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        revision: { type: "integer", minimum: 1 },
        recheck_native_fit: { type: "boolean", description: "Use after a changed or expired native layout check. Keeps the selected cards, invalidates customer-content approval and returns a new read-only capture request." },
      },
      required: ["case_id", "renewal_conversation_run_id", "revision"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_record_renewal_partial_evidence_decision",
    description: "For one renewal account with incomplete or insufficient evidence after the managed run, record the CSM's choice: retry later or skip it. It never creates a reduced renewal deck.",
    inputSchema: {
      type: "object",
      properties: { case_id: { type: "string" }, renewal_conversation_run_id: { type: "string", pattern: "^[0-9a-f-]{36}$" }, decision: { type: "string", enum: ["retry_later", "skip"] } },
      required: ["case_id", "renewal_conversation_run_id", "decision"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_complete_renewal_conversation",
    description: "Close the current renewal account after explicit rendered review or a decision not to draft. Draft completion requires the server-issued handoff receipt, current revision, and CSM confirmation of creation and rendered review. It can complete after evidence memory expires or a restart, without retaining customer content. It does not verify renderer success or write to customer systems.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        renewal_conversation_run_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        outcome: { type: "string", enum: ["draft_created", "not_drafted", "retry_later", "skipped"] },
        revision: { type: "integer", minimum: 1 },
        draft_receipt_ref: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        private_draft_created_confirmed: { type: "boolean" },
        rendered_draft_reviewed: { type: "boolean" },
      },
      required: ["case_id", "renewal_conversation_run_id", "outcome"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_record_renewal_conversation_approval",
    description: "Record the next lightweight review gate for a Renewal Conversation Brief: identity, evidence, renewal hypotheses, then customer content.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        gate: { type: "string", enum: RENEWAL_CONVERSATION_REVIEW_GATES },
        revision: { type: "integer", minimum: 1 },
        note: { type: "string", maxLength: 240 },
      },
      required: ["case_id", "gate", "revision"], additionalProperties: false,
    },
  },
  {
    name: "beta_render_renewal_conversation_brief",
    description: "After review and explicit authorization, create exactly three private native Google Slides as a Renewal Conversation Brief. It never creates PPTX, exports, shares, sends, or changes CRM data.",
    inputSchema: {
      type: "object",
      properties: { case_id: { type: "string" }, revision: { type: "integer", minimum: 1 }, private_draft_authorized: { type: "boolean" } },
      required: ["case_id", "revision", "private_draft_authorized"], additionalProperties: false,
    },
  },
  {
    name: "beta_complete_journey_a_contact_evidence",
    description: "Complete the same managed account/contact evidence and attach its native account-context receipt. Call the finished read's completion_request before outreach review or an explicit email-address lookup. No caller-created context digest, new source read or approval is needed. Optional Gmail/activity/Gong checks must never delay the contact shortlist; unrequested Gmail metadata uses not_requested and count zero. Use the returned case revision for reviews and email preparation.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        contact_evidence_run_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        gmail_metadata_state: { type: "string", enum: ["checked", "timed_out", "unavailable", "not_requested"] },
        gmail_metadata_message_count: { type: "integer", minimum: 0, maximum: 25 },
        source_gap_codes: { type: "array", items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" }, maxItems: 10 },
      },
      required: [
        "case_id", "contact_evidence_run_id", "gmail_metadata_state", "gmail_metadata_message_count",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "beta_prepare_outreach_email",
    description: "Prepare one SEPARATE email for one verified contact, reusing this case's existing account evidence, contacts and current guide. For a second contact, call this again for that contact; it never adds them to the first email. Copy the complete contact_ref exactly. Immediately compose and SHOW THE COMPLETE UNAPPROVED CHAT EMAIL from existing evidence, guide and requested chat wording. This tool supplies the recipient and review scope, not subject/body generation; a pending contact/template/wording gate must not withhold the preview. Those approvals remain required before Gmail creation. Returns one recipient and email_ref/email_revision for this email's own approval, wording and draft controls. Other emails and their approvals or draft receipts stay unchanged. Repeated requests reuse the existing email; no source read, approval or Gmail draft is created.",
    inputSchema: { type: "object", properties: {
      case_id: { type: "string" }, revision: { type: "integer", minimum: 1 },
      contact_evidence_run_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
      contact_ref: { type: "string", pattern: "^[a-f0-9]{64}$" },
    }, required: ["case_id", "revision", "contact_evidence_run_id", "contact_ref"], additionalProperties: false },
  },
  {
    name: "beta_read_verified_contact_email",
    description: "Show one verified contact email only when the CSM explicitly asks for the address. Use the same case, current revision and completed native contact-evidence run. This cache-only read does not prepare or select an email, change approvals, extend expiry or create a Gmail draft. Never guess an address or accept a caller-supplied email.",
    inputSchema: { type: "object", properties: {
      case_id: { type: "string" }, revision: { type: "integer", minimum: 1 },
      contact_evidence_run_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
      contact_ref: { type: "string", pattern: "^[a-f0-9]{64}$" }, explicit_email_request: { type: "boolean", const: true },
    }, required: ["case_id", "revision", "contact_evidence_run_id", "contact_ref", "explicit_email_request"], additionalProperties: false },
  },
  {
    name: "beta_get_verified_outreach_recipient",
    description: "For separate emails to different contacts, use beta_prepare_outreach_email instead. This legacy handoff only changes the To field WITHIN ONE email when the CSM explicitly requests that. This handoff updates the case's selected recipients and returns its exact verified To list. Call it for EVERY To change within that email, including removal, even when the remaining addresses are already known. Editing only the chat header leaves the old case receipt and approvals unchanged. Only for an explicitly requested shared-To email, supply all chosen contact_refs in ONE call; never loop over single contacts. Copy each complete 64-character contact_ref exactly from the existing verified shortlist; never shorten or reconstruct it. Correct a malformed reference from that shortlist without source rereads; it is not evidence of a missing address. Use contact_ref only for a single recipient. Supply exactly one selection field. Reuse the same case, evidence run and valid guide; this does not start source reads. Use the returned To string verbatim and its address_digest for review/claim. Addresses stay in expiring memory; no approval or Gmail draft is created. No caller-supplied email or raw source ID is accepted.",
    inputSchema: { type: "object", properties: {
      case_id: { type: "string" }, revision: { type: "integer", minimum: 1 },
      contact_evidence_run_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
      contact_ref: { type: "string", pattern: "^[a-f0-9]{64}$" },
      contact_refs: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", pattern: "^[a-f0-9]{64}$" }, description: "Complete selected recipient list for one same-account email; replaces the prior To list atomically." },
    }, required: ["case_id", "revision", "contact_evidence_run_id"], additionalProperties: false },
  },
  {
    name: "beta_bind_outreach_draft_review",
    description: "Freeze only the digest of the exact displayed email and its native verified-recipient receipt before final approval. Never submit email content or addresses.",
    inputSchema: {type:"object",properties:{...outreachEmailScopeProperties,case_id:{type:"string"},revision:{type:"integer",minimum:1},content_digest:{type:"string",pattern:"^[a-f0-9]{64}$"},recipient_ref:{type:"string",pattern:"^[0-9a-f-]{36}$"},to_digest:{type:"string",pattern:"^[a-f0-9]{64}$"}},required:["case_id","revision","content_digest"],additionalProperties:false},
  },
  {
    name: "beta_claim_outreach_draft",
    description: "Authorize one host-native unsent Gmail draft for the exact reviewed content; repeated or uncertain writes stop for reconciliation.",
    inputSchema: {type:"object",properties:{...outreachEmailScopeProperties,case_id:{type:"string"},revision:{type:"integer",minimum:1},content_digest:{type:"string",pattern:"^[a-f0-9]{64}$"},recipient_ref:{type:"string",pattern:"^[0-9a-f-]{36}$"},to_digest:{type:"string",pattern:"^[a-f0-9]{64}$"},private_draft_authorized:{type:"boolean"}},required:["case_id","revision","content_digest","private_draft_authorized"],additionalProperties:false},
  },
  {
    name: "beta_complete_outreach_draft",
    description: "Record a confirmed host Gmail draft result without its identifier, recipient or text. An ambiguous failure never authorizes a duplicate retry.",
    inputSchema: {type:"object",properties:{...outreachEmailScopeProperties,case_id:{type:"string"},revision:{type:"integer",minimum:1},draft_request_ref:{type:"string"},provider_draft_created:{type:"boolean"}},required:["case_id","revision","draft_request_ref","provider_draft_created"],additionalProperties:false},
  },
  {
    name: "beta_record_journey_a_approval",
    description: "Record the next Account Prioritization and Outreach review gate for the current case revision.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" }, gate: { type: "string", enum: JOURNEY_A_GATES },
        ...outreachEmailScopeProperties,
        revision: { type: "integer", minimum: 1 }, note: { type: "string", maxLength: 240 },
        renewal_source_mode: { type: "string", enum: ["current_sequence", "evidence_only"], description: "Only at template_preview: record the CSM's explicit choice to use the currently read guide or proceed without sequence wording. This never skips contact or email approval." },
      },
      required: ["case_id", "gate", "revision"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_handoff_journey",
    description: "Move one beta case between named workflows using only the reviewed shared-context reference. Leaving Customer Planning and Meeting Prep requires an explicit CSM abandonment confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" }, from_journey: { type: "string", enum: JOURNEYS },
        to_journey: { type: "string", enum: JOURNEYS }, reason: { type: "string", enum: HANDOFF_REASONS },
        abandon_customer_planning: { type: "boolean" },
        revision: { type: "integer", minimum: 1 },
      },
      required: ["case_id", "from_journey", "to_journey", "reason", "revision"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_bind_recommendation_review_package",
    description: "Bind the privacy-safe digest and required coverage checklist for the standalone Customer Planning and Meeting Prep recommendation review. It accepts no customer content.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        revision: { type: "integer", minimum: 1 },
        review_package_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        recommendation_refs: { type: "array", items: { type: "string", pattern: "^recommendation:[1-9][0-9]{0,2}$" }, minItems: 1, maxItems: 50, uniqueItems: true },
        sections: { type: "array", items: { type: "string", enum: RECOMMENDATION_REVIEW_SECTIONS }, minItems: RECOMMENDATION_REVIEW_SECTIONS.length, maxItems: RECOMMENDATION_REVIEW_SECTIONS.length, uniqueItems: true },
      },
      required: ["case_id", "revision", "review_package_digest", "sections"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_record_approval",
    description: "Record the next human approval gate for the current case revision.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        gate: { type: "string", enum: GATES },
        revision: { type: "integer", minimum: 1 },
        note: { type: "string", maxLength: 240 },
      },
      required: ["case_id", "gate", "revision"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_submit_feedback",
    description: "Prepare the three-question feedback and a pre-filled Google Form for human review. This does not submit externally.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        revision: { type: "integer", minimum: 1 },
        would_use: { type: "string", enum: ["yes", "no", "unsure"] },
        saved_time: { type: "string", enum: ["yes", "no", "unsure"] },
        biggest_improvement: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["case_id", "revision", "would_use", "saved_time", "biggest_improvement"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_prepare_feedback_form",
    description: "Compatibility alias for beta_submit_feedback.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        revision: { type: "integer", minimum: 1 },
        would_use: { type: "string", enum: ["yes", "no", "unsure"] },
        saved_time: { type: "string", enum: ["yes", "no", "unsure"] },
        biggest_improvement: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["case_id", "revision", "would_use", "saved_time", "biggest_improvement"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_confirm_feedback_submitted",
    description: "Record the tester's confirmation that the reviewed Google Form was submitted.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: { type: "string" },
        revision: { type: "integer", minimum: 1 },
      },
      required: ["case_id", "revision"],
      additionalProperties: false,
    },
  },
];

const summaryReadInputSchema = tools.find((tool) => tool.name === "beta_read_book_of_business_summary").inputSchema;
const accountReadInputSchema = tools.find((tool) => tool.name === "beta_query_book_of_business_accounts").inputSchema;
const meetingDateInputSchema = tools.find((tool) => tool.name === "beta_find_meeting_prep_call_candidates").inputSchema;
const meetingRangeInputSchema = tools.find((tool) => tool.name === "beta_find_meeting_prep_call_candidates_in_range").inputSchema;
const meetingLinkInputSchema = tools.find((tool) => tool.name === "beta_validate_meeting_prep_call_link").inputSchema;
tools.push(
  {
    name: "beta_start_book_of_business_summary",
    description: "Start a read-only current-book aggregate in the background. Return a temporary read reference immediately; check progress with beta_continue_book_of_business_read until ready. A timed-out first attempt retries once for at most five minutes.",
    inputSchema: summaryReadInputSchema,
  },
  {
    name: "beta_start_book_of_business_accounts",
    description: "Start a read-only current-book account list in the background. Return a temporary read reference immediately; check progress with beta_continue_book_of_business_read until ready. A timed-out first attempt retries once for at most five minutes.",
    inputSchema: accountReadInputSchema,
  },
  {
    name: "beta_continue_book_of_business_read",
    description: "Check progress or retrieve the completed result of one temporary current-book read. Poll about every 20 seconds and keep the CSM informed while it runs.",
    inputSchema: {
      type: "object",
      properties: {
        book_read_ref: { type: "string", pattern: "^[A-Za-z0-9_-]{24}$" },
        wait_seconds: { type: "integer", minimum: 0, maximum: 20, default: 20 },
      },
      required: ["book_read_ref"],
      additionalProperties: false,
    },
  },
  {
    name: "beta_start_meeting_prep_call_candidates",
    description: "Start a read-only, account-linked Gong call search for one Lisbon date. Return a temporary lookup reference immediately; check progress with beta_continue_meeting_prep_call_lookup until ready. The result remains a CSM picker.",
    inputSchema: meetingDateInputSchema,
  },
  {
    name: "beta_start_meeting_prep_call_candidates_in_range",
    description: "Start one read-only, account-linked Gong metadata search for an inclusive Lisbon window of up to 31 days. Return a temporary lookup reference immediately; check progress with beta_continue_meeting_prep_call_lookup until ready.",
    inputSchema: meetingRangeInputSchema,
  },
  {
    name: "beta_start_meeting_prep_call_link_validation",
    description: "Start read-only validation of one pasted Gong link: resolve its numeric call ID to the transient opaque key, then verify that key belongs to the in-book account. Return a temporary lookup reference immediately; check progress with beta_continue_meeting_prep_call_lookup until ready. No transcript or call content is read.",
    inputSchema: meetingLinkInputSchema,
  },
  {
    name: "beta_continue_meeting_prep_call_lookup",
    description: "Wait up to 20 seconds for one temporary Gong call lookup and return current stage progress or its final candidate picker. Keep the CSM informed while it runs.",
    inputSchema: {
      type: "object",
      properties: {
        call_lookup_ref: { type: "string", pattern: "^[A-Za-z0-9_-]{24}$" },
        wait_seconds: { type: "integer", minimum: 0, maximum: 20, default: 20 },
      },
      required: ["call_lookup_ref"],
      additionalProperties: false,
    },
  },
);

function stripOwnerAssistedInputs(tool) {
  if (!ownerAssistedDisabled || !["beta_create_authorized_case", "beta_create_authorized_journey_a_case"].includes(tool.name)) {
    return tool;
  }
  const properties = { ...tool.inputSchema.properties };
  for (const name of ["owner_assisted_authorization_id", "owner_assisted_scope_digest", "account_ref_digest", "account_owner_ref_digest"]) {
    delete properties[name];
  }
  return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
}

const retiredPublicToolNames = new Set(["beta_case_journey_status", ...(installedPackageManifest.name === 'isma'
  ? ['beta_get_gmail_signature_profile_status', 'beta_save_gmail_signature_profile', 'beta_prepare_gmail_signature_test', 'beta_confirm_gmail_signature_test', 'beta_get_gmail_signature_for_approved_draft'] : [])]);
const visibleTools = (ownerAssistedDisabled
  ? tools.filter((tool) => !ownerAssistedToolNames.has(tool.name))
  : tools)
  .filter((tool) => !retiredPublicToolNames.has(tool.name))
  .map(stripOwnerAssistedInputs);

function textResult(value, isError = false) {
  if (value?.account_brief_display && (value.account_brief_ref || value.renewal_conversation_run_id)) {
    const readArgs = value.account_brief_ref ? { account_brief_ref: value.account_brief_ref }
      : { renewal_conversation_run_id: value.renewal_conversation_run_id, case_id: value.case_id };
    const { account_brief: _rawAccountBrief, ...publicValue } = value;
    value = { ...publicValue,
      ...(value.account_brief_ref ? { display_delivery_request: { tool: "beta_get_meeting_prep_brief_display", arguments: { account_brief_ref: value.account_brief_ref } } } : {}),
      account_brief_display: { ...value.account_brief_display,
      chart_requests: (value.account_brief_display.charts || []).map((chart) => ({ tool: "beta_get_account_brief_chart", arguments: { ...readArgs, chart_id: chart.id } })) } };
  }
  const content = [{ type: "text", text: JSON.stringify(value, null, 2) }];
  // Brief reads return one structured review, not duplicate hidden images.
  // The owner-bound cached chart requests deliver one PNG at a time, with an
  // explicit visible-output instruction and no source reread or file export.
  return { content, isError };
}

function meetingPrepBriefPresentation(result, record, runtime, displayFocus = null, displayDetails = null) {
  pruneJourneyARuntimeState();
  const context = activeMeetingPrepCallReviewContexts.get(record.case_id);
  return projectMeetingPrepBrief(result, { caseRecord: record, ownerRef: runtime.testerId,
    selection: activeMeetingPrepSelectedCalls.get(record.case_id),
    evidenceAvailable: context?.ownerRef === runtime.testerId && context.digest === record.derived_evidence?.digest,
    displayFocus, displayDetails });
}

function publicContactRecommendations(recommendations) {
  return {
    recommended_contacts: recommendations.contacts,
    prioritized_contacts: recommendations.prioritized_contacts,
    secondary_executive_contacts: recommendations.secondary_executive_contacts,
    contact_recommendation_state: recommendations.state,
    contact_recommendation_message: recommendations.message,
    contact_counts: { total: recommendations.total_contact_count, eligible: recommendations.eligible_contact_count,
      excluded: recommendations.excluded_contact_count, shown: recommendations.contacts.length,
      prioritized: recommendations.prioritized_contact_count },
    contact_diagnostics: { rejection_summary: recommendations.rejection_summary,
      excluded_contacts: recommendations.excluded_contacts },
  };
}

function contactReadStatus(recommendations, sourceStates, readyStatus) {
  if (recommendations.contacts.length) return readyStatus;
  if (!recommendations.prioritized_contacts.length) return "no_eligible_contacts";
  return sourceStates?.contact_details === "pending" ? "contact_details_pending" : "contact_details_unavailable";
}

function outreachEvidenceProgress(run) {
  if (!run.sourceProgress) return null;
  return { ...run.sourceProgress,
    elapsed_seconds: Math.floor((Date.now() - run.slowEvidenceStartedAt) / 1000),
    stage_elapsed_seconds: Math.floor((Date.now() - run.slowEvidenceStageStartedAt) / 1000),
    source_elapsed_seconds: Math.floor((Date.now() - run.slowEvidenceSourceStartedAt) / 1000),
  };
}

function performanceMetricsRecoveryPending(run) {
  return run?.slowEvidenceState === "in_progress" &&
    ["rba_monthly_metrics", "guide_knowledge_views"].some(source => run.fastEvidence?.source_states?.[source] === "timed_out");
}

function assertPerformanceMetricsSettled(caseId) {
  if ([...activeJourneyAContactEvidenceRuns.values()].some(run => run.caseId === caseId && performanceMetricsRecoveryPending(run))) {
    throw new BetaError("PERFORMANCE_METRICS_PENDING", "The measured-support read is still in its bounded recovery. Continue the same evidence run before completing review or creating an outreach draft.");
  }
}

async function callTool(name, args = {}) {
  if (['beta_get_account_access_mode', 'beta_set_account_access_mode', 'beta_search_manager_accounts',
    'beta_continue_manager_account_search', 'beta_start_meeting_prep_account_brief',
    'beta_start_converge_call_lookup'].includes(name)) {
    const properties = tools.find(tool => tool.name === name).inputSchema.properties;
    if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new BetaError('INVALID_INPUT', 'Use only this control\'s bounded arguments and returned account selection references.');
  }
  if (name === 'beta_continue_manager_account_search' && args.wait_seconds !== undefined
    && (!Number.isInteger(args.wait_seconds) || args.wait_seconds < 0 || args.wait_seconds > 20)) throw new BetaError('INVALID_INPUT', 'Wait between zero and twenty seconds.');
  if (name === "beta_setup_status") {
    assertWorkflow(args.workflow);
    const mode = meetingPreparationMode(args.workflow, args.preparation_mode);
    const version = currentPackageStatus();
    if (version.state !== "matched") return textResult({
      status: version.state,
      workflow: args.workflow,
      ...publicWorkflowStatus(args.workflow, "not_checked", mode || undefined),
      next_action: version.next_action,
    });
    const setup = setupStatus({ workflow: args.workflow, preparation_mode: args.preparation_mode });
    const readiness = publicWorkflowStatus(args.workflow, setup.result.status, mode || undefined);
    const { capabilities, ...setupResult } = setup.result;
    return textResult({ ...setupResult, setup_capabilities: capabilities, ...readiness, status: readiness.workflow_readiness.state });
  }
  if (name === "beta_preflight") return textResult(setupStatus({ workflow: "outreach" }).result);
  if (name === "beta_connection_status") return textResult(connectionStatus({ workflow: args.workflow, preparation_mode: args.preparation_mode }));
  if (name === "beta_route_workflow") return textResult(routeWorkflowIntent(args.intent, { preparationMode: args.preparation_mode }));
  if (name === 'beta_get_dependency_checklist') return textResult(dependencyChecklist(args));
  if (name === 'beta_install_setup_dependency') {
    if (Object.keys(args).some(key => !['dependency_id', 'installation_authorized', 'retry_failed'].includes(key))) throw new BetaError('INVALID_INPUT', 'Use only the named dependency and its installation approval/retry. Commands, arguments, URLs and credentials are not accepted.');
    requireSnowflakeSetupApproval();
    return textResult(activeSetupInstallations.start({ dependencyId: args.dependency_id, installationAuthorized: args.installation_authorized, retryFailed: args.retry_failed }));
  }
  if (name === 'beta_continue_setup_installation') return textResult(activeSetupInstallations.read(args.install_ref));
  if (name === "beta_start_setup_wizard") return textResult(startSetupWizard(ownerSetupWizardPath, await setupWizardStatus(args.workflow)));
  if (name === "beta_setup_wizard_status") return textResult(await setupWizardStatus(args.workflow));
  if (name === "beta_resume_setup_wizard") return textResult(resumeSetupWizard(ownerSetupWizardPath, await setupWizardStatus(args.workflow)));
  if (name === "beta_check_shared_sources") {
    const runtime = loadRuntime();
    return textResult(await sharedSourcesHealth(runtime));
  }
  if (name === "beta_get_gmail_signature_profile_status") return textResult(signatureProfileStatus(ownerSignatureProfilePath));
  if (name === "beta_save_gmail_signature_profile") return textResult(saveSignatureProfile(ownerSignatureProfilePath, args));
  if (name === "beta_prepare_gmail_signature_test") {
    if (args.test_draft_authorized !== true) throw new BetaError("SIGNATURE_TEST_AUTHORIZATION_REQUIRED", "Confirm only when you want one recipient-free Gmail signature test draft.");
    return textResult(signatureTestDraft(ownerSignatureProfilePath));
  }
  if (name === "beta_confirm_gmail_signature_test") {
    if (args.displayed_correctly !== true) throw new BetaError("SIGNATURE_TEST_NOT_CONFIRMED", "Keep the signature profile unverified until the image and links display correctly.");
    return textResult(confirmSignatureTest(ownerSignatureProfilePath));
  }
  if (name === "beta_get_gmail_signature_for_approved_draft") {
    if (args.chat_draft_approved !== true) throw new BetaError("GMAIL_DRAFT_REVIEW_REQUIRED", "Approve the exact email shown in chat before retrieving the saved signature for a Gmail draft.");
    return textResult(readSignatureForApprovedDraft(ownerSignatureProfilePath));
  }
  if (name === "beta_remove_gmail_signature_profile") {
    if (args.removal_confirmed !== true) throw new BetaError("SIGNATURE_REMOVAL_CONFIRMATION_REQUIRED", "Confirm before removing the private saved signature profile.");
    return textResult(removeSignatureProfile(ownerSignatureProfilePath));
  }
  if (name === "beta_record_salesforce_direct_verification") {
    const existing = fs.existsSync(ownerCredentialStatePath) ? readJson(ownerCredentialStatePath) : {};
    const updated = writeCredentialState(ownerCredentialStatePath, { salesforce_cli: { state: args.outcome, blocking: false } }, existing);
    return textResult({ status: args.outcome, salesforce_direct_verification: updated.salesforce_cli, blocking: false });
  }
  if (name === "beta_approve_recovery_design") {
    if (args.owner_approval_confirmed !== true) {
      throw new BetaError("OWNER_APPROVAL_REQUIRED", "An owner must explicitly approve the private source design before it can be used for rendering.");
    }
    const approvedDesign = validateApprovedRecoveryDesignContract(args.approved_design_contract);
    fs.mkdirSync(ownerPrivateConfigDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(ownerApprovedRecoveryDesignPath, `${JSON.stringify(approvedDesign, null, 2)}\n`, { mode: 0o600 });
    return textResult({
      status: "approved_design_recorded",
      design_family: approvedDesign.designFamily,
      presentation_fingerprint: approvedDesign.presentationFingerprint,
      role_count: Object.keys(approvedDesign.roleFingerprints).length,
    });
  }
  if (name === "beta_get_presenter_profile") return textResult(readPresenterProfile(ownerPresenterProfilePath));
  if (name === "beta_confirm_personal_master") {
    if (args.private_master_confirmed !== true) {
      throw new BetaError("MASTER_DECK_NOT_PERSONALIZED", "Confirm only after your private master deck contains your name, title, and photo.");
    }
    return textResult({
      status: "ready",
      profile: confirmPersonalMaster(ownerPresenterProfilePath),
      next_action: null,
    });
  }
  if (name === "beta_update_presenter_profile") {
    const runtime = loadRuntime();
    if (runtime.limitedBetaRuntime?.renderer_mode !== "manual_bound_script") {
      await probeAppsScriptRenderer({
        configPath: ownerRendererConfigPath,
        clientPath: ownerGoogleOAuthClientPath,
        tokenPath: ownerGoogleTokenPath,
        verifyPersonalMaster: true,
      });
    }
    return textResult({ status: "ready", profile: writePresenterProfile(ownerPresenterProfilePath, args) });
  }
  if (name === 'beta_prepare_snowflake_setup') {
    const runtime = loadRuntime();
    if (runtime.credentialState.mode === 'invented_only') return textResult({state: 'invented_only', local_prerequisites_checked: false, customer_data_read: false});
    requireSnowflakeSetupApproval();
    return textResult(inspectSnowflakeSetup(snowflakeSetupOptions()));
  }
  if (name === 'beta_configure_snowflake_zdp') {
    if (args.local_configuration_authorized !== true) throw new BetaError('SNOWFLAKE_LOCAL_SETUP_APPROVAL_REQUIRED', 'Approve the displayed bounded local configuration step before it runs. Nothing was changed.');
    requireSnowflakeSetupApproval();
    return textResult(configureSnowflakeSetup({...snowflakeSetupOptions(), configurationAuthorized: true}));
  }
  if (name === "beta_connect_snowflake_zdp") {
    requireSnowflakeSetupApproval();
    const prerequisites = inspectSnowflakeSetup(snowflakeSetupOptions());
    const invalidatePreviousConnection = (failureCode) => {
      if (fs.existsSync(ownerCredentialStatePath)) writeCredentialState(ownerCredentialStatePath,
        {snowflake: {state: 'not_connected', read_only_verified: false, failure_code: failureCode}}, readJson(ownerCredentialStatePath));
    };
    if (prerequisites.state !== 'configured') {
      invalidatePreviousConnection(prerequisites.failure_code || prerequisites.next_action.code);
      return textResult(prerequisites);
    }
    const policy = readJson(sourceConnectionPolicyPath).snowflake;
    let probe;
    try { probe = probeSnowflakeZdp({connectionName: policy.connection_name, approvedReadOnlyRoles: policy.approved_read_only_roles}); }
    catch (error) { invalidatePreviousConnection(error instanceof BetaError ? error.code : 'SNOWFLAKE_CONNECTION_FAILED'); throw error; }
    const existing = fs.existsSync(ownerCredentialStatePath) ? readJson(ownerCredentialStatePath) : {};
    writeCredentialState(ownerCredentialStatePath, probe, existing);
    return textResult({ status: probe.snowflake.read_only_verified ? "ready" : "action_required", snowflake_zdp: probe.snowflake,
      next_action: probe.snowflake.read_only_verified ? null : {code: 'VERIFY_READ_ONLY_ZDP_ACCESS', title: 'Verify approved read-only access', instruction: 'Company sign-in succeeded, but the active role is not approved for this beta. Ask the owner or ZDP support to check access; do not change roles or source permissions automatically.'} });
  }
  if (name === "beta_connect_google_renderer") {
    if (loadRuntime().limitedBetaRuntime?.renderer_mode === "manual_bound_script") {
      throw new BetaError("MANUAL_RENDERER_SELECTED", "This beta uses the renderer embedded in the private master deck; no separate Google OAuth connection is required.");
    }
    const google = await authorizeGoogleDesktop({
      clientPath: ownerGoogleOAuthClientPath,
      tokenPath: ownerGoogleTokenPath,
    });
    const probe = await probeAppsScriptRenderer({
      configPath: ownerRendererConfigPath,
      clientPath: ownerGoogleOAuthClientPath,
      tokenPath: ownerGoogleTokenPath,
    });
    const existing = fs.existsSync(ownerCredentialStatePath) ? readJson(ownerCredentialStatePath) : {};
    writeCredentialState(ownerCredentialStatePath, { google }, existing);
    return textResult({ status: "ready", google_renderer: google, renderer_baseline: probe.rendererBaseline });
  }
  if (name === "beta_connect_google_shared_sources") {
    return textResult(activeNativeRenewalSources.requestConnection(baseSetupStatus().runtime.testerId));
  }
  if (name === "beta_complete_google_shared_sources_connection") {
    return textResult(activeNativeRenewalSources.connect({ ref: args.connection_ref, ownerRef: baseSetupStatus().runtime.testerId,
      connected: args.connected, profileDigest: args.profile_digest }));
  }
  if (name === "beta_confirm_manual_renderer_ready") {
    const runtime = loadRuntime();
    if (runtime.limitedBetaRuntime?.renderer_mode !== "manual_bound_script") {
      throw new BetaError("MANUAL_RENDERER_NOT_SELECTED", "This package does not use the manual bound-script renderer.");
    }
    if (args.renderer_opened !== true || args.google_authorization_completed !== true) {
      throw new BetaError("MANUAL_RENDERER_NOT_READY", "Confirm that the renderer opened and Google's authorization completed.");
    }
    const existing = fs.existsSync(ownerCredentialStatePath) ? readJson(ownerCredentialStatePath) : {};
    const updated = writeCredentialState(ownerCredentialStatePath, {
      renderer_mode: "manual_bound_script",
      manual_renderer: { state: "ready", authorized: true },
    }, existing);
    return textResult({ status: "ready", renderer_mode: "manual_bound_script", manual_renderer: updated.manual_renderer });
  }
  if (name === "beta_get_book_of_business_analysis_capabilities") {
    const readiness = capabilitySetupStatus("portfolio_analytics").result;
    return textResult({
      status: readiness.status,
      readiness: {
        status: readiness.status,
        workflow: readiness.workflow,
        next_action: readiness.next_action,
      },
      ...bookOfBusinessAnalyticsCapabilities(),
      ...bookOfBusinessPortfolioQueryCapabilities(),
    });
  }
  const journeyAOnlyToolNames = new Set([
    "beta_route_workflow",
    "beta_create_authorized_journey_a_case",
    "beta_read_owned_cta_queue",
    "beta_read_portfolio_recent_relationships",
    "beta_continue_portfolio_recent_relationships",
    "beta_read_book_of_business_summary",
    "beta_get_renewal_sequence_guidance",
    "beta_resolve_renewal_sequence",
    "beta_continue_renewal_sequence",
    "beta_register_selected_account",
    "beta_run_journey_a_contact_evidence",
    "beta_run_bulk_contact_research",
    "beta_verify_bulk_contact_emails",
    "beta_get_bulk_contact_email_verification",
    "beta_continue_journey_a_contact_evidence",
    "beta_complete_journey_a_contact_evidence",
    "beta_record_journey_a_approval",
    "beta_read_verified_contact_email",
    "beta_get_verified_outreach_recipient",
    "beta_prepare_outreach_email",
    "beta_bind_outreach_draft_review",
    "beta_claim_outreach_draft",
    "beta_complete_outreach_draft",
    "beta_get_renewal_preparation_options",
    "beta_prepare_renewal_conversation_brief",
    "beta_continue_renewal_preparation",
    "beta_wait_for_renewal_conversation_evidence",
    "beta_get_renewal_conversation_evidence",
    "beta_add_renewal_csm_context",
    "beta_select_renewal_deck_content",
    "beta_bind_renewal_native_fit",
    "beta_revise_renewal_customer_copy",
    "beta_record_renewal_partial_evidence_decision",
    "beta_record_renewal_conversation_approval",
    "beta_render_renewal_conversation_brief",
    "beta_complete_renewal_conversation",
  ]);
  const journeyAContextTool = (
    (name === "beta_bind_journey_context" || name === "beta_record_orchestration_run")
    && args.journey === "journey_a"
  ) || (name === "beta_handoff_journey" && args.from_journey === "journey_a");
  // Inspecting an existing case is source-only. It must not require Slides
  // setup when the active workflow is outreach or renewal preparation.
  const caseInspectionTool = name === "beta_case_status" || name === "beta_workflow_status";
  // Native Converge discovery/read controls need source access, not a Slides
  // master or renderer. Those remain requirements at draft creation.
  const convergeSourceTool = new Set([
    "beta_start_converge_call_lookup", "beta_continue_meeting_prep_call_lookup",
    "beta_accept_converge_call_candidates", "beta_create_meeting_prep_case_from_call_selection",
    "beta_get_selected_converge_call_request", "beta_bind_converge_call_evidence",
  ]).has(name);
  const { runtime } = name === "beta_read_daily_focus_work_signals"
    ? requireDailyFocusReady()
    : convergeSourceTool || ["beta_get_account_access_mode", "beta_set_account_access_mode", "beta_search_manager_accounts", "beta_continue_manager_account_search", "beta_read_book_of_business_summary", "beta_query_book_of_business_accounts", "beta_start_book_of_business_summary", "beta_start_book_of_business_accounts", "beta_continue_book_of_business_read", "beta_start_meeting_prep_account_brief", "beta_continue_meeting_prep_account_brief", "beta_get_meeting_prep_brief_display", "beta_get_account_brief_chart"].includes(name)
    ? requirePortfolioAnalyticsReady()
    : (journeyAOnlyToolNames.has(name) || journeyAContextTool || caseInspectionTool) ? requireJourneyAReady() : requireReady();
  if (ownerAssistedDisabled && (ownerAssistedToolNames.has(name) || Object.keys(args).some((key) => key.startsWith("owner_assisted_") || key === "account_owner_ref_digest"))) {
    throw new BetaError("OWNER_ASSISTED_UNAVAILABLE", "Cross-account testing is available only in the private development installation.");
  }
  if (name === 'beta_get_account_access_mode') return textResult(accountAccessMode(runtime));
  if (name === 'beta_set_account_access_mode') {
    if (!['csm_book', 'manager_account_search'].includes(args.mode)) throw new BetaError('INVALID_ACCOUNT_ACCESS_MODE', 'Choose CSM book or manager account lookup.');
    if (args.mode === 'manager_account_search') managerAuthority(runtime);
    fs.mkdirSync(ownerPrivateConfigDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(ownerAccountAccessModePath, JSON.stringify({ schema_version: '1.0', mode: args.mode }) + '\n', { mode: 0o600 });
    return textResult(accountAccessMode(runtime));
  }
  if (name === 'beta_search_manager_accounts') {
    const authority = managerAuthority(runtime);
    return textResult(activeManagerAccountSearches.start({ ownerRef: runtime.testerId,
      query: args.query, limit: args.limit ?? 25, exact: args.exact ?? false, authority,
      read: async sql => {
        const session = new PersistentSnowflakeSession({ connectionName: authority.connectionName });
        try { await verifyManagerReadOnlySession({ session, authority }); return await session.query(sql, { timeoutMs: 120000 }); }
        finally { session.close(); }
      } }));
  }
  if (name === 'beta_continue_manager_account_search') {
    managerAuthority(runtime);
    const input = { ownerRef: runtime.testerId, searchRef: args.manager_search_ref };
    let result = activeManagerAccountSearches.poll(input);
    if (result.status === 'in_progress' && args.wait_seconds !== 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(args.wait_seconds ?? 20, 0), 20) * 1000));
      result = activeManagerAccountSearches.poll(input);
    }
    return textResult(result);
  }
  if (name === "beta_read_daily_focus_work_signals") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const policy = readJson(sourceConnectionPolicyPath).snowflake;
    const session = new PersistentSnowflakeSession({ connectionName: policy.connection_name });
    try {
      const queue = await readOwnedCtaQueueWithSession({ session });
      return textResult(presentDailyFocusWorkSignals(queue));
    } finally {
      session.close();
    }
  }
  if (name === "beta_read_book_of_business_summary") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const policy = readJson(sourceConnectionPolicyPath).snowflake;
    const session = new BookOfBusinessReadSession({ connectionName: policy.connection_name });
    const startedAt = Date.now();
    try {
      const summary = await readBookOfBusinessSummaryWithSession({
        session,
        dimensions: args.dimensions || [],
      });
      return textResult({
        status: "ready",
        first_response_ms: Date.now() - startedAt,
        ...summary,
        next_action: "Ask for another supported breakdown, such as Account Executive by CRM region. This aggregate read does not select an account or start outreach.",
      });
    } finally {
      session.close();
    }
  }
  if (name === "beta_query_book_of_business_accounts") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const policy = readJson(sourceConnectionPolicyPath).snowflake;
    const session = new BookOfBusinessReadSession({ connectionName: policy.connection_name });
    const startedAt = Date.now();
    try {
      const query = await readBookOfBusinessPortfolioQueryWithSession({
        session,
        filters: args.filters || [],
        columns: args.columns,
        sort: args.sort,
        limit: args.limit,
      });
      return textResult({
        status: "ready",
        first_response_ms: Date.now() - startedAt,
        ...query,
        next_action: query.has_more
          ? "The result is capped. Narrow the approved filters or ask for a different sort to review the remaining current-book accounts."
          : "Ask for another approved current-book filter, an aggregate breakdown, or a different set of account columns. This read does not start outreach or create a CTA.",
      });
    } finally {
      session.close();
    }
  }
  if (name === "beta_start_book_of_business_summary") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const dimensions = args.dimensions || [];
    buildBookOfBusinessSummarySql(dimensions);
    const connectionName = readJson(sourceConnectionPolicyPath).snowflake.connection_name;
    const startedAt = Date.now();
    return textResult(activeBookOfBusinessReads.start({
      ownerRef: runtime.testerId,
      kind: "summary",
      read: async (onProgress) => {
        const session = new BookOfBusinessReadSession({ connectionName });
        try {
          const summary = await readBookOfBusinessSummaryWithSession({ session, dimensions, onProgress });
          return {
            first_response_ms: Date.now() - startedAt,
            ...summary,
            next_action: "Ask for another supported breakdown. This read does not select an account or start outreach.",
          };
        } finally {
          session.close();
        }
      },
    }));
  }
  if (name === "beta_start_book_of_business_accounts") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const request = normalizeBookOfBusinessPortfolioRequest(args);
    const connectionName = readJson(sourceConnectionPolicyPath).snowflake.connection_name;
    const startedAt = Date.now();
    return textResult(activeBookOfBusinessReads.start({
      ownerRef: runtime.testerId,
      kind: "accounts",
      read: async (onProgress) => {
        const session = new BookOfBusinessReadSession({ connectionName });
        try {
          const query = await readBookOfBusinessPortfolioQueryWithSession({ session, ...request, onProgress });
          return {
            first_response_ms: Date.now() - startedAt,
            ...query,
            next_action: query.has_more
              ? "The result is capped. Narrow the approved filters or ask for a different sort to review the remaining current-book accounts."
              : "Ask for another approved current-book filter, aggregate breakdown, or set of account columns.",
          };
        } finally {
          session.close();
        }
      },
    }));
  }
  if (name === "beta_continue_book_of_business_read") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const current = activeBookOfBusinessReads.poll({ ref: args.book_read_ref, ownerRef: runtime.testerId });
    if (current.status === "in_progress" && args.wait_seconds !== 0) {
      const waitSeconds = Number.isInteger(args.wait_seconds) ? Math.min(Math.max(args.wait_seconds, 0), 20) : 20;
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    }
    const progress = activeBookOfBusinessReads.poll({ ref: args.book_read_ref, ownerRef: runtime.testerId });
    return textResult(progress, progress.status === "failed");
  }
  if (name === "beta_start_meeting_prep_call_candidates") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    requireMeetingPrepCallDateRange({ startDate: args.call_date, endDate: args.call_date });
    return textResult(startMeetingPrepCallLookup({
      testerId: runtime.testerId,
      kind: "date",
      read: ({ session, onProgress }) => readMeetingPrepCallCandidatesWithSession({
        session, accountName: args.account_name, callDate: args.call_date, onProgress,
      }),
    }));
  }
  if (name === "beta_start_meeting_prep_call_candidates_in_range") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    requireMeetingPrepCallDateRange({ startDate: args.start_date, endDate: args.end_date });
    return textResult(startMeetingPrepCallLookup({
      testerId: runtime.testerId,
      kind: "date_range",
      read: ({ session, onProgress }) => readMeetingPrepCallCandidatesInRangeWithSession({
        session, accountName: args.account_name, startDate: args.start_date, endDate: args.end_date, onProgress,
      }),
    }));
  }
  if (name === "beta_start_meeting_prep_call_link_validation") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    parseGongCallUrl(args.gong_call_url);
    return textResult(startMeetingPrepCallLookup({
      testerId: runtime.testerId,
      kind: "direct_link",
      read: ({ session, onProgress }) => validateMeetingPrepCallLinkWithSession({
        session, accountName: args.account_name, gongCallUrl: args.gong_call_url, onProgress,
      }),
    }));
  }
  if (name === "beta_continue_meeting_prep_call_lookup") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const current = activeMeetingPrepCallLookups.poll({ ref: args.call_lookup_ref, ownerRef: runtime.testerId });
    if (current.status === "in_progress" && args.wait_seconds !== 0) {
      const waitSeconds = Number.isInteger(args.wait_seconds) ? Math.min(Math.max(args.wait_seconds, 0), 20) : 20;
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    }
    const progress = activeMeetingPrepCallLookups.poll({ ref: args.call_lookup_ref, ownerRef: runtime.testerId });
    return textResult(progress, progress.status === "failed");
  }
  if (name === "beta_start_meeting_prep_account_brief") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    if ([args.case_id, args.account_name, args.manager_account_selection_ref].filter(Boolean).length !== 1) {
      throw new BetaError("MEETING_PREP_ACCOUNT_SCOPE_REQUIRED", "Use exactly one active meeting-prep case, in-book account name or manager account selection.");
    }
    let accountRefDigest = null;
    let selectedManagerAccount = managerSelection(args, runtime);
    if (args.case_id) {
      const record = currentMeetingPrepBriefCase(args.case_id, runtime);
      accountRefDigest = record.account_ref_digest;
      if (record.account_scope === 'manager_selected_account') {
        managerAuthority(runtime);
        selectedManagerAccount = { accountRefDigest };
        accountRefDigest = null;
      }
      if (args.refresh_requested_by_csm !== true && record.account_intelligence_core?.content_digest) {
        const fresh = activeMeetingPrepAccountBriefs.matchingResult({ ownerRef: runtime.testerId, accountRefDigest: record.account_ref_digest,
          contentDigest: record.account_intelligence_core.content_digest });
        if (fresh) return textResult({ ...meetingPrepBriefPresentation(fresh, record, runtime), case_status: publicCaseStatus(record),
          next_action: "Show the fresh owner-bound account brief already bound to this case. No new source read occurred. Refresh only if the CSM asks or the short-lived evidence expires." });
      }
    }
    const policy = readJson(sourceConnectionPolicyPath).snowflake;
    const progress = activeMeetingPrepAccountBriefs.start({
      ownerRef: runtime.testerId,
      read: async (onProgress) => {
        const session = new PersistentSnowflakeSession({ connectionName: policy.connection_name });
        try {
          return await readMeetingPrepAccountBriefWithSession({
            session, accountName: args.account_name || null, accountRefDigest, onProgress,
            managerSelection: selectedManagerAccount,
            managerAuthority: selectedManagerAccount ? managerAuthority(runtime) : null,
          });
        } finally {
          session.close();
        }
      },
    });
    if (args.case_id) activeMeetingPrepBriefCases.set(progress.account_brief_ref, { caseId: args.case_id, ownerRef: runtime.testerId });
    return textResult(progress);
  }
  if (name === "beta_continue_meeting_prep_account_brief") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const existingCaseBinding = activeMeetingPrepBriefCases.get(args.account_brief_ref);
    if (args.case_id) {
      currentMeetingPrepBriefCase(args.case_id, runtime);
      if (existingCaseBinding && existingCaseBinding.caseId !== args.case_id) {
        throw new BetaError("MEETING_PREP_BRIEF_CASE_MISMATCH", "This account brief was started for another case.");
      }
    }
    let progress = activeMeetingPrepAccountBriefs.poll({ ref: args.account_brief_ref, ownerRef: runtime.testerId });
    if (progress.status === "in_progress" && args.wait_seconds !== 0) {
      const waitSeconds = Number.isInteger(args.wait_seconds) ? Math.min(Math.max(args.wait_seconds, 0), 20) : 20;
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      progress = activeMeetingPrepAccountBriefs.poll({ ref: args.account_brief_ref, ownerRef: runtime.testerId });
    }
    if (["ready", "partial"].includes(progress.status) && progress.account_intelligence_receipt) {
      // Reject a bad presentation selector before attaching evidence or
      // changing any case revision. Validation uses only the finished cache.
      if (args.display_focus || args.display_details) buildAccountIntelligenceDisplay(progress.account_brief, { displayFocus: args.display_focus, displayDetails: args.display_details });
      const pending = args.case_id ? { caseId: args.case_id, ownerRef: runtime.testerId } : existingCaseBinding;
      if (pending?.ownerRef === runtime.testerId && progress.account_intelligence_receipt) {
        const scopedCase = currentMeetingPrepBriefCase(pending.caseId, runtime);
        const receipt = progress.account_intelligence_receipt;
        progress.case_status = publicCaseStatus(scopedCase);
        if (scopedCase.account_intelligence_core?.content_digest !== receipt.content_digest) {
          const updated = bindAccountIntelligenceCore(scopedCase, {
            contract: receipt.contract,
            schemaVersion: receipt.schema_version,
            contentDigest: receipt.content_digest,
            briefState: receipt.brief_state,
            sectionStates: receipt.section_states,
            sourceGapCodes: receipt.source_gap_codes,
            performanceCoverage: receipt.performance_coverage,
            accountRefDigest: receipt.account_ref_digest,
            revision: scopedCase.revision,
            testerId: runtime.testerId,
          });
          writeCase(updated);
          progress.case_status = publicCaseStatus(updated);
          progress.evidence_changed = updated.revision !== scopedCase.revision;
        }
        activeMeetingPrepBriefCases.set(args.account_brief_ref, pending);
        progress = meetingPrepBriefPresentation(progress, currentMeetingPrepBriefCase(pending.caseId, runtime), runtime, args.display_focus, args.display_details);
      } else if (args.display_focus || args.display_details) {
        progress = { ...progress, account_brief_display: buildAccountIntelligenceDisplay(progress.account_brief, { displayFocus: args.display_focus, displayDetails: args.display_details }) };
      }
    }
    return textResult(progress, progress.status === "failed");
  }
  if (name === "beta_get_meeting_prep_brief_display") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    let completed = activeMeetingPrepAccountBriefs.poll({ ref: args.account_brief_ref, ownerRef: runtime.testerId });
    if (!["ready", "partial"].includes(completed.status) || !completed.account_brief) {
      throw new BetaError("MEETING_PREP_BRIEF_NOT_FINISHED", "Continue the existing account read before displaying its brief. No new read or case was started.");
    }
    const binding = activeMeetingPrepBriefCases.get(args.account_brief_ref);
    if (binding) {
      if (binding.ownerRef !== runtime.testerId) throw new BetaError("CASE_OWNER_MISMATCH", "The brief belongs to another tester.");
      completed = meetingPrepBriefPresentation(completed, currentMeetingPrepBriefCase(binding.caseId, runtime), runtime);
    }
    const display = completed.account_brief_display;
    return { isError: false, content: [
      { type: "text", text: display.markdown },
      { type: "text", text: JSON.stringify({
        delivery_contract: display.delivery_contract,
        instruction: "The first text block is the complete approved answer body. Copy it verbatim, including its opening source-read summary, headings, table-header capitalization and all rows/limits. Only recent-call Summary/Next steps cells may be paraphrased from these cached notes. Do not print this metadata or fetch optional display_details for ordinary preparation. Put any optional meeting questions after the copied body.",
        conversation_briefing: { ...display.conversation_briefing,
          rows: completed.account_brief.sections.recent_conversations?.facts?.recent_calls || [] },
        chart_requests: display.charts.map(chart => ({ tool: "beta_get_account_brief_chart", arguments: { account_brief_ref: args.account_brief_ref, chart_id: chart.id } })),
        chart_instruction: display.chart_instruction,
        evidence_changed: false, approvals_changed: false, source_reread: false,
      }) },
    ] };
  }
  if (name === "beta_get_account_brief_chart") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    pruneJourneyARuntimeState();
    if (Boolean(args.account_brief_ref) === Boolean(args.renewal_conversation_run_id)) {
      throw new BetaError("ACCOUNT_BRIEF_CHART_SCOPE_REQUIRED", "Use exactly one temporary account-brief or renewal-evidence reference.");
    }
    if (args.renewal_conversation_run_id && !args.case_id) {
      throw new BetaError("ACCOUNT_BRIEF_CHART_SCOPE_REQUIRED", "A renewal chart needs the same case and temporary evidence reference.");
    }
    let display, accountRefDigest, expiresAt;
    if (args.account_brief_ref) {
      const result = activeMeetingPrepAccountBriefs.poll({ ref: args.account_brief_ref, ownerRef: runtime.testerId });
      if (!["ready", "partial"].includes(result.status)) throw new BetaError("ACCOUNT_BRIEF_CHART_UNAVAILABLE", "The account brief has not returned chart evidence.");
      if (args.case_id) {
        const scoped = currentMeetingPrepBriefCase(args.case_id, runtime);
        meetingPrepBriefPresentation(result, scoped, runtime);
      }
      display = result.account_brief_display;
      accountRefDigest = result.account_intelligence_receipt.account_ref_digest;
      expiresAt = activeMeetingPrepAccountBriefs.chartExpiry({ ref: args.account_brief_ref, ownerRef: runtime.testerId });
    } else {
      const record = readCase(args.case_id);
      if (record.tester_id !== runtime.testerId) throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
      if (record.package_version !== runtime.manifest.package_version || record.renderer_baseline !== runtime.manifest.renderer_baseline) {
        throw new BetaError("CASE_VERSION_MISMATCH", "The case was created with a different approved package.");
      }
      const run = renewalRunFor({ caseId: record.case_id, runId: args.renewal_conversation_run_id, testerId: runtime.testerId });
      display = renewalCsmEvidence(run).account_brief_display;
      accountRefDigest = record.renewal_conversation.account_ref_digest;
      expiresAt = run.expiresAt;
    }
    const result = accountBriefChartResult(display, args.chart_id);
    if (args.local_file_delivery_authorized === true) {
      const delivery = await temporaryAccountBriefChartFiles.create(result, { authorized: true,
        ownerRef: runtime.testerId, accountRefDigest, evidenceRef: args.account_brief_ref || args.renewal_conversation_run_id, expiresAt });
      const receipt = JSON.parse(result.content[0].text);
      result.content[0].text = JSON.stringify({ ...receipt, local_delivery: delivery,
        next_action: "Embed local_delivery.markdown directly in the final reply alongside the metric tables. Do not use a collapsed tool image or generatedImage as proof of visible delivery. State the temporary-image expiry. Keep values and definitions visible; chart visibility still requires CSM confirmation." });
    }
    return result;
  }
  if (name === "beta_start_converge_call_lookup") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    requireMeetingPrepCallDateRange({ startDate: args.start_date, endDate: args.end_date });
    if ([args.account_name, args.manager_account_selection_ref].filter(Boolean).length !== 1) throw new BetaError('ACCOUNT_SELECTION_REQUIRED', 'Use one in-book account name or exact manager account selection.');
    const selectedManagerAccount = managerSelection(args, runtime);
    const policy = readJson(sourceConnectionPolicyPath).snowflake;
    return textResult(activeMeetingPrepCallLookups.start({
      ownerRef: runtime.testerId, kind: "date_range",
      read: async (onProgress) => {
        const session = new PersistentSnowflakeSession({ connectionName: policy.connection_name });
        try {
          onProgress({ stage: "account_scope", stage_deadline_seconds: 90 });
          const scope = selectedManagerAccount
            ? { account: await verifyManagerSelectedAccountWithSession({ session, selection: selectedManagerAccount, authority: managerAuthority(runtime), onProgress }) }
            : resolveMeetingPrepAccountScope(await session.query(buildMeetingPrepAccountScopeSql({ accountName: args.account_name }), { timeoutMs: 90_000 }));
          if (scope.finalResult) return scope.finalResult;
          return activeConvergeMeetingPrep.start({ ownerRef: runtime.testerId, account: scope.account,
            startDate: args.start_date, endDate: args.end_date, query: args.query,
            keywordSearchRequested: args.keyword_search_requested === true });
        } catch (error) {
          if (["SNOWFLAKE_SESSION_TIMEOUT", "SNOWFLAKE_SESSION_START_TIMEOUT"].includes(error.code)) {
            throw new BetaError("MEETING_PREP_CALL_READ_TIMEOUT", "The in-book account check timed out; no Converge search was started.", { stage: "account_scope", deadline_seconds: 90 });
          }
          throw error;
        } finally { session.close(); }
      },
    }));
  }
  if (name === "beta_accept_converge_call_candidates") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const result = activeConvergeMeetingPrep.acceptPage({ ref: args.converge_lookup_ref,
      ownerRef: runtime.testerId, calls: args.calls, truncated: args.truncated });
    retainMeetingPrepCallSelections({ candidateResult: result, testerId: runtime.testerId });
    return textResult(result);
  }
  if (name === "beta_get_selected_converge_call_request") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    pruneJourneyARuntimeState();
    const record = readCase(args.case_id);
    if (record.derived_evidence?.source_receipt?.provider === "Converge") {
      return textResult({ status: "evidence_already_bound", case_status: publicCaseStatus(record),
        next_action: "Use the already reviewed findings; do not retrieve the same transcript again." });
    }
    const selection = activeMeetingPrepSelectedCalls.get(args.case_id);
    if (!selection || selection.ownerRef !== runtime.testerId) {
      throw new BetaError("SELECTED_CALL_REFERENCE_EXPIRED", "The chosen call is no longer in memory. Repeat the original lookup and choose a call again.");
    }
    if (selection.provider !== "Converge" || record.transcript_eligibility?.provider !== "Converge") {
      throw new BetaError("CONVERGE_SELECTION_REQUIRED", "Choose a call returned by the approved Converge picker.");
    }
    const request = activeConvergeMeetingPrep.selectedRead({ ownerRef: runtime.testerId,
      caseId: record.case_id, selection, sourceDigest: record.source_locator_digest });
    if (request.native_request) delete selection.sourceGap;
    return textResult(request);
  }
  if (name === "beta_bind_converge_call_evidence") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const record = readCase(args.case_id);
    if (record.transcript_eligibility?.provider !== "Converge") throw new BetaError("CONVERGE_SELECTION_REQUIRED", "This case was not selected through Converge.");
    if (record.revision !== args.revision) throw new BetaError("STALE_CASE_REVISION", "Use the current case revision when binding the native call evidence.");
    let receipt;
    try { receipt = activeConvergeMeetingPrep.evidenceReceipt({ ref: args.call_read_ref, ownerRef: runtime.testerId,
      caseRecord: record, sourceStatus: args.source_status, linkedAccountIds: args.linked_account_ids,
      sourceResultDigest: args.source_result_digest, evidenceDigest: args.evidence_digest,
      findingCount: args.finding_count, warningCodes: args.warning_codes }); }
    catch (error) {
      const selection = activeMeetingPrepSelectedCalls.get(args.case_id);
      if (selection?.ownerRef === runtime.testerId && ["CONVERGE_CALL_SOURCE_GAP", "SELECTED_CALL_ACCOUNT_MISMATCH"].includes(error.code)) selection.sourceGap = error.code;
      throw error;
    }
    const updated = bindDerivedEvidence(record, { digest: receipt.evidence_digest, findingCount: receipt.finding_count,
      warningCodes: receipt.warning_codes, testerId: runtime.testerId });
    updated.derived_evidence.source_receipt = receipt;
    writeCase(updated);
    activeMeetingPrepCallReviewContexts.set(updated.case_id, { ownerRef: runtime.testerId, digest: updated.derived_evidence.digest, expiresAt: Date.now() + JOURNEY_A_RUNTIME_SELECTION_TTL_MS });
    activeConvergeMeetingPrep.finishRead(args.call_read_ref);
    activeMeetingPrepSelectedCalls.delete(args.case_id);
    return textResult({ status: "evidence_bound", receipt, case_status: publicCaseStatus(updated) });
  }
  if (name === "beta_find_meeting_prep_call_candidates") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const policy = readJson(sourceConnectionPolicyPath).snowflake;
    const session = new PersistentSnowflakeSession({ connectionName: policy.connection_name });
    const startedAt = Date.now();
    try {
      const candidates = await readMeetingPrepCallCandidatesWithSession({
        session,
        accountName: args.account_name,
        callDate: args.call_date,
      });
      retainMeetingPrepCallSelections({ candidateResult: candidates, testerId: runtime.testerId });
      return textResult({
        ...candidates,
        first_response_ms: Date.now() - startedAt,
        read_at: candidates.read_at,
      });
    } finally {
      session.close();
    }
  }
  if (name === "beta_find_meeting_prep_call_candidates_in_range") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const policy = readJson(sourceConnectionPolicyPath).snowflake;
    const session = new PersistentSnowflakeSession({ connectionName: policy.connection_name });
    const startedAt = Date.now();
    try {
      const candidates = await readMeetingPrepCallCandidatesInRangeWithSession({
        session,
        accountName: args.account_name,
        startDate: args.start_date,
        endDate: args.end_date,
      });
      retainMeetingPrepCallSelections({ candidateResult: candidates, testerId: runtime.testerId });
      return textResult({
        ...candidates,
        first_response_ms: Date.now() - startedAt,
        read_at: candidates.read_at,
      });
    } finally {
      session.close();
    }
  }
  if (name === "beta_validate_meeting_prep_call_link") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const policy = readJson(sourceConnectionPolicyPath).snowflake;
    const session = new PersistentSnowflakeSession({ connectionName: policy.connection_name });
    const startedAt = Date.now();
    try {
      const candidates = await validateMeetingPrepCallLinkWithSession({
        session,
        accountName: args.account_name,
        gongCallUrl: args.gong_call_url,
      });
      retainMeetingPrepCallSelections({ candidateResult: candidates, testerId: runtime.testerId });
      return textResult({
        ...candidates,
        first_response_ms: Date.now() - startedAt,
        read_at: candidates.read_at,
      });
    } finally {
      session.close();
    }
  }
  if (name === "beta_owner_assisted_test_status") {
    return textResult(ownerAssistedDevelopmentStatus({
      controls: runtime.ownerAssistedDevelopmentControls,
      operatorRef: runtime.testerId,
    }));
  }
  if (name === "beta_authorize_owner_assisted_test") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const authorization = authorizeOwnerAssistedTest({
      controls: runtime.ownerAssistedDevelopmentControls,
      authorizationPath: ownerAssistedAuthorizationPath,
      operatorRef: runtime.testerId,
      input: args,
    });
    return textResult({
      status: "authorized",
      authorization_id: authorization.authorization_id,
      scope_kind: authorization.scope_kind,
      expires_at: authorization.expires_at,
      private_draft_only: true,
      raw_transcript_retained: false,
    });
  }
  if (name === "beta_route_workflow") return textResult(routeWorkflowIntent(args.intent, { preparationMode: args.preparation_mode }));
  if (name === "beta_get_meeting_prep_build_requirements") return textResult(nativeBuildRequirements());
  if (name === "beta_get_presentation_preferences") {
    return textResult(readPresentationPreferences(presentationPreferencesPath));
  }
  if (name === "beta_update_presentation_preferences") {
    return textResult(writePresentationPreferences(presentationPreferencesPath, args));
  }
  if (name === "beta_reset_presentation_preferences") {
    return textResult(resetPresentationPreferences(presentationPreferencesPath));
  }
  if (name === "beta_create_invented_case") {
    let record = createInventedCase({ scenario: args.scenario, testerId: runtime.testerId, manifest: runtime.manifest });
    record.presentation_plan = readPresentationPreferences(presentationPreferencesPath);
    writeCase(record);
    recordRegisterEvent({ eventType: "case_created", result: baseSetupStatus().result, caseId: record.case_id, status: record.status });
    return textResult(publicCaseStatus(record));
  }
  if (name === "beta_create_meeting_prep_case_from_call_selection") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    pruneJourneyARuntimeState();
    const pendingSelection = activeMeetingPrepCallSelections.get(args.call_selection_ref);
    if (pendingSelection && pendingSelection.testerId === runtime.testerId && pendingSelection.provider !== "Converge") {
      throw new BetaError("CONVERGE_SELECTION_REQUIRED", "New meeting-prep cases require a call selected by the approved Converge lookup. No case was created.");
    }
    const selection = consumeMeetingPrepCallSelection({
      selectionRef: args.call_selection_ref,
      testerId: runtime.testerId,
    });
    let record = createConvergeMeetingPrepCase({
      sourceDigest: crypto.createHash("sha256").update(`gong-call:${selection.conversationKey}`).digest("hex"),
      language: args.language, testerId: runtime.testerId, manifest: runtime.manifest,
    });
    record.account_ref_digest = crypto.createHash("sha256").update(`account:${selection.accountId}`).digest("hex");
    if (selection.account_scope === 'manager_selected_account') record.account_scope = selection.account_scope;
    const existingReceipt = activeMeetingPrepAccountBriefs.matchingReceipt({ ownerRef: runtime.testerId, accountRefDigest: record.account_ref_digest });
    if (existingReceipt) {
      record = bindAccountIntelligenceCore(record, {
        contract: existingReceipt.contract,
        schemaVersion: existingReceipt.schema_version,
        contentDigest: existingReceipt.content_digest,
        briefState: existingReceipt.brief_state,
        sectionStates: existingReceipt.section_states,
        sourceGapCodes: existingReceipt.source_gap_codes,
        performanceCoverage: existingReceipt.performance_coverage,
        accountRefDigest: existingReceipt.account_ref_digest,
        revision: record.revision,
        testerId: runtime.testerId,
      });
    }
    record.presentation_plan = readPresentationPreferences(presentationPreferencesPath);
    writeCase(record);
    activeMeetingPrepSelectedCalls.set(record.case_id, {
      ownerRef: runtime.testerId,
      conversationKey: selection.conversationKey,
      accountId: selection.accountId,
      callAt: selection.callAt,
      provider: selection.provider || "snowflake_legacy",
      expiresAt: Date.now() + 30 * 60_000,
    });
    recordRegisterEvent({ eventType: "case_created", result: baseSetupStatus().result, caseId: record.case_id, status: record.status });
    return textResult(publicCaseStatus(record));
  }
  if (name === "beta_start_selected_call_evidence") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    pruneJourneyARuntimeState();
    const selected = activeMeetingPrepSelectedCalls.get(args.case_id);
    if (!selected || selected.ownerRef !== runtime.testerId) {
      throw new BetaError("SELECTED_CALL_REFERENCE_EXPIRED", "The selected call's temporary source reference is unavailable. Search and select the call again; no transcript was processed.");
    }
    const selectedCase = readCase(args.case_id);
    if (selected.provider === "Converge") throw new BetaError("CONVERGE_NATIVE_READ_REQUIRED", "Use Converge get_customer_call directly for this selection, not the legacy Snowflake transcript reader.");
    const authorized = authorizeSelectedCallProcessing(selectedCase, {
      revision: args.revision,
      testerId: runtime.testerId,
      transcriptProcessingAuthorized: args.transcript_processing_authorized,
      noServiceData: args.no_service_data,
      noSensitivePersonalData: args.no_sensitive_personal_data,
      noSuspectedL5: args.no_suspected_l5,
    });
    writeCase(authorized);
    const policy = readJson(sourceConnectionPolicyPath).snowflake;
    return textResult(activeSelectedCallEvidence.start({
      ownerRef: runtime.testerId,
      caseId: args.case_id,
      read: async (onProgress) => {
        const session = new PersistentSnowflakeSession({ connectionName: policy.connection_name });
        try {
          onProgress({ stage: "account_scope", stage_deadline_seconds: 90 });
          const scopeRows = await session.query(buildMeetingPrepCaseAccountScopeSql(authorized.account_ref_digest), { timeoutMs: 90_000 });
          const account = resolveMeetingPrepBriefAccount(scopeRows);
          if (account.status !== "selected" || account.accountId !== selected.accountId) {
            throw new BetaError("SELECTED_CALL_ACCOUNT_MISMATCH", "The selected call no longer matches one account in the current CSM book. No transcript was processed.");
          }
          onProgress({ stage: "call_match", stage_deadline_seconds: 100 });
          const matchedRows = await session.query(buildMeetingPrepCallLinkValidationSql({ accountId: selected.accountId, conversationKey: selected.conversationKey }), { timeoutMs: 100_000 });
          const matched = presentMeetingPrepCallCandidates([...scopeRows, ...matchedRows], { selectionOrigin: "direct_link" });
          const candidate = matched.candidates?.[0];
          const sourceSelection = candidate && matched.runtimeSelectionByRef.get(candidate.call_selection_ref);
          if (matched.status !== "selected_call_verified" || matched.candidates.length !== 1 || sourceSelection?.conversationKey !== selected.conversationKey || sourceSelection.hasCallRecording !== true) {
            throw new BetaError("SELECTED_CALL_NOT_VERIFIED", "The selected call could not be reverified against the account and recording. No transcript was processed.");
          }
          const evidence = await readSelectedCallEvidenceWithSession({
            session,
            call: selected,
            model: policy.selected_call_evidence_model,
            sourceDigest: authorized.source_locator_digest,
            onProgress,
          });
          const current = readCase(args.case_id);
          if (current.revision !== authorized.revision) throw new BetaError("STALE_CASE_REVISION", "The case changed while evidence was being prepared. Review the current case before continuing.");
          const bound = bindDerivedEvidence(current, {
            digest: evidence.receipt.evidence_digest,
            findingCount: evidence.receipt.finding_count,
            warningCodes: evidence.receipt.warning_codes,
            testerId: runtime.testerId,
          });
          writeCase(bound);
          activeMeetingPrepCallReviewContexts.set(bound.case_id, { ownerRef: runtime.testerId, digest: bound.derived_evidence.digest, expiresAt: Date.now() + JOURNEY_A_RUNTIME_SELECTION_TTL_MS });
          return { ...evidence, case_status: publicCaseStatus(bound) };
        } finally {
          session.close();
          activeMeetingPrepSelectedCalls.delete(args.case_id);
        }
      },
    }));
  }
  if (name === "beta_continue_selected_call_evidence") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    let progress = activeSelectedCallEvidence.poll({ ref: args.evidence_ref, ownerRef: runtime.testerId });
    if (progress.status === "in_progress" && args.wait_seconds !== 0) {
      const waitSeconds = Number.isInteger(args.wait_seconds) ? Math.min(Math.max(args.wait_seconds, 0), 20) : 20;
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      progress = activeSelectedCallEvidence.poll({ ref: args.evidence_ref, ownerRef: runtime.testerId });
    }
    return textResult(progress, progress.status === "failed");
  }
  if (name === "beta_create_authorized_case") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const ownerAssistedRequested = Boolean(args.owner_assisted_authorization_id || args.account_ref_digest || args.account_owner_ref_digest);
    if (!ownerAssistedRequested) throw new BetaError("NATIVE_CALL_SELECTION_REQUIRED", "Select one account-linked Gong call through the native picker before opening a meeting-prep case.");
    if (ownerAssistedRequested && !(args.owner_assisted_authorization_id && args.account_ref_digest && args.account_owner_ref_digest)) {
      throw new BetaError("OWNER_ASSISTED_SCOPE_INCOMPLETE", "Owner-assisted testing requires an authorization, account digest, and account-owner digest.");
    }
    const caseId = crypto.randomUUID();
    const ownerAssistedTest = ownerAssistedRequested
      ? consumeOwnerAssistedTestAuthorization({
        controls: runtime.ownerAssistedDevelopmentControls,
        authorizationPath: ownerAssistedAuthorizationPath,
        operatorRef: runtime.testerId,
        authorizationId: args.owner_assisted_authorization_id,
        scopeKind: "gong_call",
        scopeDigest: args.source_locator_digest,
        accountRefDigest: args.account_ref_digest,
        accountOwnerRefDigest: args.account_owner_ref_digest,
        caseId,
      })
      : null;
    let record = createAuthorizedCase({ input: { ...args, owner_assisted_test: ownerAssistedTest }, testerId: runtime.testerId, manifest: runtime.manifest, caseId });
    record.presentation_plan = readPresentationPreferences(presentationPreferencesPath);
    writeCase(record);
    recordRegisterEvent({ eventType: "case_created", result: baseSetupStatus().result, caseId: record.case_id, status: record.status });
    return textResult(publicCaseStatus(record));
  }
  if (name === "beta_create_authorized_journey_a_case") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const ownerAssistedRequested = Boolean(args.owner_assisted_authorization_id || args.owner_assisted_scope_digest || args.account_ref_digest || args.account_owner_ref_digest);
    if (ownerAssistedRequested && !(args.owner_assisted_authorization_id && args.owner_assisted_scope_digest && args.account_ref_digest && args.account_owner_ref_digest)) {
      throw new BetaError("OWNER_ASSISTED_SCOPE_INCOMPLETE", "Owner-assisted testing requires an authorization, scope digest, account digest, and account-owner digest.");
    }
    const caseId = crypto.randomUUID();
    const ownerAssistedTest = ownerAssistedRequested
      ? consumeOwnerAssistedTestAuthorization({
        controls: runtime.ownerAssistedDevelopmentControls,
        authorizationPath: ownerAssistedAuthorizationPath,
        operatorRef: runtime.testerId,
        authorizationId: args.owner_assisted_authorization_id,
        scopeKind: "account_portfolio",
        scopeDigest: args.owner_assisted_scope_digest,
        accountRefDigest: args.account_ref_digest,
        accountOwnerRefDigest: args.account_owner_ref_digest,
        caseId,
      })
      : null;
    let record = createAuthorizedJourneyACase({ input: { ...args, owner_assisted_test: ownerAssistedTest }, testerId: runtime.testerId, manifest: runtime.manifest, caseId });
    record.presentation_plan = readPresentationPreferences(presentationPreferencesPath);
    writeCase(record);
    // Do not probe Snowflake with a synthetic query here. The first real CTA
    // read creates the short-lived read-only session and owns its one 25-second
    // deadline. A case is still useful if that later source read is temporarily
    // unavailable, and no preflight probe should erase it.
    recordRegisterEvent({ eventType: "case_created", result: journeyASetupStatus().result, caseId: record.case_id, status: record.status });
    return textResult(publicCaseStatus(record));
  }
  const record = readCase(args.case_id);
  if (record.tester_id !== runtime.testerId) {
    throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  }
  if (
    record.package_version !== runtime.manifest.package_version ||
    record.renderer_baseline !== runtime.manifest.renderer_baseline
  ) {
    throw new BetaError("CASE_VERSION_MISMATCH", "The case was created with a different approved package.");
  }
  if (record.outreach_emails?.some(email => ["create_requested", "needs_reconciliation"].includes(email.outreach_delivery?.state))
      && new Set(["beta_register_selected_account", "beta_run_journey_a_contact_evidence", "beta_complete_journey_a_contact_evidence",
        "beta_bind_journey_context", "beta_resolve_renewal_sequence", "beta_continue_renewal_sequence", "beta_start_journey",
        "beta_handoff_journey", "beta_prepare_renewal_conversation_brief"]).has(name)) {
    throw new BetaError("DRAFT_RECONCILIATION_REQUIRED", "Reconcile the pending email result before replacing its shared account context or guide. Other contacts can still have separate emails using the current research.");
  }
  if (
    activeRenewalBlocksContactResearch(record)
    && [
      "beta_run_journey_a_contact_evidence",
      "beta_continue_journey_a_contact_evidence",
      "beta_complete_journey_a_contact_evidence",
      "beta_get_verified_outreach_recipient",
      "beta_prepare_outreach_email",
      "beta_run_bulk_contact_research",
      "beta_verify_bulk_contact_emails",
      "beta_get_bulk_contact_email_verification",
      "beta_read_portfolio_recent_relationships",
      "beta_continue_portfolio_recent_relationships",
    ].includes(name)
  ) {
    throw new BetaError(
      "RENEWAL_CONTEXT_ACTIVE",
      "Renewal preparation is active for this account. Use the renewal evidence tools, or explicitly leave the renewal flow before starting contact or relationship research.",
    );
  }
  const emailControls = new Set(["beta_record_journey_a_approval", "beta_bind_outreach_draft_review", "beta_claim_outreach_draft", "beta_complete_outreach_draft"]);
  const scopedEmail = args.email_ref !== undefined || args.email_revision !== undefined;
  if (scopedEmail || (emailControls.has(name) && record.outreach_emails?.length && !record.outreach_identity_receipt)) {
    if (!emailControls.has(name)) throw new BetaError("INVALID_INPUT", "Email references apply only to this email's approval and draft controls.");
    const properties = tools.find(tool => tool.name === name).inputSchema.properties;
    if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new BetaError("INVALID_INPUT", "Use only this email's returned scope, verified-recipient receipt and review/draft fields. Caller-supplied addresses or copy are not accepted by the review controls.");
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    if (record.case_kind !== "real_authorized_journey_a") throw new BetaError("INVALID_CASE_KIND", "Use the verified individual email in this outreach case.");
    const scope = { ownerRef: runtime.testerId, revision: args.revision, emailRef: args.email_ref, emailRevision: args.email_revision };
    const view = projectOutreachEmail(record, scope);
    let updated, delivery = null;
    const receipt = view.outreach_identity_receipt;
    const assertRecipient = () => activeOutreachRecipientHandoffs.assert(view, { ownerRef: runtime.testerId, revision: view.revision,
      recipientRef: receipt.receipt_ref, toDigest: receipt.address_digest });
    const assertGuide = () => {
      if (view.renewal_source_receipt && view.renewal_source_mode !== "evidence_only") activeNativeRenewalSources.assertReceipt(view, runtime.testerId);
    };
    if (name === "beta_record_journey_a_approval") {
      if (!["contact_selection", "template_preview", "outreach_draft"].includes(args.gate)) throw new BetaError("OUTREACH_SHARED_REVIEW_REQUIRED", "Work and account reviews belong to the shared case; review this email's contact, template and wording separately.");
      if (args.renewal_source_mode && args.gate !== "template_preview") throw new BetaError("RENEWAL_SOURCE_DECISION_GATE_REQUIRED", "Record guide applicability only at this email's template review.");
      const mode = args.renewal_source_mode || view.renewal_source_mode;
      if (mode === "current_sequence" && !view.renewal_source_receipt) throw new BetaError("RENEWAL_SEQUENCE_COPY_REQUIRED", "Read the current approved guide before approving sequence-based wording.");
      if (view.renewal_source_receipt && mode !== "evidence_only" && ["template_preview", "outreach_draft"].includes(args.gate)) activeNativeRenewalSources.assertReceipt(view, runtime.testerId);
      assertRecipient();
      updated = approveJourneyAGate(view, { gate: args.gate, revision: view.revision, testerId: runtime.testerId, note: args.note });
      if (args.renewal_source_mode) updated.renewal_source_mode = args.renewal_source_mode;
    } else if (name === "beta_bind_outreach_draft_review") {
      assertGuide();
      activeOutreachRecipientHandoffs.assert(view, { ownerRef: runtime.testerId, revision: view.revision, recipientRef: args.recipient_ref, toDigest: args.to_digest });
      updated = bindOutreachDraftReview(view, { testerId: runtime.testerId, revision: view.revision, contentDigest: args.content_digest });
      activeOutreachRecipientHandoffs.advanceReview(view, updated, { ownerRef: runtime.testerId });
    } else if (name === "beta_claim_outreach_draft") {
      assertPerformanceMetricsSettled(record.case_id);
      if (!view.outreach_delivery || view.outreach_delivery.state === "review_ready") {
        assertGuide();
        activeOutreachRecipientHandoffs.assert(view, { ownerRef: runtime.testerId, revision: view.revision, recipientRef: args.recipient_ref, toDigest: args.to_digest });
      }
      const claimed = claimOutreachDraft(view, { testerId: runtime.testerId, revision: view.revision, contentDigest: args.content_digest, privateDraftAuthorized: args.private_draft_authorized });
      updated = claimed.record; delivery = claimed.delivery;
    } else {
      updated = completeOutreachDraft(view, { testerId: runtime.testerId, revision: view.revision, requestRef: args.draft_request_ref, providerDraftCreated: args.provider_draft_created });
      delivery = { status: updated.outreach_delivery.state, unsent_only: true };
    }
    const saved = saveOutreachEmail(record, updated, scope);
    writeCase(saved); // A separate message's write lease is persisted before invoking Gmail.
    return textResult({ ...outreachEmailReviewStatus(saved, scope.emailRef), ...(delivery || {}),
      next_action: "Continue this email using its email_ref and email_revision. Other emails and shared account research are unchanged; no communication was sent." });
  }
  if (name === "beta_prepare_outreach_email") {
    if (Object.keys(args).some(key => !["case_id", "revision", "contact_evidence_run_id", "contact_ref"].includes(key))) throw new BetaError("INVALID_INPUT", "Use one selected contact reference and the existing account case and evidence run. Do not submit addresses or a combined recipient list.");
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    if (record.case_kind !== "real_authorized_journey_a") throw new BetaError("INVALID_CASE_KIND", "Use the current verified outreach account preparation.");
    assertPerformanceMetricsSettled(record.case_id);
    const prepared = prepareOutreachEmail(record, { ownerRef: runtime.testerId, revision: args.revision, evidenceRunRef: args.contact_evidence_run_id, contactRef: args.contact_ref, handoffs: activeOutreachRecipientHandoffs });
    writeCase(prepared.record);
    return textResult({ ...prepared.email, account_research_reused: true, source_reads_started: false });
  }
  if (name === "beta_case_status") return textResult(publicCaseStatus(record));
  if (name === "beta_record_language_review") {
    const updated = recordLanguageReview(record, {
      outcome: args.outcome,
      issueCategories: args.issue_categories || [],
      testerId: runtime.testerId,
    });
    writeCase(updated);
    return textResult(publicCaseStatus(updated));
  }
  if (name === "beta_read_owned_cta_queue") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    if (record.case_kind !== "real_authorized_journey_a") {
      throw new BetaError("INVALID_CASE_KIND", "Create an authorized Account Prioritization and Outreach case before reading the CTA queue.");
    }
    const startedAt = Date.now();
    const policy = readJson(sourceConnectionPolicyPath).snowflake;
    pruneJourneyARuntimeState();
    const queue = await readOwnedCtaQueueWithSession({ session: journeyASnowflakeSession(record.case_id, policy.connection_name) });
    for (const [workItemRef, selection] of queue.runtimeSelectionByWorkItem) {
      const item = queue.queue.find((candidate) => candidate.work_item_ref === workItemRef);
      activeJourneyAQueueSelections.set(queueSelectionKey(record.case_id, workItemRef), {
        ...selection,
        priority: item?.priority || null,
        ctaTitle: item?.cta_title || null,
        ctaStatus: item?.cta_status || null,
        createdAt: item?.created_at || null,
        actionDeadline: item?.action_deadline || null,
        urgency: item?.action_state || null,
        expiresAt: Date.now() + JOURNEY_A_RUNTIME_SELECTION_TTL_MS,
      });
    }
    return textResult({
      status: "ready",
      first_response_ms: Date.now() - startedAt,
      queue: queue.queue,
      queue_display_table: queue.display_table,
      ownership_alerts: queue.ownership_alerts,
      source_limit_reached: queue.source_limit_reached,
      source_limit_warning: queue.source_limit_warning,
      read_deadline_seconds: queue.read_deadline_seconds,
      source: queue.source,
      read_at: queue.read_at,
      presentation: {
        format: "grouped_table",
        group_order: ["P0", "P1", "P2", "P3", "P4", "Other open CTAs"],
        columns: ["Priority", "Account", "CTA", "Status", "Created", "Action deadline", "Urgency"],
        instruction: "Return queue_display_table verbatim for an unfiltered CTA request. It is the complete bounded queue. Do not filter it to New, P0, newest items, or any other subset unless the CSM explicitly asks for that filter. Do not replace rows with prose or an 'and others' sentence.",
      },
      next_action: "Choose one CTA from the displayed priority table for account evidence. Moved-account warnings are not part of the priority queue.",
    });
  }
  if (name === "beta_get_renewal_sequence_guidance") {
    if (record.case_kind !== "real_authorized_journey_a") {
      throw new BetaError("INVALID_CASE_KIND", "Create an authorized Account Prioritization and Outreach case before using renewal sequence guidance.");
    }
    return textResult(getRenewalSequenceGuidance(args.priority));
  }
  if (["beta_resolve_renewal_sequence", "beta_continue_renewal_sequence"].includes(name)) {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    if (record.case_kind !== "real_authorized_journey_a") {
      throw new BetaError("INVALID_CASE_KIND", "Create an authorized Account Prioritization and Outreach case before reading renewal guidance.");
    }
    if (name === "beta_resolve_renewal_sequence") {
      return textResult(activeNativeRenewalSources.start({ ownerRef: runtime.testerId, caseRecord: record,
        priority: args.priority, language: args.language, languageVariant: args.language_variant || null }));
    }
    const result = activeNativeRenewalSources.accept({ ref: args.renewal_source_ref, ownerRef: runtime.testerId, caseRecord: record,
      tool: args.tool_name, sourceStatus: args.source_status, result: args.result });
    if (result.status === "ready") {
      const updated = structuredClone(record);
      const previous = record.renewal_source_receipt;
      if ((previous && (previous.sequence_content_digest !== result.receipt.sequence_content_digest || previous.scope_digest !== result.receipt.scope_digest)) || record.renewal_source_mode === "evidence_only") {
        if (record.outreach_delivery && record.outreach_delivery.state !== "review_ready")
          throw new BetaError("DRAFT_RECONCILIATION_REQUIRED", "An existing Gmail draft request must be reconciled before changing its approved sequence.");
        updated.revision += 1;
        updated.journey_state.contexts.journey_a.approvals = (updated.journey_state.contexts.journey_a.approvals || []).filter(approval => !["template_preview", "outreach_draft"].includes(approval.gate));
        delete updated.outreach_delivery;
        if (record.outreach_identity_receipt) activeOutreachRecipientHandoffs.advanceReview(record, updated, { ownerRef: runtime.testerId });
      }
      updated.renewal_source_receipt = result.receipt;
      updated.renewal_source_mode = "current_sequence";
      writeCase(updated);
      result.revision = updated.revision;
    }
    return textResult(result);
  }
  if (["beta_read_portfolio_recent_relationships", "beta_continue_portfolio_recent_relationships"].includes(name)) {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    if (record.case_kind !== "real_authorized_journey_a") {
      throw new BetaError("INVALID_CASE_KIND", "Create an authorized Account Prioritization and Outreach case before reading portfolio relationship activity.");
    }
    if (name === "beta_read_portfolio_recent_relationships") {
      const policy = readJson(sourceConnectionPolicyPath).snowflake;
      pruneJourneyARuntimeState();
      return textResult(activePortfolioRelationshipReads.start({ ownerRef: runtime.testerId, caseId: record.case_id,
        read: onProgress => readPortfolioRelationships({ session: journeyASnowflakeSession(record.case_id, policy.connection_name),
          lookbackDays: args.lookback_days ?? 60, onProgress }) }));
    }
    const scope = { ref: args.relationship_read_ref, ownerRef: runtime.testerId, caseId: record.case_id };
    let relationships = activePortfolioRelationshipReads.poll(scope);
    if (relationships.status === "in_progress" && args.wait_seconds !== 0) {
      const waitSeconds = Number.isInteger(args.wait_seconds) ? Math.min(Math.max(args.wait_seconds, 0), 20) : 20;
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      relationships = activePortfolioRelationshipReads.poll(scope);
    }
    if (relationships.status !== "ready") return textResult(relationships, relationships.status === "failed");
    pruneJourneyARuntimeState();
    for (const [workItemRef, selection] of relationships.runtimeSelectionByWorkItem) {
      activeJourneyAQueueSelections.set(queueSelectionKey(record.case_id, workItemRef), {
        ...selection,
        expiresAt: Math.min(Date.parse(relationships.expires_at), Date.now() + JOURNEY_A_RUNTIME_SELECTION_TTL_MS),
      });
    }
    return textResult(relationships);
  }
  if (name === "beta_register_selected_account") {
    if (record.case_kind !== "real_authorized_journey_a") {
      throw new BetaError("INVALID_CASE_KIND", "Create an authorized Account Prioritization and Outreach case before selecting an account.");
    }
    pruneJourneyARuntimeState();
    const accountSelectionRef = crypto.randomUUID();
    const accountRefDigest = crypto.createHash("sha256").update(`account:${args.account_runtime_id}`).digest("hex");
    if (record.journey_state?.account_ref_digest && record.journey_state.account_ref_digest !== accountRefDigest) {
      throw new BetaError("CROSS_JOURNEY_ACCOUNT_MISMATCH", "The selected account does not match the account already bound to this case.");
    }
    activeJourneyAAccountSelections.set(accountSelectionRef, {
      caseId: record.case_id,
      testerId: runtime.testerId,
      accountId: args.account_runtime_id,
      accountName: "Selected account",
      accountRefDigest,
      selectionOrigin: args.selection_origin,
      expiresAt: Date.now() + JOURNEY_A_RUNTIME_SELECTION_TTL_MS,
    });
    return textResult({
      status: "selected",
      account_selection_ref: accountSelectionRef,
      account_ref_digest: accountRefDigest,
      selection_origin: args.selection_origin,
      next_action: "Run the account and contact-evidence reads. No CTA is required.",
    });
  }
  if (name === "beta_run_journey_a_contact_evidence") {
    const properties = tools.find(tool => tool.name === name).inputSchema.properties;
    if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new BetaError('INVALID_INPUT', 'Use only this control\'s bounded arguments and returned account selection references.');
    if (record.case_kind !== "real_authorized_journey_a") {
      throw new BetaError("INVALID_CASE_KIND", "Create an authorized Account Prioritization and Outreach case before running contact evidence.");
    }
    pruneJourneyARuntimeState();
    const suppliedSelections = [args.work_item_ref, args.account_selection_ref, args.manager_account_selection_ref].filter(Boolean).length;
    if (suppliedSelections !== 1) {
      throw new BetaError("ACCOUNT_SELECTION_REQUIRED", "Use exactly one selected CTA item, registered account selection or manager account selection.");
    }
    const selectionKey = args.work_item_ref ? queueSelectionKey(record.case_id, args.work_item_ref) : args.account_selection_ref;
    const selectedManagerAccount = managerSelection(args, runtime);
    const selection = selectedManagerAccount || (args.work_item_ref
      ? activeJourneyAQueueSelections.get(selectionKey)
      : activeJourneyAAccountSelections.get(selectionKey));
    if (!selection) {
      throw new BetaError("ACCOUNT_SELECTION_EXPIRED", "Select the account again from a fresh approved source read before account evidence can run.");
    }
    // Selection bindings contain a raw account identifier. They are one-use
    // and cleared before any source read starts.
    if (args.work_item_ref) activeJourneyAQueueSelections.delete(selectionKey);
    else if (!selectedManagerAccount) activeJourneyAAccountSelections.delete(selectionKey);
    const accountRefDigest = crypto.createHash("sha256").update(`account:${selection.accountId}`).digest("hex");
    if (record.journey_state?.account_ref_digest && record.journey_state.account_ref_digest !== accountRefDigest) {
      throw new BetaError("CROSS_JOURNEY_ACCOUNT_MISMATCH", "The selected CTA does not match the account already bound to this case.");
    }
    const contactEvidenceRunId = crypto.randomUUID();
    // A new source read cannot transfer a previous contact/email approval.
    activeOutreachRecipientHandoffs.forgetCase(record.case_id);
    let coreEvidence;
    try {
      if (selectedManagerAccount) await verifyManagerSelectedAccountWithSession({
        session: journeyASnowflakeSession(record.case_id, readJson(sourceConnectionPolicyPath).snowflake.connection_name),
        selection: selectedManagerAccount, authority: managerAuthority(runtime),
      });
      coreEvidence = await readCoreContactEvidenceWithSession({
        accountId: selection.accountId,
        accountName: selection.accountName,
        session: journeyASnowflakeSession(record.case_id, readJson(sourceConnectionPolicyPath).snowflake.connection_name),
      });
    } catch (error) {
      closeJourneyASnowflakeSession(record.case_id);
      throw error;
    }
    const recommendations = recommendContacts(coreEvidence.contacts, coreEvidence.source_states);
    const updated = recordJourneyAContactVerification(record, {
      accountRefDigest,
      salesforceIdentityState: coreEvidence.source_states.salesforce_identity,
      contactSnapshotState: "checked",
      salesforceActivityState: "not_requested",
      gmailMetadataState: "not_requested",
      gongMetadataState: "not_requested",
      gongLookbackDays: 180,
      candidateCount: coreEvidence.contacts.length,
      eligibleContactCount: recommendations.eligible_contact_count,
      testerId: runtime.testerId,
    });
    if (selectedManagerAccount) updated.account_scope = 'manager_selected_account';
    writeCase(updated);
    activeJourneyAContactEvidenceRuns.set(contactEvidenceRunId, {
      caseId: record.case_id,
      testerId: runtime.testerId,
      accountRefDigest,
      accountId: selection.accountId,
      coreEvidence,
      workItemRef: args.work_item_ref || null,
      expiresAt: Date.now() + JOURNEY_A_RUNTIME_SELECTION_TTL_MS,
    });
    return textResult({
      status: contactReadStatus(recommendations, coreEvidence.source_states, "contact_shortlist_ready"),
      contact_evidence_run_id: contactEvidenceRunId,
      candidate_count: coreEvidence.contacts.length,
      source_states: coreEvidence.source_states,
      source_durations_ms: coreEvidence.source_durations_ms,
      brief: coreEvidence.brief,
      ...publicContactRecommendations(recommendations),
      outreach_pack: buildOutreachPack({
        brief: coreEvidence.brief,
        contacts: recommendations.prioritized_contacts,
        sourceStates: coreEvidence.source_states,
        sourceGaps: coreEvidence.source_gap_codes,
        status: contactReadStatus(recommendations, coreEvidence.source_states, "contacts_ready_metrics_pending"),
      }),
      case: publicCaseStatus(updated),
      workflow: publicJourneyStatus(updated),
      user_notice: recommendations.contacts.length
        ? "The suggested contacts are ready now. Latest recorded sales touch is a ranking indicator, not proof that you spoke with the person."
        : recommendations.prioritized_contacts.length
          ? "Contact priorities are ready. Their snapshot emails were unavailable; the same contacts' details still need verification. No recipient is ready yet."
          : recommendations.message,
      next_action: recommendations.contacts.length
        ? "Show the contacts now and continue automatically to add the measured performance trends and account context. Do not wait for optional relationship sources."
        : recommendations.prioritized_contacts.length
          ? "Show prioritized_contacts with sales-touch dates and days since touch. Continue automatically to verify the same contacts in Salesforce; do not select a recipient or create a draft yet."
          : "Show the contact rejection reasons and continue automatically to add measured performance trends and account context. No recipient is recommended from these records.",
    });
  }
  if (name === "beta_run_bulk_contact_research") {
    if (record.case_kind !== "real_authorized_journey_a") {
      throw new BetaError("INVALID_CASE_KIND", "Create an authorized Account Prioritization and Outreach case before researching contacts.");
    }
    pruneJourneyARuntimeState();
    const selectedItems = args.work_item_refs.map((workItemRef) => {
      const selection = activeJourneyAQueueSelections.get(queueSelectionKey(record.case_id, workItemRef));
      if (!selection) {
        throw new BetaError("ACCOUNT_SELECTION_EXPIRED", "Refresh the CTA queue and select the accounts again before bulk contact research.");
      }
      return { ...selection, workItemRef };
    });
    const uniqueAccounts = [...new Map(selectedItems.map((selection) => [selection.accountId, selection])).values()];
    if (uniqueAccounts.length < 2) {
      throw new BetaError("BULK_CONTACT_RESEARCH_REQUIRES_DISTINCT_ACCOUNTS", "Select CTA items from at least two different current-book accounts for bulk contact research.");
    }
    const result = await readBulkCoreContactEvidenceWithSession({
      selections: uniqueAccounts,
      session: journeyASnowflakeSession(record.case_id, readJson(sourceConnectionPolicyPath).snowflake.connection_name),
      includeContactEmails: args.include_copy_ready_emails === true,
    });
    const bulkRef = crypto.randomUUID();
    const run = {
      caseId: record.case_id,
      snapshotRows: result.runtimeSnapshotRows,
      selections: result.runtimeSelections,
      state: "not_started",
      expiresAt: Date.now() + JOURNEY_A_RUNTIME_SELECTION_TTL_MS,
    };
    activeBulkContactResearch.set(bulkRef, run);
    if (args.include_copy_ready_emails === true) startBulkContactVerification(run, record.case_id);
    return textResult({
      status: "bulk_contact_shortlist_ready",
      bulk_contact_research_ref: bulkRef,
      account_count: result.accounts.length,
      accounts: result.accounts,
      email_verification_state: run.state,
      recipient_export: null,
      source: result.source,
      source_states: result.source_states,
      source_durations_ms: result.source_durations_ms,
      read_at: result.read_at,
      next_action: run.state === "pending"
        ? "Show this priority shortlist now. The separate Salesforce email check is running; poll beta_get_bulk_contact_email_verification and update the CSM while it runs. No address is verified yet."
        : "Show this priority shortlist now. If the CSM asks for actual addresses, call beta_verify_bulk_contact_emails using this research reference. Do not create a draft or enrollment.",
    });
  }
  if (name === "beta_verify_bulk_contact_emails" || name === "beta_get_bulk_contact_email_verification") {
    if (record.case_kind !== "real_authorized_journey_a") {
      throw new BetaError("INVALID_CASE_KIND", "A current Account Prioritization and Outreach case is required for contact verification.");
    }
    pruneJourneyARuntimeState();
    const run = activeBulkContactResearch.get(args.bulk_contact_research_ref);
    if (!run || run.caseId !== record.case_id) {
      throw new BetaError("BULK_CONTACT_RESEARCH_EXPIRED", "The in-memory shortlist expired. Refresh the selected accounts before verifying addresses.");
    }
    if (name === "beta_verify_bulk_contact_emails") {
      if (args.explicit_email_request !== true) throw new BetaError("EMAIL_REQUEST_REQUIRED", "Actual addresses require an explicit CSM request.");
      startBulkContactVerification(run, record.case_id);
    }
    if (run.state === "not_started") {
      return textResult({ status: "email_verification_not_requested", next_action: "Ask the CSM before retrieving actual email addresses." });
    }
    if (run.state === "pending") {
      return textResult({ status: "bulk_contact_email_verification_pending", bulk_contact_research_ref: args.bulk_contact_research_ref,
        source_progress: { source: "salesforce_contact_details", elapsed_seconds: Math.floor((Date.now() - run.startedAt) / 1000), source_deadline_seconds: 120 },
        next_action: "Keep the already returned shortlist visible. Give the CSM a progress update about every 20 seconds and poll this same reference. Do not restart the snapshot or case." });
    }
    if (run.state === "failed") {
      return textResult({ status: "bulk_contact_email_verification_failed", code: run.errorCode,
        account_count: run.selections.length, recipient_export: null,
        next_action: "The earlier priority shortlist remains valid, but no email address was verified. Do not describe the list as copy-ready." });
    }
    return textResult({ status: "bulk_contact_email_verification_ready",
      account_count: run.result.accounts.length, accounts: run.result.accounts,
      recipient_export: run.result.recipient_export, source_states: run.result.source_states,
      read_at: run.result.read_at,
      next_action: run.result.recipient_export?.recipient_count
        ? "Show the verified contacts and copy-ready addresses for manual CSM use. No enrollment or message was created."
        : "No copy-ready address was verified. Show each account's unmatched, invalid, or unavailable address warnings; do not say the list is ready." });
  }
  if (name === "beta_get_renewal_preparation_options") {
    if (record.case_kind !== "real_authorized_journey_a") {
      throw new BetaError("INVALID_CASE_KIND", "Create an authorized Account Prioritization and Outreach case before choosing renewal preparation.");
    }
    pruneJourneyARuntimeState();
    const selection = activeJourneyAQueueSelections.get(queueSelectionKey(record.case_id, args.work_item_ref));
    if (!selection) throw new BetaError("ACCOUNT_SELECTION_EXPIRED", "Refresh the CTA queue and select the renewal CTA again.");
    return textResult(renewalPreparationChoice({ priority: selection.priority, cta_title: selection.ctaTitle }, {
      explicitlyRequested: args.explicitly_requested === true,
    }));
  }
  if (name === "beta_prepare_renewal_conversation_brief") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    if (record.case_kind !== "real_authorized_journey_a") {
      throw new BetaError("INVALID_CASE_KIND", "Create an authorized Account Prioritization and Outreach case before preparing a renewal call.");
    }
    pruneJourneyARuntimeState();
    const activeRenewal = activeRenewalRunForCase({ caseId: record.case_id, testerId: runtime.testerId });
    if (activeRenewal) {
      throw new BetaError(
        "RENEWAL_ACCOUNT_ALREADY_ACTIVE",
        "Finish, skip, or retry later for the current renewal account before starting another one. Each account has its own evidence and draft decision.",
        { renewal_conversation_run_id: activeRenewal[0], selected_account: activeRenewal[1].selectedCta.account },
      );
    }
    const selectionKey = queueSelectionKey(record.case_id, args.work_item_ref);
    const selection = activeJourneyAQueueSelections.get(selectionKey);
    if (!selection) throw new BetaError("ACCOUNT_SELECTION_EXPIRED", "Refresh the CTA queue and select the renewal CTA again.");
    if (!isRenewalCta({ priority: selection.priority, cta_title: selection.ctaTitle })) {
      throw new BetaError("RENEWAL_CTA_REQUIRED", "The Renewal Conversation Brief is available only for a selected P0–P4 renewal CTA.");
    }
    activeJourneyAQueueSelections.delete(selectionKey);
    const updated = structuredClone(record);
    const accountRefDigest = crypto.createHash("sha256").update(`account:${selection.accountId}`).digest("hex");
    updated.revision += 1;
    updated.approvals = [];
    updated.status = "in_review";
    updated.renewal_conversation = {
      schema_version: "1.0.0",
      account_ref_digest: accountRefDigest,
      evidence_state: "collecting",
      source_states: { account_context: "pending", rba_metrics: "pending", guide_knowledge_views: "pending" },
      source_gap_codes: [],
      selected_cta_urgency: selection.urgency,
      slide_count: 3,
      approvals: [],
      raw_customer_content_retained: false,
      prepared_at: new Date().toISOString(),
    };
    updated.updated_at = new Date().toISOString();
    const runId = crypto.randomUUID();
    updated.renewal_conversation.run_ref_digest = renewalRunDigest(runId);
    writeCase(updated);
    const run = {
      caseId: updated.case_id,
      testerId: runtime.testerId,
      revision: updated.revision,
      state: "collecting",
      selectedCta: {
        account: selection.accountName,
        priority: selection.priority,
        title: selection.ctaTitle,
        status: selection.ctaStatus,
        created_at: selection.createdAt,
        action_deadline: selection.actionDeadline,
        urgency: renewalCtaDeadlineStatus({
          status: selection.ctaStatus,
          action_deadline: selection.actionDeadline,
        }),
        monitor_link: selection.monitorLink || null,
      },
      expiresAt: Date.now() + JOURNEY_A_RUNTIME_SELECTION_TTL_MS,
    };
    activeRenewalConversationRuns.set(runId, run);
    run.startedAt = Date.now();
    run.stageStartedAt = run.startedAt;
    run.evidencePromise = readRenewalConversationEvidenceWithSession({
      accountId: selection.accountId,
      selectedCta: run.selectedCta,
      session: journeyASnowflakeSession(record.case_id, readJson(sourceConnectionPolicyPath).snowflake.connection_name),
      onProgress: (progress) => {
        if (run.sourceProgress?.stage !== progress.stage) run.stageStartedAt = Date.now();
        run.sourceProgress = progress;
      },
    }).then((evidence) => {
      if (!beginRenewalReviewWindow(runId, run)) return null;
      run.evidence = evidence;
      run.metricTable = evidence.metric_table;
      run.state = evidence.status;
      run.executionReceipt = {
        schema_version: "1.0.0",
        package_version: runtime.manifest.package_version,
        statement_order: evidence.statement_executions,
        retry_state: evidence.statement_executions.some((entry) => entry.retry_state !== "not_retried")
          ? "account_context_retried"
          : "not_retried",
        safe_source_outcome: evidence.status,
      };
      const current = readCase(updated.case_id);
      if (current.revision === run.revision && current.renewal_conversation?.evidence_state === "collecting") {
        let refreshed = structuredClone(current);
        refreshed.renewal_conversation.evidence_state = evidence.status;
        refreshed.renewal_conversation.evidence_receipt = evidence.evidence_receipt;
        refreshed.renewal_conversation.account_intelligence_receipt = evidence.account_intelligence_receipt;
        refreshed.renewal_conversation.source_states = evidence.source_states;
        refreshed.renewal_conversation.source_gap_codes = evidence.review_package.source_gaps;
        refreshed.renewal_conversation.completed_at = evidence.read_at;
        refreshed.updated_at = evidence.read_at;
        refreshed = bindAccountIntelligenceCore(refreshed, {
          contract: evidence.account_intelligence_receipt.contract,
          schemaVersion: evidence.account_intelligence_receipt.schema_version,
          contentDigest: evidence.account_intelligence_receipt.content_digest,
          briefState: evidence.account_intelligence_receipt.brief_state,
          sectionStates: evidence.account_intelligence_receipt.section_states,
          sourceGapCodes: evidence.account_intelligence_receipt.source_gap_codes,
          accountRefDigest: evidence.account_intelligence_receipt.account_ref_digest,
          revision: run.revision,
          testerId: runtime.testerId,
          now: new Date(evidence.read_at),
        });
        writeCase(refreshed);
        // Binding changed account truth can issue a new revision. Adopt only
        // this run's successfully persisted binding, not a later case revision
        // observed by a getter; stale or concurrent reviews must still stop.
        run.revision = refreshed.revision;
      }
      return evidence;
    }).catch((error) => {
      // The collection may have been pruned or cancelled while the SDK was
      // waiting. Never repopulate its customer cache or persisted review state.
      if (!beginRenewalReviewWindow(runId, run)) return null;
      run.state = "needs_csm_decision";
      run.evidenceError = error instanceof BetaError
        ? { code: error.code, message: error.message, details: error.details || null }
        : { code: "RENEWAL_EVIDENCE_UNAVAILABLE", message: "The managed renewal evidence run could not complete.", details: null };
      const sourceStates = { account_context: "unavailable", rba_metrics: "unavailable", guide_knowledge_views: "unavailable" };
      run.evidence = {
        status: "needs_csm_decision",
        evidence_receipt: crypto.createHash("sha256").update(`${updated.case_id}:${run.evidenceError.code}`).digest("hex"),
        review_package: buildRenewalConversationBrief({ metricRows: [], sourceStates }),
        metric_table: { rows: [], coverage: "unavailable" },
        source_states: sourceStates,
        source_durations_ms: {},
        statement_executions: [],
        read_at: new Date().toISOString(),
      };
      run.metricTable = run.evidence.metric_table;
      run.executionReceipt = {
        schema_version: "1.0.0",
        package_version: runtime.manifest.package_version,
        statement_order: [],
        retry_state: "not_retried",
        safe_source_outcome: run.evidenceError.code,
      };
      const current = readCase(updated.case_id);
      if (current.revision === run.revision && current.renewal_conversation?.evidence_state === "collecting") {
        const refreshed = structuredClone(current);
        refreshed.renewal_conversation.evidence_state = "needs_csm_decision";
        refreshed.renewal_conversation.evidence_receipt = run.evidence.evidence_receipt;
        refreshed.renewal_conversation.source_states = sourceStates;
        refreshed.renewal_conversation.source_gap_codes = ["RENEWAL_EVIDENCE_UNAVAILABLE"];
        refreshed.updated_at = new Date().toISOString();
        writeCase(refreshed);
      }
      return null;
    }).finally(() => closeJourneyASnowflakeSession(updated.case_id));
    return textResult({
      status: "collecting",
      renewal_conversation_run_id: runId,
      revision: updated.revision,
      selected_cta: run.selectedCta,
      notice_after_seconds: RENEWAL_EVIDENCE_NOTICE_MS / 1000,
      continuation_request: { tool: "beta_continue_renewal_preparation", arguments: {
        case_id: updated.case_id, renewal_conversation_run_id: runId, wait_seconds: 25,
      } },
      next_action: "Continue waiting automatically. Do not ask the CSM to send another message or start contact research.",
    });
  }
  if (name === "beta_continue_renewal_preparation") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    return continueRenewalPreparation({ caseId: record.case_id, runId: args.renewal_conversation_run_id,
      ownerRef: runtime.testerId, packageVersion: runtime.manifest.package_version,
      waitSeconds: args.wait_seconds ?? 25, localFileDeliveryAuthorized: args.local_file_delivery_authorized ?? false,
      getRun: () => { pruneJourneyARuntimeState(); return renewalRunFor({ caseId: record.case_id,
        runId: args.renewal_conversation_run_id, testerId: runtime.testerId }); },
      getCase: () => readCase(record.case_id), projectEvidence: run => renewalCsmEvidence(run),
      createChart: ({ display, chartId, ...scope }) => temporaryAccountBriefChartFiles.create(accountBriefChartResult(display, chartId), scope),
    });
  }
  if (name === "beta_wait_for_renewal_conversation_evidence") {
    pruneJourneyARuntimeState();
    const run = renewalRunFor({ caseId: record.case_id, runId: args.renewal_conversation_run_id, testerId: runtime.testerId });
    if (run.state === "collecting") {
      const waitMs = (args.wait_seconds ?? 25) * 1000;
      await Promise.race([run.evidencePromise, new Promise((resolve) => setTimeout(resolve, waitMs))]);
    }
    if (run.state === "collecting") {
      return textResult({
        status: "still_preparing",
        renewal_conversation_run_id: args.renewal_conversation_run_id,
        selected_cta: run.selectedCta,
        elapsed_notice: "Still preparing this selected renewal account. No action is needed from you.",
        source_progress: run.sourceProgress ? { ...run.sourceProgress,
          stage_elapsed_seconds: Math.floor((Date.now() - run.stageStartedAt) / 1000),
          elapsed_seconds: Math.floor((Date.now() - run.startedAt) / 1000) } : null,
        next_action: "Continue waiting automatically for the final evidence state.",
      });
    }
    if (!run.evidence) {
      return textResult({
        status: "needs_csm_decision",
        renewal_conversation_run_id: args.renewal_conversation_run_id,
        selected_cta: run.selectedCta,
        source_states: readCase(record.case_id).renewal_conversation?.source_states,
        source_gap_codes: readCase(record.case_id).renewal_conversation?.source_gap_codes,
        execution_receipt: { package_version: runtime.manifest.package_version, safe_source_outcome: run.evidenceError?.code || "RENEWAL_EVIDENCE_UNAVAILABLE" },
        next_action: "Show the available evidence and customer-content candidates before asking the CSM whether to add context, retry later, or skip.",
      });
    }
    return textResult({
      status: run.evidence.status,
      renewal_conversation_run_id: args.renewal_conversation_run_id,
      revision: run.revision,
      ...renewalCsmEvidence(run),
      next_action: ["evidence_ready", "evidence_ready_with_gaps"].includes(run.evidence.status)
        ? "Show the full CSM evidence tables and all customer-content review tables. Then ask the CSM to choose one to three metric candidates and one to three linked opportunity-and-focus pairs. Do not treat 'continue' as approval."
        : "Show the full CSM evidence tables and all available customer-content review tables before asking whether to add CSM context, retry later, or skip.",
    });
  }
  if (name === "beta_get_renewal_conversation_evidence") {
    pruneJourneyARuntimeState();
    const run = renewalRunFor({ caseId: record.case_id, runId: args.renewal_conversation_run_id, testerId: runtime.testerId });
    return textResult({ renewal_conversation_run_id: args.renewal_conversation_run_id, ...renewalCsmEvidence(run, args.display_focus, args.display_details) });
  }
  if (name === "beta_add_renewal_csm_context") {
    pruneJourneyARuntimeState();
    if (args.confirmed_by_csm !== true) {
      throw new BetaError("RENEWAL_CSM_CONFIRMATION_REQUIRED", "Add this context only after the CSM explicitly states it for the selected account.");
    }
    const run = renewalRunFor({ caseId: record.case_id, runId: args.renewal_conversation_run_id, testerId: runtime.testerId });
    if (!run.evidence || !["needs_csm_decision", "evidence_ready", "evidence_ready_with_gaps"].includes(run.state)) {
      throw new BetaError("RENEWAL_CSM_CONTEXT_NOT_AVAILABLE", "CSM context can be added only before renewal customer content is frozen.");
    }
    if (record.revision !== args.revision || run.revision !== args.revision) {
      throw new BetaError("STALE_CASE_REVISION", "Refresh the current renewal evidence before adding CSM context.");
    }
    const reviewPackage = addRenewalCsmContext({
      reviewPackage: run.evidence.review_package,
      metricRows: run.metricTable?.rows || [],
      context: args.context,
    });
    run.evidence.review_package = reviewPackage;
    run.evidence.status = reviewPackage.content_readiness.state === "ready_for_csm_selection" ? "evidence_ready_with_gaps" : "needs_csm_decision";
    run.state = run.evidence.status;
    const updated = structuredClone(record);
    updated.renewal_conversation.evidence_state = run.state;
    updated.renewal_conversation.csm_context_receipt = crypto.createHash("sha256").update(`${args.renewal_conversation_run_id}:${args.context}`).digest("hex");
    updated.updated_at = new Date().toISOString();
    writeCase(updated);
    return textResult({
      renewal_conversation_run_id: args.renewal_conversation_run_id,
      revision: run.revision,
      ...renewalCsmEvidence(run),
      next_action: "Show the CSM context and revised candidate tables. Ask the CSM to review the proposed wording and confirm commercial access before a product adoption recommendation.",
    });
  }
  if (name === "beta_select_renewal_deck_content") {
    pruneJourneyARuntimeState();
    const run = renewalRunFor({ caseId: record.case_id, runId: args.renewal_conversation_run_id, testerId: runtime.testerId });
    if (!run.evidence || !["evidence_ready", "evidence_ready_with_gaps"].includes(run.state) || run.evidence.review_package.content_readiness?.state !== "ready_for_csm_selection") {
      throw new BetaError("RENEWAL_CONTENT_NOT_READY", "The renewal evidence must support at least one progress metric and one linked opportunity before selecting customer content.");
    }
    if (record.revision !== args.revision || run.revision !== args.revision) {
      throw new BetaError("STALE_CASE_REVISION", "Refresh the current renewal evidence before selecting customer content.");
    }
    const deckContent = buildRenewalDeckContent({
      reviewPackage: run.evidence.review_package,
      selectedMetricIds: args.selected_metric_ids,
      selectedPairIds: args.selected_pair_ids,
    });
    const updated = structuredClone(record);
    updated.revision += 1;
    updated.approvals = [];
    updated.renewal_conversation.approvals = [];
    updated.renewal_conversation.evidence_state = "native_fit_required";
    updated.renewal_conversation.deck_content_schema_version = deckContent.schema_version;
    updated.renewal_conversation.deck_content_revision = updated.revision;
    updated.renewal_conversation.selected_metric_ids = deckContent.selected_metric_ids;
    updated.renewal_conversation.selected_pair_ids = deckContent.selected_pair_ids;
    updated.renewal_conversation.deck_content_digest = crypto.createHash("sha256").update(JSON.stringify(deckContent.customer_slides)).digest("hex");
    updated.renewal_conversation.content_status = "native_fit_pending";
    delete updated.renewal_conversation.native_fit_receipt;
    delete updated.renewal_conversation.draft_handoff_receipt;
    updated.updated_at = new Date().toISOString();
    writeCase(updated);
    run.revision = updated.revision;
    run.state = "native_fit_required";
    run.deckContent = { ...deckContent, content_status: "native_fit_pending" };
    run.nativeFitReceipt = null;
    run.nativeFitInventory = null;
    run.nativeFitPending = beginRenewalNativePreflight({ caseRecord: updated, ownerRef: runtime.testerId, deckContent, expiresAt: run.expiresAt });
    return textResult({
      status: "native_fit_required",
      renewal_conversation_run_id: args.renewal_conversation_run_id,
      revision: updated.revision,
      renewal_deck_content: run.deckContent,
      native_fit_request_ref: run.nativeFitPending.requestRef,
      native_layout_capture_request: JSON.stringify(renewalNativeLayoutRequest(run.nativeFitPending, expectedReleaseComponents())),
      review_window: renewalReviewWindow(run),
      next_action: "Run this read-only capture in the existing private Renewal Brief Renderer, then pass its native_layout result to beta_bind_renewal_native_fit. Do not send customer content to capture, create a draft, or ask for wording approval yet.",
    });
  }
  if (name === "beta_bind_renewal_native_fit") {
    pruneJourneyARuntimeState();
    const run = renewalRunFor({ caseId: record.case_id, runId: args.renewal_conversation_run_id, testerId: runtime.testerId });
    if (run.state !== "native_fit_required" || !run.deckContent || record.revision !== args.revision || run.revision !== args.revision || run.nativeFitPending?.requestRef !== args.native_fit_request_ref) {
      throw new BetaError("RENEWAL_NATIVE_PREFLIGHT_SCOPE_MISMATCH", "Use the current native layout request for this selected renewal content and revision.");
    }
    if (expectedReleaseComponents()) assertRendererCompatibility("renewal_preparation", args.native_result?.renderer_components);
    const fitted = bindRenewalNativePreflight({ pending: run.nativeFitPending, nativeResult: args.native_result, caseRecord: record, ownerRef: runtime.testerId, deckContent: run.deckContent });
    const updated = structuredClone(record);
    updated.renewal_conversation.native_fit_receipt = fitted.receipt;
    updated.renewal_conversation.evidence_state = "review_ready";
    updated.renewal_conversation.content_status = "frozen_for_review";
    updated.updated_at = new Date().toISOString();
    writeCase(updated);
    run.nativeFitReceipt = fitted.receipt;
    run.nativeFitInventory = fitted.inventory;
    run.nativeFitPending = null;
    run.state = "review_ready";
    run.deckContent.content_status = "frozen_for_review";
    return textResult({ status: "review_ready", revision: record.revision, renewal_conversation_run_id: args.renewal_conversation_run_id,
      renewal_deck_content: run.deckContent, native_fit_receipt: fitted.receipt,
      review_window: renewalReviewWindow(run),
      next_action: "Show the exact customer_slides for wording review, not the longer CSM annual review context. Record explicit identity, evidence, hypothesis and customer-content approvals in order. Draft authorization and rendered human review remain separate." });
  }
  if (name === "beta_revise_renewal_customer_copy") {
    pruneJourneyARuntimeState();
    const run = renewalRunFor({ caseId: record.case_id, runId: args.renewal_conversation_run_id, testerId: runtime.testerId });
    if (!run.evidence || !["review_ready", "native_fit_required"].includes(run.state) || !run.deckContent) {
      throw new BetaError("RENEWAL_CONTENT_SELECTION_REQUIRED", "Select the reviewed renewal metrics and pairs before revising customer wording.");
    }
    if (record.revision !== args.revision || run.revision !== args.revision || record.renewal_conversation?.deck_content_revision !== args.revision) {
      throw new BetaError("STALE_CASE_REVISION", "Refresh the current frozen renewal wording before revising it.");
    }
    const deckContent = buildRenewalDeckContent({
      reviewPackage: run.evidence.review_package,
      selectedMetricIds: run.deckContent.selected_metric_ids,
      selectedPairIds: run.deckContent.selected_pair_ids,
    });
    if (args.recheck_native_fit !== true && JSON.stringify(deckContent.customer_slides) === JSON.stringify(run.deckContent.customer_slides)) {
      return textResult({
        status: "unchanged",
        code: "RENEWAL_CUSTOMER_COPY_UNCHANGED",
        renewal_conversation_run_id: args.renewal_conversation_run_id,
        revision: record.revision,
        next_action: "The installed copy contract produced the same customer wording. No new revision or approval was recorded. Do not render rejected wording; report the requested change to the beta owner.",
      });
    }
    const updated = structuredClone(record);
    const nextRevision = updated.revision + 1;
    const retainedApprovals = (updated.renewal_conversation.approvals || [])
      .filter((approval) => ["identity", "evidence", "renewal_hypotheses"].includes(approval.gate))
      .map((approval) => ({
        ...approval,
        revision: nextRevision,
        carried_forward_from_revision: approval.revision,
      }));
    updated.revision = nextRevision;
    updated.approvals = [];
    updated.renewal_conversation.approvals = retainedApprovals;
    updated.renewal_conversation.evidence_state = "native_fit_required";
    updated.renewal_conversation.deck_content_schema_version = deckContent.schema_version;
    updated.renewal_conversation.deck_content_revision = nextRevision;
    updated.renewal_conversation.selected_metric_ids = deckContent.selected_metric_ids;
    updated.renewal_conversation.selected_pair_ids = deckContent.selected_pair_ids;
    updated.renewal_conversation.deck_content_digest = crypto.createHash("sha256").update(JSON.stringify(deckContent.customer_slides)).digest("hex");
    updated.renewal_conversation.content_status = "native_fit_pending";
    delete updated.renewal_conversation.native_fit_receipt;
    delete updated.renewal_conversation.draft_handoff_receipt;
    updated.renewal_conversation.customer_copy_contract = deckContent.customer_copy_contract;
    updated.updated_at = new Date().toISOString();
    writeCase(updated);
    run.revision = nextRevision;
    run.state = "native_fit_required";
    run.deckContent = { ...deckContent, content_status: "native_fit_pending" };
    run.nativeFitReceipt = null;
    run.nativeFitInventory = null;
    run.nativeFitPending = beginRenewalNativePreflight({ caseRecord: updated, ownerRef: runtime.testerId, deckContent, expiresAt: run.expiresAt });
    return textResult({
      status: "native_fit_required",
      renewal_conversation_run_id: args.renewal_conversation_run_id,
      revision: nextRevision,
      renewal_deck_content: run.deckContent,
      native_fit_request_ref: run.nativeFitPending.requestRef,
      native_layout_capture_request: JSON.stringify(renewalNativeLayoutRequest(run.nativeFitPending, expectedReleaseComponents())),
      retained_review_gates: retainedApprovals.map((approval) => approval.gate),
      review_window: renewalReviewWindow(run),
      next_action: "Recheck the native layout with the read-only capture and beta_bind_renewal_native_fit, then show the exact revised customer slides. Customer-content approval is required again; unchanged earlier evidence reviews are retained.",
    });
  }
  if (name === "beta_record_renewal_partial_evidence_decision") {
    pruneJourneyARuntimeState();
    const run = renewalRunFor({ caseId: record.case_id, runId: args.renewal_conversation_run_id, testerId: runtime.testerId });
    if (run.state !== "needs_csm_decision") {
      throw new BetaError("RENEWAL_DECISION_NOT_REQUIRED", "A partial-evidence decision is available only after this renewal evidence run is incomplete.");
    }
    const updated = structuredClone(record);
    updated.renewal_conversation.evidence_state = args.decision;
    updated.updated_at = new Date().toISOString();
    writeCase(updated);
    activeRenewalConversationRuns.delete(args.renewal_conversation_run_id);
    return textResult({ status: args.decision, selected_cta: run.selectedCta, next_action: args.decision === "retry_later" ? "Retry this selected account later from a fresh CTA selection." : "This renewal account was skipped. You can select another account." });
  }
  if (name === "beta_record_renewal_conversation_approval") {
    pruneJourneyARuntimeState();
    const renewal = record.renewal_conversation;
    if (!renewal) throw new BetaError("RENEWAL_REVIEW_PACKAGE_REQUIRED", "Prepare the Renewal Conversation Brief before recording its review.");
    if (renewal.evidence_state === "native_fit_required") throw new BetaError("RENEWAL_NATIVE_PREFLIGHT_REQUIRED", "Complete the read-only native layout check before wording approval; no draft has been created.");
    if (renewal.evidence_state !== "review_ready") {
      throw new BetaError("RENEWAL_EVIDENCE_DECISION_REQUIRED", "Complete the renewal evidence run, or make the required per-account partial-evidence decision, before review.");
    }
    if (record.revision !== args.revision) throw new BetaError("STALE_CASE_REVISION", "The approval does not match the current renewal brief.");
    const activeReview = activeRenewalRunForCase({ caseId: record.case_id, testerId: runtime.testerId });
    if (!activeReview || activeReview[1].revision !== record.revision || !activeReview[1].deckContent) {
      throw new BetaError("RENEWAL_REVIEW_RUN_EXPIRED", "The reviewed renewal evidence is no longer in memory. Repeat the governed CTA and account reads before reviewing new wording; no approval was recorded.");
    }
    assertRenewalNativePreflight({ receipt: renewal.native_fit_receipt, inventory: activeReview[1].nativeFitInventory, caseRecord: record, ownerRef: runtime.testerId, deckContent: activeReview[1].deckContent });
    const completed = renewal.approvals || [];
    const expected = RENEWAL_CONVERSATION_REVIEW_GATES[completed.length];
    if (!expected) throw new BetaError("APPROVALS_COMPLETE", "The Renewal Conversation Brief review is complete.");
    if (args.gate !== expected) throw new BetaError("APPROVAL_ORDER_VIOLATION", `The next required renewal review gate is ${expected}.`);
    const updated = structuredClone(record);
    updated.renewal_conversation.approvals.push({
      gate: args.gate,
      revision: args.revision,
      note: args.note ? args.note.slice(0, 240) : null,
      approved_at: new Date().toISOString(),
    });
    updated.updated_at = new Date().toISOString();
    writeCase(updated);
    return textResult({ status: "in_review", revision: updated.revision, completed_gates: updated.renewal_conversation.approvals.map((item) => item.gate), next_gate: RENEWAL_CONVERSATION_REVIEW_GATES[updated.renewal_conversation.approvals.length] || "draft_authorization" });
  }
  if (name === "beta_render_renewal_conversation_brief") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    if (args.private_draft_authorized !== true) throw new BetaError("DRAFT_NOT_AUTHORIZED", "Private draft creation was not explicitly authorized.");
    const renewal = record.renewal_conversation;
    if (!renewal || record.revision !== args.revision) throw new BetaError("STALE_CASE_REVISION", "Prepare and review the current Renewal Conversation Brief before rendering.");
    const completed = new Set(renewal.approvals.map((approval) => approval.gate));
    const missing = RENEWAL_CONVERSATION_REVIEW_GATES.filter((gate) => !completed.has(gate));
    if (missing.length) throw new BetaError("REVIEW_INCOMPLETE", "Complete the lightweight renewal review before creating the private draft.", { missing });
    pruneJourneyARuntimeState();
    const found = [...activeRenewalConversationRuns.entries()].find(([, value]) => value.caseId === record.case_id && value.testerId === runtime.testerId && value.revision === record.revision);
    if (!found) throw new BetaError("RENEWAL_REVIEW_RUN_EXPIRED", "The reviewed renewal brief is no longer in memory. Prepare it again; no customer data was saved.");
    const [runId, run] = found;
    if (!run.evidence || run.state !== "review_ready") {
      throw new BetaError("RENEWAL_EVIDENCE_DECISION_REQUIRED", "The renewal evidence is not ready for rendering.");
    }
    if (!run.deckContent || renewal.deck_content_revision !== record.revision) {
      throw new BetaError("RENEWAL_CONTENT_SELECTION_REQUIRED", "Select and freeze the current customer wording before creating a private renewal draft.");
    }
    assertRenewalNativePreflight({ receipt: renewal.native_fit_receipt, inventory: run.nativeFitInventory, caseRecord: record, ownerRef: runtime.testerId, deckContent: run.deckContent });
    const deckContentDigest = crypto.createHash("sha256").update(JSON.stringify(run.deckContent.customer_slides)).digest("hex");
    if (renewal.deck_content_digest !== deckContentDigest) {
      throw new BetaError("RENEWAL_CONTENT_RECEIPT_MISMATCH", "The frozen renewal wording no longer matches the current review record. Select it again before rendering.");
    }
    const bridgeInput = {
      mode: "build",
      artifactKind: "renewal_conversation_brief",
      output: { provider: "google_slides", native: true, private_draft_only: true, folderId: null },
      designContract: RENEWAL_CONVERSATION_DESIGN_CONTRACT,
      templateBinding: activeRenewalTemplateBinding(),
      nativeFitReceipt: renewal.native_fit_receipt,
      reviewPackage: {
        customer_copy_contract: run.deckContent.customer_copy_contract,
        customer_slides: run.deckContent.customer_slides,
        private_speaker_notes: run.deckContent.private_speaker_notes,
      },
    };
    assertRenewalConversationRendererRequest({ rendererBaseline: RENEWAL_CONVERSATION_RENDERER_BASELINE, bridgeInput });
    const envelope = { schemaVersion: "1.0", packageVersion: runtime.manifest.package_version, rendererBaseline: RENEWAL_CONVERSATION_RENDERER_BASELINE, operatorRef: runtime.testerId, privateDraftAuthorized: true, releaseComponents: expectedReleaseComponents(), bridgeInput };
    if (runtime.limitedBetaRuntime?.renderer_mode === "manual_bound_script") {
      const updated = structuredClone(record);
      updated.renewal_conversation.evidence_state = "draft_action_pending";
      updated.renewal_conversation.draft_handoff_receipt = createRenewalDraftHandoff(updated);
      updated.updated_at = new Date().toISOString();
      writeCase(updated);
      run.state = "draft_action_pending";
      return textResult({
        status: "manual_action_required",
        renderer_mode: "manual_bound_script",
        next_action: { title: "Create the private renewal draft", instruction: "Open CSM Copilot > Open Renewal Brief Renderer in your private Renewal Conversation Brief template, paste the prepared request, and choose Create private draft." },
        manual_render_request: JSON.stringify(envelope),
        draft_receipt_ref: updated.renewal_conversation.draft_handoff_receipt.receipt_ref,
        revision: record.revision,
        completion_requires: ["private_draft_created_confirmed", "rendered_draft_reviewed"],
        customer_shared: false,
      });
    }
    const result = await invokeAppsScriptRenderer({ configPath: ownerRendererConfigPath, clientPath: ownerGoogleOAuthClientPath, tokenPath: ownerGoogleTokenPath, envelope });
    if (!result?.presentationId || result.privateDraft !== true) throw new BetaError("RENDERER_RESULT_INVALID", "The renewal renderer did not return a private draft.");
    const updated = structuredClone(record);
    updated.renewal_conversation.evidence_state = "draft_created";
    updated.renewal_conversation.draft_handoff_receipt = createRenewalDraftHandoff(updated);
    updated.updated_at = new Date().toISOString();
    writeCase(updated);
    activeRenewalConversationRuns.delete(runId);
    return textResult({ status: "draft_created", draft_receipt_ref: updated.renewal_conversation.draft_handoff_receipt.receipt_ref, revision: record.revision, private_draft: { presentation_id: result.presentationId, open_url: `https://docs.google.com/presentation/d/${encodeURIComponent(result.presentationId)}/edit`, customer_shared: false }, next_action: "Review the rendered private draft, then explicitly confirm creation and rendered review to complete this workflow." });
  }
  if (name === "beta_complete_renewal_conversation") {
    pruneJourneyARuntimeState();
    const { record: updated, alreadyCompleted } = completeRenewalConversationRecord(record, {
      runId: args.renewal_conversation_run_id, outcome: args.outcome, revision: args.revision,
      draftReceiptRef: args.draft_receipt_ref, createdConfirmed: args.private_draft_created_confirmed,
      reviewed: args.rendered_draft_reviewed,
    });
    if (!alreadyCompleted) writeCase(updated);
    activeRenewalConversationRuns.delete(args.renewal_conversation_run_id);
    return textResult({
      status: args.outcome,
      already_completed: alreadyCompleted,
      completion_basis: updated.renewal_conversation.completion_basis,
      next_action: "This renewal account is closed. You can select one other renewal CTA when you are ready.",
    });
  }
  if (name === "beta_continue_journey_a_contact_evidence") {
    pruneJourneyARuntimeState();
    let evidenceRun = activeJourneyAContactEvidenceRuns.get(args.contact_evidence_run_id);
    if (!evidenceRun || evidenceRun.caseId !== record.case_id || evidenceRun.testerId !== runtime.testerId) {
      throw new BetaError("CONTACT_EVIDENCE_RUN_EXPIRED", "The contact-evidence run is unavailable. Start it again from a fresh account selection.");
    }
    if (!evidenceRun.fastEvidence) {
      let fastEvidence;
      try {
        fastEvidence = await readFastJourneyAContactEvidenceWithSession({
          accountId: evidenceRun.accountId,
          coreEvidence: evidenceRun.coreEvidence,
          session: journeyASnowflakeSession(record.case_id, readJson(sourceConnectionPolicyPath).snowflake.connection_name),
        });
      } catch (error) {
        activeJourneyAContactEvidenceRuns.delete(args.contact_evidence_run_id);
        closeJourneyASnowflakeSession(record.case_id);
        throw error;
      }
      const startedRun = {
        ...evidenceRun,
        fastEvidence,
        slowEvidenceState: "in_progress",
        slowEvidenceStartedAt: Date.now(),
        slowEvidenceStageStartedAt: Date.now(),
        slowEvidenceSourceStartedAt: Date.now(),
      };
      activeJourneyAContactEvidenceRuns.set(args.contact_evidence_run_id, startedRun);
      // These reads refine the account brief, but cannot suppress the contact
      // shortlist already grounded in the current contact snapshot.
      startedRun.slowEvidencePromise = readSlowJourneyAContactEvidenceWithSession({
        accountId: startedRun.accountId,
        coreEvidence: startedRun.coreEvidence,
        fastEvidence,
        session: journeyASnowflakeSession(record.case_id, readJson(sourceConnectionPolicyPath).snowflake.connection_name),
        onContactDetails: resolved => {
          if (activeJourneyAContactEvidenceRuns.get(args.contact_evidence_run_id) !== startedRun) return;
          startedRun.coreEvidence = resolved;
          startedRun.fastEvidence = mergeFastContactDetails(startedRun.fastEvidence, resolved);
        },
        onProgress: progress => {
          if (activeJourneyAContactEvidenceRuns.get(args.contact_evidence_run_id) !== startedRun) return;
          if (startedRun.sourceProgress?.stage !== progress.stage) startedRun.slowEvidenceStageStartedAt = Date.now();
          startedRun.slowEvidenceSourceStartedAt = Date.now();
          startedRun.sourceProgress = progress;
        },
      }).then((slowEvidence) => {
        const active = activeJourneyAContactEvidenceRuns.get(args.contact_evidence_run_id);
        if (active === startedRun) {
          active.slowEvidence = slowEvidence;
          active.slowEvidenceState = "ready";
          active.brief = slowEvidence.brief;
          active.contacts = slowEvidence.contacts;
          active.sourceStates = slowEvidence.source_states;
          active.sourceGapCodes = slowEvidence.source_gap_codes;
          active.sourceDurationsMs = slowEvidence.source_durations_ms;
          active.sourceDiagnostics = slowEvidence.source_diagnostics;
          active.gongLookbackDays = slowEvidence.gong_lookback_days;
        }
      }).catch(error => {
        const active = activeJourneyAContactEvidenceRuns.get(args.contact_evidence_run_id);
        if (active === startedRun) {
          active.slowEvidenceState = "unavailable";
          active.slowEvidenceErrorCode = /^CONTACT_DETAIL_[A-Z_]+$/.test(error?.code || "") ? error.code : "ACCOUNT_CONTEXT_UNAVAILABLE";
          const failed = composeShortlistEvidence({ coreEvidence: active.coreEvidence, fastEvidence: active.fastEvidence, secondarySourceState: "unavailable" });
          active.coreEvidence = { ...active.coreEvidence, contacts: failed.contacts, source_gap_codes: failed.source_gap_codes,
            source_states: { ...active.coreEvidence.source_states, salesforce_identity: failed.source_states.salesforce_identity,
              ...(failed.source_states.contact_details ? { contact_details: failed.source_states.contact_details } : {}) } };
          active.fastEvidence = { ...active.fastEvidence, contacts: failed.contacts,
            brief: { ...active.fastEvidence.brief, source_states: { ...active.fastEvidence.brief.source_states,
              salesforce_contact_identity: failed.source_states.salesforce_identity } },
            source_states: { ...active.fastEvidence.source_states, salesforce_identity: failed.source_states.salesforce_identity,
              ...(failed.source_states.contact_details ? { contact_details: failed.source_states.contact_details } : {}) },
          };
        }
      });
      const recommendations = recommendContacts(evidenceRun.coreEvidence.contacts, fastEvidence.source_states);
      return textResult({
        status: contactReadStatus(recommendations, fastEvidence.source_states, "brief_and_contacts_ready"),
        contact_evidence_run_id: args.contact_evidence_run_id,
        source_states: fastEvidence.source_states,
        source_gap_codes: fastEvidence.source_gap_codes,
        source_durations_ms: fastEvidence.source_durations_ms,
        brief: fastEvidence.brief,
        ...publicContactRecommendations(recommendations),
        outreach_pack: buildOutreachPack({
          brief: fastEvidence.brief,
          contacts: recommendations.prioritized_contacts,
          sourceStates: fastEvidence.source_states,
          sourceGaps: fastEvidence.source_gap_codes,
          status: contactReadStatus(recommendations, fastEvidence.source_states, "brief_and_contacts_ready"),
        }),
        source_progress: outreachEvidenceProgress(startedRun),
        relationship_context_state: "managed_internally",
        user_notice: recommendations.contacts.length
          ? "The account brief and measured support trends are ready with the suggested contacts. Optional relationship context does not block this result."
          : recommendations.prioritized_contacts.length
            ? "Measured support trends and contact priorities are available. Current contact details are being verified; no recipient is ready yet."
            : "The measured support trends are available. No contact is recommended; review the rejection reasons while the supporting reads continue.",
        next_action: recommendations.contacts.length
          ? "Show the account brief and suggested contacts together."
          : recommendations.prioritized_contacts.length
            ? "Show the account brief and prioritized_contacts together. Continue this managed lookup every 20 seconds and report source_progress."
            : "Show the account brief and contact rejection reasons together; no recipient is currently recommended.",
      });
    }
    if (evidenceRun.slowEvidenceState === "in_progress") {
      const recommendations = recommendContacts(evidenceRun.coreEvidence.contacts, evidenceRun.fastEvidence.source_states);
      return textResult({
        status: evidenceRun.coreEvidence.source_states.contact_details && evidenceRun.coreEvidence.source_states.contact_details !== "checked"
          ? "contact_details_pending" : "relationship_context_pending",
        contact_evidence_run_id: args.contact_evidence_run_id,
        source_states: evidenceRun.fastEvidence.source_states,
        source_gap_codes: evidenceRun.fastEvidence.source_gap_codes,
        source_durations_ms: evidenceRun.fastEvidence.source_durations_ms,
        brief: evidenceRun.fastEvidence.brief,
        candidate_count: evidenceRun.coreEvidence.contacts.length,
        ...publicContactRecommendations(recommendations),
        source_progress: outreachEvidenceProgress(evidenceRun),
        next_check_after_seconds: 20,
        relationship_context_state: "managed_internally",
        next_action: recommendations.contacts.length
          ? "Keep the ranked shortlist and measured metrics visible. Continue this same read in about 20 seconds and report source_progress; do not start another read."
          : recommendations.prioritized_contacts.length
            ? "Keep prioritized_contacts and the measured metrics visible. Continue this same lookup in about 20 seconds and report source_progress; unavailable email must not be described as no contact."
            : "Keep the measured metrics and contact rejection reasons visible. Continue this same supporting read in about 20 seconds; no contact is currently recommended.",
      });
    }
    if (evidenceRun.slowEvidenceState === "unavailable" || !evidenceRun.slowEvidence) {
      const recommendations = recommendContacts(evidenceRun.coreEvidence.contacts, evidenceRun.fastEvidence.source_states);
      return textResult({
        status: "relationship_context_unavailable",
        contact_evidence_run_id: args.contact_evidence_run_id,
        candidate_count: evidenceRun.coreEvidence.contacts.length,
        ...publicContactRecommendations(recommendations),
        source_states: evidenceRun.fastEvidence.source_states,
        source_gap_codes: [
          ...(evidenceRun.fastEvidence.source_gap_codes || []),
          "ACCOUNT_CONTEXT_UNAVAILABLE",
          "SALESFORCE_ACTIVITY_UNAVAILABLE",
          "GONG_METADATA_UNAVAILABLE",
          ...(evidenceRun.slowEvidenceErrorCode ? [evidenceRun.slowEvidenceErrorCode] : []),
        ],
        source_durations_ms: evidenceRun.fastEvidence.source_durations_ms,
        brief: evidenceRun.fastEvidence.brief,
        relationship_context_state: "unavailable",
        next_action: recommendations.contacts.length
          ? "Show the ranked shortlist and preserved metrics with the supporting source gaps. Do not start a new account selection."
          : recommendations.prioritized_contacts.length
            ? "Show the preserved metrics and contact priorities with the lookup gap. No verified recipient is available; do not guess an email or select a different account."
            : "Show the preserved metrics, contact rejection reasons and supporting source gaps. No contact is recommended from the returned records.",
      });
    }
    const evidence = evidenceRun.slowEvidence;
    if (evidence.identity_available === false) {
      return textResult({
        status: "contact_identity_incomplete",
        contact_evidence_run_id: args.contact_evidence_run_id,
        source_states: evidence.source_states,
        source_gap_codes: evidence.source_gap_codes,
        source_durations_ms: evidence.source_durations_ms,
        brief: evidence.brief,
        next_action: "Keep the account brief visible. Contact identity is still unavailable, so no contact is suggested and no absence is inferred.",
      });
    }
    if (evidence.contacts.length === 0) {
      activeJourneyAContactEvidenceRuns.delete(args.contact_evidence_run_id);
      closeJourneyASnowflakeSession(record.case_id);
      return textResult({
        status: "no_contact_candidates",
        source_states: evidence.source_states,
        source_gap_codes: evidence.source_gap_codes,
        source_durations_ms: evidence.source_durations_ms,
        brief: evidence.brief,
        candidate_count: 0,
        next_action: "This account read returned no contact records. No contact can be suggested from this result; it does not establish that the customer has no contacts.",
      });
    }
    const completedRun = {
      ...evidenceRun,
      brief: evidence.brief,
      contacts: evidence.contacts,
      sourceStates: evidence.source_states,
      sourceGapCodes: evidence.source_gap_codes,
      sourceDurationsMs: evidence.source_durations_ms,
      gongLookbackDays: evidence.gong_lookback_days,
    };
    activeJourneyAContactEvidenceRuns.set(args.contact_evidence_run_id, completedRun);
    const recommendations = recommendContacts(evidence.contacts, evidence.source_states);
    const hasSourceGaps = evidence.source_gap_codes.length > 0;
    return textResult({
      status: contactReadStatus(recommendations, evidence.source_states, "brief_and_contacts_ready"),
      contact_evidence_run_id: args.contact_evidence_run_id,
      candidate_count: evidence.contacts.length,
      brief: evidence.brief,
      ...publicContactRecommendations(recommendations),
      outreach_pack: buildOutreachPack({ brief: evidence.brief, contacts: recommendations.prioritized_contacts,
        sourceStates: evidence.source_states, sourceGaps: evidence.source_gap_codes,
        status: contactReadStatus(recommendations, evidence.source_states, "brief_and_contacts_ready") }),
      source_states: evidence.source_states,
      source_gap_codes: evidence.source_gap_codes,
      source_durations_ms: evidence.source_durations_ms,
      source_diagnostics: evidence.source_diagnostics,
      gong_lookback_days: evidence.gong_lookback_days,
      relationship_context_state: hasSourceGaps ? "completed_with_gaps" : "completed",
      completion_request: { tool: "beta_complete_journey_a_contact_evidence", arguments: {
        case_id: record.case_id, contact_evidence_run_id: args.contact_evidence_run_id,
        gmail_metadata_state: "not_requested", gmail_metadata_message_count: 0,
      } },
      source_elapsed_ms: Date.now() - evidenceRun.slowEvidenceStartedAt,
      user_notice: recommendations.contacts.length
        ? "The supporting reads have finished. Review the account brief, suggested contacts and any source gaps."
        : recommendations.message,
      next_action: recommendations.contacts.length
        ? "Show the account brief, suggested contacts and source gaps. Execute completion_request to attach this evidence without approval or another source read, then review the account before preparing an email. If Gmail metadata was actually checked, record its true state instead of the unrequested default."
        : recommendations.prioritized_contacts.length
          ? "Show the contact priorities and their unresolved detail states with the account brief. Only a verified recipient can proceed to outreach approval."
          : "Show the available account evidence and contact rejection reasons. A usable, reviewed contact is required before an outreach draft can proceed.",
    });
  }
  if (name === "beta_complete_journey_a_contact_evidence") {
    pruneJourneyARuntimeState();
    const evidence = activeJourneyAContactEvidenceRuns.get(args.contact_evidence_run_id);
    if (!evidence || evidence.caseId !== record.case_id || evidence.testerId !== runtime.testerId) {
      throw new BetaError("CONTACT_EVIDENCE_RUN_EXPIRED", "The contact-evidence run is unavailable. Start it again from a fresh owned CTA selection.");
    }
    if (record.journey_state?.account_ref_digest && record.journey_state.account_ref_digest !== evidence.accountRefDigest) {
      activeJourneyAContactEvidenceRuns.delete(args.contact_evidence_run_id);
      closeJourneyASnowflakeSession(record.case_id);
      throw new BetaError("CROSS_JOURNEY_ACCOUNT_MISMATCH", "The completed contact evidence does not match the account already bound to this case.");
    }
    if (evidence.slowEvidenceState === "in_progress" && evidence.coreEvidence.source_states.contact_details
      && evidence.coreEvidence.source_states.contact_details !== "checked") {
      throw new BetaError("CONTACT_DETAILS_PENDING", "The same-contact lookup is still running. Continue this managed read before completing contact verification.");
    }
    assertPerformanceMetricsSettled(record.case_id);
    // MCP tools cannot push a later chat message when an in-memory background
    // read finishes. Once Salesforce identity and Gmail metadata are checked,
    // return the established hierarchy-based shortlist immediately. Slower
    // Salesforce activity and Gong reads are explicit source gaps, not a gate.
    const shortlistEvidence = evidence.slowEvidence && evidence.sourceStates
      ? {
        brief: evidence.brief,
        contacts: evidence.contacts,
        sourceStates: evidence.sourceStates,
        sourceGapCodes: evidence.sourceGapCodes,
        sourceDurationsMs: evidence.sourceDurationsMs,
        gongLookbackDays: evidence.gongLookbackDays,
      }
      : (() => {
        const provisional = composeShortlistEvidence({
          coreEvidence: evidence.coreEvidence,
          fastEvidence: evidence.fastEvidence,
          // The response is final. MCP background work cannot add a later
          // message, so unresolved supporting reads must be a visible source
          // gap, not a permanent "pending" state that blocks contacts.
          secondarySourceState: "unavailable",
        });
        return {
          brief: provisional.brief,
          contacts: provisional.contacts,
          sourceStates: provisional.source_states,
          sourceGapCodes: provisional.source_gap_codes,
          sourceDurationsMs: provisional.source_durations_ms,
          gongLookbackDays: provisional.gong_lookback_days,
        };
      })();
    const gmailSourceGaps = [...new Set(args.source_gap_codes || [])];
    if (!["checked", "not_requested"].includes(args.gmail_metadata_state) && gmailSourceGaps.length === 0) {
      throw new BetaError("GMAIL_SOURCE_GAP_REQUIRED", "If Gmail metadata is unavailable or timed out, include its visible source-gap code.");
    }
    if (args.gmail_metadata_state === "not_requested" && (args.gmail_metadata_message_count !== 0 || gmailSourceGaps.length)) {
      throw new BetaError("GMAIL_METADATA_NOT_REQUESTED", "An unrequested Gmail read has no message count or failure. Do not record it as a checked or failed source.");
    }
    const sourceGaps = [...new Set([...(shortlistEvidence.sourceGapCodes || []), ...gmailSourceGaps])];
    const recommendations = recommendContacts(shortlistEvidence.contacts, shortlistEvidence.sourceStates);
    let updated = recordJourneyAContactVerification(record, {
      accountRefDigest: evidence.accountRefDigest,
      salesforceIdentityState: shortlistEvidence.sourceStates.salesforce_identity,
      contactSnapshotState: shortlistEvidence.sourceStates.contact_snapshot || "checked",
      salesforceActivityState: shortlistEvidence.sourceStates.salesforce_activity,
      gmailMetadataState: args.gmail_metadata_state,
      gongMetadataState: shortlistEvidence.sourceStates.gong_metadata,
      gongLookbackDays: shortlistEvidence.gongLookbackDays,
      candidateCount: shortlistEvidence.contacts.length,
      eligibleContactCount: recommendations.eligible_contact_count,
      sourceGaps,
      testerId: runtime.testerId,
    });
    updated.journey_state.contexts.journey_a.contact_verification.completed_evidence_digest = crypto.createHash("sha256")
      .update(args.contact_evidence_run_id).digest("hex");
    updated = bindNativeOutreachEvidence(updated, {
      accountRefDigest: evidence.accountRefDigest, evidenceRunRef: args.contact_evidence_run_id,
      workItemRef: evidence.workItemRef, brief: shortlistEvidence.brief, contacts: shortlistEvidence.contacts,
      sourceStates: { ...shortlistEvidence.sourceStates, gmail_metadata: args.gmail_metadata_state }, sourceGaps,
      testerId: runtime.testerId,
    });
    activeOutreachRecipientHandoffs.retain({ caseId: record.case_id, ownerRef: runtime.testerId,
      accountRefDigest: evidence.accountRefDigest, evidenceRunRef: args.contact_evidence_run_id,
      expiresAt: evidence.expiresAt, contacts: shortlistEvidence.contacts, emails: evidence.coreEvidence.runtimeContactEmails });
    activeJourneyAContactEvidenceRuns.delete(args.contact_evidence_run_id);
    closeJourneyASnowflakeSession(record.case_id);
    writeCase(updated);
    return textResult({
      ...publicCaseStatus(updated),
      workflow: publicJourneyStatus(updated),
      source_gap_codes: sourceGaps,
      source_states: {
        ...shortlistEvidence.sourceStates,
        gmail_metadata: args.gmail_metadata_state,
      },
      source_durations_ms: shortlistEvidence.sourceDurationsMs,
      gmail_metadata_message_count: args.gmail_metadata_message_count,
      brief: shortlistEvidence.brief,
      ...publicContactRecommendations(recommendations),
      outreach_pack: buildOutreachPack({
        brief: shortlistEvidence.brief,
        contacts: recommendations.prioritized_contacts,
        sourceStates: { ...shortlistEvidence.sourceStates, gmail_metadata: args.gmail_metadata_state },
        sourceGaps,
        status: contactReadStatus(recommendations, shortlistEvidence.sourceStates, "ready_for_contact_selection"),
      }),
      next_action: recommendations.state === "ranked" || recommendations.state === "ranked_with_source_gaps"
        ? "Review the account brief and recommended contacts together. Each recommendation includes its evidence and rationale."
        : recommendations.prioritized_contacts.length
          ? "Review the contact priorities and the detail-lookup gaps. The contacts remain visible, but no verified recipient is available for a draft."
          : "Review the account brief and contact rejection reasons. No eligible named contact with a usable email address was returned, so no recipient is recommended from these records.",
    });
  }
  if (name === "beta_case_journey_status" || name === "beta_workflow_status") return textResult(publicJourneyStatus(record));
  if (name === "beta_start_journey") {
    const updated = startJourney(record, {
      journey: args.journey,
      abandonCustomerPlanning: args.abandon_customer_planning,
      testerId: runtime.testerId,
    });
    writeCase(updated);
    return textResult({ ...publicCaseStatus(updated), workflow: publicJourneyStatus(updated) });
  }
  if (name === "beta_bind_journey_context") {
    if (record.case_kind === "real_authorized") {
      validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    }
    const updated = bindJourneyContext(record, {
      journey: args.journey,
      contextDigest: args.context_digest,
      accountRefDigest: args.account_ref_digest,
      contextVersion: args.context_version,
      itemCount: args.item_count,
      warningCodes: args.warning_codes || [],
      testerId: runtime.testerId,
    });
    writeCase(updated);
    return textResult({ ...publicCaseStatus(updated), workflow: publicJourneyStatus(updated) });
  }
  if (name === "beta_record_orchestration_run") {
    const updated = recordOrchestrationRun(record, {
      journey: args.journey, accountRefDigest: args.account_ref_digest, durationMs: args.duration_ms,
      sourceGaps: args.source_gap_codes || [], testerId: runtime.testerId,
    });
    writeCase(updated);
    return textResult({ ...publicCaseStatus(updated), workflow: publicJourneyStatus(updated) });
  }
  if (name === "beta_record_journey_a_approval") {
    if (args.renewal_source_mode && args.gate !== "template_preview") throw new BetaError("RENEWAL_SOURCE_DECISION_GATE_REQUIRED", "Record the explicit sequence/evidence-only choice at template review, without skipping prior approvals.");
    const sourceMode = args.renewal_source_mode || record.renewal_source_mode;
    if (sourceMode === "current_sequence" && !record.renewal_source_receipt) throw new BetaError("RENEWAL_SEQUENCE_COPY_REQUIRED", "Read the current approved guide before approving sequence-based wording.");
    if (record.renewal_source_receipt && sourceMode !== "evidence_only" && ["template_preview", "outreach_draft"].includes(args.gate)) activeNativeRenewalSources.assertReceipt(record, runtime.testerId);
    const updated = approveJourneyAGate(record, {
      gate: args.gate,
      revision: args.revision,
      testerId: runtime.testerId,
      note: args.note,
    });
    if (record.case_kind === "real_authorized_journey_a" && ["contact_selection", "template_preview", "outreach_draft"].includes(args.gate)) {
      activeOutreachRecipientHandoffs.assert(record, { ownerRef: runtime.testerId, revision: args.revision,
        recipientRef: record.outreach_identity_receipt?.receipt_ref, toDigest: record.outreach_identity_receipt?.address_digest });
    }
    if (args.renewal_source_mode) updated.renewal_source_mode = args.renewal_source_mode;
    writeCase(updated);
    return textResult({ ...publicCaseStatus(updated), workflow: publicJourneyStatus(updated) });
  }
  if (name === "beta_read_verified_contact_email") {
    if (Object.keys(args).some(key => !["case_id", "revision", "contact_evidence_run_id", "contact_ref", "explicit_email_request"].includes(key))) {
      throw new BetaError("INVALID_INPUT", "Use only the current case, revision, completed evidence and contact reference. Caller-supplied addresses are not accepted.");
    }
    if (typeof args.contact_ref !== "string" || !/^[a-f0-9]{64}$/.test(args.contact_ref)) {
      throw new BetaError("INVALID_OUTREACH_RECIPIENT_REFERENCE", "Copy the complete contact reference from the same verified shortlist; do not restart its source read.");
    }
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    if (record.case_kind !== "real_authorized_journey_a") throw new BetaError("INVALID_CASE_KIND", "Read the selected account's native contact evidence first.");
    return textResult(activeOutreachRecipientHandoffs.readContactEmail(record, {
      ownerRef: runtime.testerId, revision: args.revision, evidenceRunRef: args.contact_evidence_run_id,
      contactRef: args.contact_ref, explicitEmailRequest: args.explicit_email_request,
    }));
  }
  if (name === "beta_get_verified_outreach_recipient") {
    if (Object.keys(args).some(key => !["case_id", "revision", "contact_evidence_run_id", "contact_ref", "contact_refs"].includes(key))) {
      throw new BetaError("INVALID_INPUT", "Use only the current case, revision, evidence run and selected contact references. Caller-supplied addresses are not accepted.");
    }
    const references = args.contact_refs === undefined ? (args.contact_ref === undefined ? [] : [args.contact_ref]) : args.contact_refs;
    if (Array.isArray(references) && references.some(ref => typeof ref !== "string" || !/^[a-f0-9]{64}$/.test(ref))) {
      throw new BetaError("INVALID_OUTREACH_RECIPIENT_REFERENCE", "Copy every complete contact_ref exactly from the existing verified contact shortlist; never shorten or reconstruct it. The current selection is unchanged. Correct this request from that shortlist; do not restart the case or contact read.");
    }
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    if (record.case_kind !== "real_authorized_journey_a") throw new BetaError("INVALID_CASE_KIND", "Select a contact from the native outreach account read first.");
    assertPerformanceMetricsSettled(record.case_id);
    const selected = activeOutreachRecipientHandoffs.select(record, { ownerRef: runtime.testerId, revision: args.revision,
      evidenceRunRef: args.contact_evidence_run_id, contactRef: args.contact_ref, contactRefs: args.contact_refs });
    writeCase(selected.record);
    return textResult(selected.handoff);
  }
  if (name === "beta_bind_outreach_draft_review") {
    if (record.renewal_source_receipt && record.renewal_source_mode !== "evidence_only") activeNativeRenewalSources.assertReceipt(record, runtime.testerId);
    if (record.case_kind === "real_authorized_journey_a") {
      activeOutreachRecipientHandoffs.assert(record, { ownerRef: runtime.testerId, revision: args.revision,
        recipientRef: args.recipient_ref, toDigest: args.to_digest });
    }
    const updated=bindOutreachDraftReview(record,{testerId:runtime.testerId,revision:args.revision,contentDigest:args.content_digest});
    if (record.case_kind === "real_authorized_journey_a") activeOutreachRecipientHandoffs.advanceReview(record, updated, { ownerRef: runtime.testerId });
    writeCase(updated);
    return textResult({status:"review_ready",revision:updated.revision,next_action:"Show this exact email and record its explicit outreach-draft approval. No Gmail draft was created."});
  }
  if (name === "beta_claim_outreach_draft") {
    validateRealBetaRuntime({credentialState:runtime.limitedBetaRuntime,manifest:runtime.manifest});
    assertPerformanceMetricsSettled(record.case_id);
    if (record.renewal_source_receipt && record.renewal_source_mode !== "evidence_only" && (!record.outreach_delivery || record.outreach_delivery.state === "review_ready")) activeNativeRenewalSources.assertReceipt(record, runtime.testerId);
    if (record.case_kind === "real_authorized_journey_a" && (!record.outreach_delivery || record.outreach_delivery.state === "review_ready")) {
      activeOutreachRecipientHandoffs.assert(record, { ownerRef: runtime.testerId, revision: args.revision,
        recipientRef: args.recipient_ref, toDigest: args.to_digest });
    }
    const claimed=claimOutreachDraft(record,{testerId:runtime.testerId,revision:args.revision,contentDigest:args.content_digest,privateDraftAuthorized:args.private_draft_authorized});
    writeCase(claimed.record); // persist the lease before the external action
    return textResult(claimed.delivery);
  }
  if (name === "beta_complete_outreach_draft") {
    const updated=completeOutreachDraft(record,{testerId:runtime.testerId,revision:args.revision,requestRef:args.draft_request_ref,providerDraftCreated:args.provider_draft_created});
    writeCase(updated);
    // Other individually reviewed contacts may still need their own email. The
    // original source timer clears all cached addresses at its unchanged expiry.
    return textResult({status:updated.outreach_delivery.state,unsent_only:true,next_action:updated.outreach_delivery.state==="draft_created"?"The provider confirmed an unsent draft; nothing was sent.":"Check the existing Gmail result before another create. Do not automatically retry."});
  }
  if (name === "beta_record_journey_a_contact_verification") {
    throw new BetaError("CONTACT_EVIDENCE_RUN_REQUIRED", "Contact verification is automatic. Run the selected-account contact-evidence operation; do not record source states manually.");
  }
  if (name === "beta_handoff_journey") {
    const updated = handoffJourney(record, {
      fromJourney: args.from_journey,
      toJourney: args.to_journey,
      reason: args.reason,
      abandonCustomerPlanning: args.abandon_customer_planning,
      revision: args.revision,
      testerId: runtime.testerId,
    });
    writeCase(updated);
    return textResult({ ...publicCaseStatus(updated), workflow: publicJourneyStatus(updated) });
  }
  if (name === "beta_bind_recommendation_review_package") {
    const refs = record.account_ref_digest ? recommendationRefs(args.recommendation_refs) : args.recommendation_refs || null;
    const updated = bindRecommendationReviewPackage(record, {
      reviewPackageDigest: args.review_package_digest,
      sections: args.sections,
      recommendationRefs: refs,
      revision: args.revision,
      testerId: runtime.testerId,
    });
    writeCase(updated);
    return textResult(publicCaseStatus(updated));
  }
  if (name === "beta_bind_derived_evidence") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    if (record.account_ref_digest) {
      throw new BetaError("SELECTED_CALL_EVIDENCE_RUN_REQUIRED", "Use the selected-call evidence read. A host-supplied digest cannot stand in for transcript findings.");
    }
    const updated = bindDerivedEvidence(record, {
      digest: args.evidence_digest,
      findingCount: args.finding_count,
      warningCodes: args.warning_codes || [],
      testerId: runtime.testerId,
    });
    writeCase(updated);
    return textResult(publicCaseStatus(updated));
  }
  if (name === "beta_bind_private_artifact") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const updated = bindPrivateArtifact(record, {
      artifactRefDigest: args.artifact_ref_digest,
      auditRefDigest: args.audit_ref_digest,
      testerId: runtime.testerId,
    });
    writeCase(updated);
    return textResult(publicCaseStatus(updated));
  }
  if (name === "beta_render_private_draft") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    if (record.account_ref_digest && (!record.account_intelligence_core || !record.derived_evidence || !record.recommendation_review_package)) {
      throw new BetaError("MEETING_PREP_EVIDENCE_INCOMPLETE", "The account brief, selected-call findings, and recommendation review must all be bound before preparing a private deck.");
    }
    if (args.private_draft_authorized !== true) throw new BetaError("DRAFT_NOT_AUTHORIZED", "Private draft creation was not explicitly authorized.");
    if (record.revision !== args.revision) throw new BetaError("STALE_CASE_REVISION", "The authorized case revision changed.");
    const approved = new Set((record.approvals || []).filter((item) => item.revision === record.revision).map((item) => item.gate));
    const requiredBeforeRender = ["identity", "evidence", "recommendations", "customer_content", "maintained_slides"];
    const missing = requiredBeforeRender.filter((gate) => !approved.has(gate));
    if (missing.length) throw new BetaError("REVIEW_INCOMPLETE", "Complete the pre-render approval gates first.", { missing });
    const profileStatus = readPresenterProfile(ownerPresenterProfilePath);
    if (profileStatus.status !== "ready") throw new BetaError("PRESENTER_PROFILE_REQUIRED", profileStatus.next_action.title, profileStatus.next_action);
    if (record.account_ref_digest && (record.private_draft_authorization?.revision !== record.revision
      || record.private_draft_authorization?.draft_review_digest !== record.draft_review?.digest)) {
      record.private_draft_authorization = { revision: record.revision, draft_review_digest: record.draft_review?.digest,
        authorized_at: new Date().toISOString() };
    }
    const bridgeInput = record.account_ref_digest
      ? bindMeetingPrepDraftInput(record, assembleApprovedMeetingPrepInput(record, args.bridge_input))
      : structuredClone(args.bridge_input);
    bridgeInput.presenterProfile = presenterProfileForRenderer(profileStatus.profile);
    bridgeInput.mode = "build";
    bridgeInput.output = { ...(bridgeInput.output || {}), folderId: null };
    if (!fs.existsSync(ownerApprovedRecoveryDesignPath)) {
      throw new BetaError("APPROVED_DESIGN_CONTRACT_REQUIRED", "The approved Customer Planning and Meeting Prep design has not been recorded for this private beta installation.");
    }
    const suppliedBinding = bridgeInput.templateBinding;
    if (suppliedBinding && (suppliedBinding.presentationId || suppliedBinding.slides || suppliedBinding.roles)) {
      throw new BetaError(
        "RAW_TEMPLATE_BINDING_REJECTED",
        "The private renderer captures the approved master locally. Do not supply a source deck binding, slide IDs, or semantic-field map.",
      );
    }
    const approvedDesign = validateApprovedRecoveryDesignContract(readJson(ownerApprovedRecoveryDesignPath));
    bridgeInput.templateBinding = {
      bindingMode: "capture_active_private_master",
      recoveryFamily: DESIGN_FAMILY,
      strictFieldCoverage: true,
      approvedDesignContract: approvedDesign,
    };
    assertReferenceLockedRendererRequest({
      rendererBaseline: runtime.manifest.renderer_baseline,
      bridgeInput,
    });
    if (record.account_ref_digest) {
      writeCase(record);
    }
    const envelope = {
      schemaVersion: bridgeInput.phaseSlidePlan ? "1.1" : "1.0",
      ...(bridgeInput.phaseSlidePlan ? { requiredRendererContract: "phase-story-v2" } : {}),
      packageVersion: runtime.manifest.package_version,
      rendererBaseline: runtime.manifest.renderer_baseline,
      operatorRef: runtime.testerId,
      privateDraftAuthorized: true,
      releaseComponents: expectedReleaseComponents(),
      bridgeInput,
    };
    if (runtime.limitedBetaRuntime?.renderer_mode === "manual_bound_script") {
      return textResult({
        ...publicCaseStatus(record),
        status: "manual_action_required",
        renderer_mode: "manual_bound_script",
        next_action: {
          title: "Create the private draft",
          instruction: "Open CSM Copilot > Open private renderer in your private master deck, paste the prepared request below, and choose Create private draft.",
        },
        manual_render_request: JSON.stringify(envelope),
        render_request_digest: crypto.createHash("sha256").update(JSON.stringify(envelope)).digest("hex"),
        delivery_status: "not_delivered",
        customer_shared: false,
      });
    }
    const result = await invokeAppsScriptRenderer({
      configPath: ownerRendererConfigPath,
      clientPath: ownerGoogleOAuthClientPath,
      tokenPath: ownerGoogleTokenPath,
      envelope,
    });
    if (!result?.presentationId || result.privateDraft !== true) throw new BetaError("RENDERER_RESULT_INVALID", "The renderer did not return a private draft.");
    const updated = bindPrivateArtifact(record, {
      artifactRefDigest: crypto.createHash("sha256").update(result.presentationId).digest("hex"),
      auditRefDigest: crypto.createHash("sha256").update(String(result.auditRef || result.presentationId)).digest("hex"),
      testerId: runtime.testerId,
    });
    writeCase(updated);
    return textResult({
      ...publicCaseStatus(updated),
      private_draft: {
        presentation_id: result.presentationId,
        open_url: `https://docs.google.com/presentation/d/${encodeURIComponent(result.presentationId)}/edit`,
        customer_shared: false,
      },
    });
  }
  if (name === "beta_reopen_meeting_prep_recommendation_review") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    const updated = reopenMeetingPrepRecommendationReview(record, { testerId: runtime.testerId, revision: args.revision,
      requested: args.revision_requested_by_csm });
    writeCase(updated);
    return textResult({ status: "recommendation_review_required", case_status: publicCaseStatus(updated),
      next_action: "Show and bind the full revised recommendation package, then review the new exact customer copy and slide selections. Existing evidence remains bound; no transcript reread or draft creation occurred." });
  }
  if (name === "beta_bind_meeting_prep_master_preflight") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    if (record.transcript_eligibility?.provider !== "Converge") throw new BetaError("CONVERGE_SELECTION_REQUIRED", "Select a call through Converge before verifying the meeting-prep master.");
    if (record.revision !== args.revision) throw new BetaError("STALE_CASE_REVISION", "Use the current case revision for the master preflight.");
    const receipt = validateMeetingPrepMasterPreflight(args.master_inventory);
    const updated = { ...record, renderer_preflight: { ...receipt, revision: record.revision } };
    writeCase(updated);
    return textResult({ status: "renderer_verified", case_id: record.case_id, revision: record.revision,
      inventory_digest: receipt.inventory_digest, renderer_components: receipt.renderer_components,
      next_action: "Use this exact captured inventory for slide wording and fit review. This did not approve wording or create a draft." });
  }
  if (name === "beta_prepare_meeting_prep_draft_review") {
    validateRealBetaRuntime({ credentialState: runtime.limitedBetaRuntime, manifest: runtime.manifest });
    if (record.revision !== args.revision) throw new BetaError("STALE_CASE_REVISION", "The case revision changed; use its current evidence and review state.");
    if (!record.renderer_preflight || record.renderer_preflight.revision !== record.revision) {
      throw new BetaError("MEETING_PREP_MASTER_PREFLIGHT_REQUIRED", "Capture and bind the current approved v3 master's read-only inventory and exact renderer receipt before reviewing slide wording.");
    }
    const currentPreflight = validateMeetingPrepMasterPreflight(args.master_inventory);
    if (currentPreflight.inventory_digest !== record.renderer_preflight.inventory_digest) {
      throw new BetaError("MEETING_PREP_MASTER_INVENTORY_CHANGED", "The master inventory changed since case preflight. Capture and bind it again before wording review.");
    }
    bindMeetingPrepDraftInput(record, args.bridge_input, { preparingReview: true });
    const updated = prepareMeetingPrepDraftReview(record, args.bridge_input, args.master_inventory, runtime.testerId);
    writeCase(updated);
    return textResult({ status: "review_ready", case_status: publicCaseStatus(updated),
      draft_review_digest: updated.draft_review.digest, slide_order: updated.draft_review.slide_order,
      metric_slide_plan: updated.draft_review.metric_slide_plan,
      available_performance: record.account_intelligence_core?.performance_coverage || null,
      slide_content_review: { cover: {cover_title:Native.coverTitle(args.bridge_input.projection.customerDisplayName),presentation_period:args.bridge_input.projection.presentationPeriod},
        projection: args.bridge_input.projection, phase_solution_roles: args.bridge_input.phaseSolutionRoles,
        phase_slide_plan: args.bridge_input.phaseSlidePlan || null,
        metric_exclusions: args.bridge_input.metricExclusions || {} },
      native_preflight_contract: updated.draft_review.native_preflight_contract,
      approvals_still_required: ["customer_content","maintained_slides"].filter(gate=>!updated.approvals.some(a=>a.gate===gate && a.revision===updated.revision)),
      review_request: meetingPrepDraftReviewPrompt(updated),
      next_action: "Show the complete exact wording and slide order. Ask only for the outstanding reviews; unchanged approved library selections may be retained. One explicit reply may approve named displayed decisions, recorded as separate ordered gates. Draft authorization and rendered review stay separate. No draft was created.",
      customer_content: args.bridge_input.customerContent });
  }
  if (name === "beta_plan_case_presentation_style") {
    if (record.renewal_conversation && activeRenewalBlocksContactResearch(record)) {
      throw new BetaError("RENEWAL_CUSTOMER_COPY_REVISION_REQUIRED", "Renewal customer wording is controlled by the renewal customer-copy contract. Use the renewal customer-copy revision operation; generic presentation preferences cannot change it.");
    }
    const { case_id: _caseId, ...overrideArgs } = args;
    const base = readPresentationPreferences(presentationPreferencesPath);
    const baseInput = {
      preset: base.preset,
      content_density: base.content_density,
      metric_detail: base.metric_detail,
      product_explanation: base.product_explanation,
      next_steps_tone: base.next_steps_tone,
    };
    const updated = planCasePresentation(record, {
      overrides: effectivePresentationPreferences({ ...baseInput, ...overrideArgs }),
      testerId: runtime.testerId,
    });
    writeCase(updated);
    return textResult(publicCaseStatus(updated));
  }
  if (name === "beta_record_approval") {
    const updated = approveGate(record, {
      gate: args.gate,
      revision: args.revision,
      testerId: runtime.testerId,
      note: args.note,
    });
    writeCase(updated);
    return textResult(publicCaseStatus(updated));
  }
  if (name === "beta_submit_feedback" || name === "beta_prepare_feedback_form") {
    const updated = submitFeedback(record, {
      wouldUse: args.would_use,
      savedTime: args.saved_time,
      biggestImprovement: args.biggest_improvement,
      revision: args.revision,
      testerId: runtime.testerId,
    });
    writeCase(updated);
    return textResult({
      ...publicCaseStatus(updated),
      feedback_delivery: prepareFeedbackForm(updated, runtime.feedbackFormConfig),
    });
  }
  if (name === "beta_confirm_feedback_submitted") {
    if (runtime.feedbackFormConfig?.enabled !== true) {
      throw new BetaError(
        "FEEDBACK_FORM_NOT_CONFIGURED",
        "The approved private Google Form is not connected yet.",
      );
    }
    const updated = confirmFeedbackSubmitted(record, {
      revision: args.revision,
      testerId: runtime.testerId,
    });
    writeCase(updated);
    recordRegisterEvent({
      eventType: "feedback_submitted",
      result: baseSetupStatus().result,
      caseId: updated.case_id,
      status: updated.status,
    });
    return textResult(publicCaseStatus(updated));
  }
  throw new BetaError("TOOL_NOT_FOUND", `Unknown tool: ${name}`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, error) {
  const normalized = error instanceof BetaError ? error : new BetaError("INTERNAL_ERROR", error.message);
  respond(id, textResult({ code: normalized.code, message: normalized.message, details: normalized.details }, true));
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
input.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
    if (request.method === "initialize") {
      respond(request.id, {
        protocolVersion: request.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: installedPackageManifest.name, version: installedPackageManifest.version },
        instructions: "ISMA setup uses the complete dependency checklist and the same approved installation job through verification. In manager mode, use bounded manager account search and the exact returned selection under actual source permissions; no book or role is inherited. Gmail signatures are applied by the user with Insert signature in Gmail after an approved unsent draft is saved. Never capture a signature, create a signature test draft or block drafting on a local profile. " + "For outreach, execute the finished contact read's completion_request to attach the same native account evidence. It returns the revision to use; never invent a CrossJourneyContextV1 or manual context digest. This is evidence completion, not CSM approval. Record explicit work/account reviews before preparing emails. For an explicit request to show a contact address, use beta_read_verified_contact_email with the same completed run, revision, exact contact_ref and explicit_email_request true; this cache-only disclosure requires no email approval and creates no draft or recipient selection. Ordinary meeting preparation defaults to account_brief. It needs no meeting date, recording, case or Slides setup. Route and start the named account brief immediately. A finished read supplies display_delivery_request: call that cache-only control and copy its first text block verbatim into the final reply. Preserve the opening read summary, every section, table header and row; only the established recent-call Summary/Next steps cells may be paraphrased from cached notes. Do not request optional display_details unless the CSM explicitly asks for detailed evidence. Put meeting questions after the brief. Missing temporary-image authorization never blocks the brief; offer cached charts once. Explicit recording analysis and all deck approval gates remain separate. For selected-CTA Renewal Conversation Brief preparation, immediately execute the start result's continuation_request through beta_continue_renewal_preparation until collection finishes. For default renewal delivery, copy its complete first text block verbatim, including the opening note, headings, capitalization, punctuation, next action, all candidate tables and authorized image Markdown. Do not polish, restyle or append another chart offer or selection request; its structured metadata is not another answer. Do not fetch the brief or each chart separately for this default renewal path. Never infer chart visibility, card selections, approvals or draft authorization. Outreach for different contacts defaults to one SEPARATE email per contact. Call beta_prepare_outreach_email for each selected contact using the same case and completed contact evidence, including when the first email is already reviewed or drafted. Do not add the next contact to the first email. Keep each returned email_ref and email_revision with every email approval, wording-review, claim and completion call; revision remains the shared case revision. Review work and account evidence once, then review each email independently. Immediately show the complete unapproved email after preparation, using the requested chat subject/body or composing from the existing evidence and guide. The native tool returns the verified target and review scope, not the copy. Pending contact, template and wording reviews are reviews of that preview; never withhold it waiting for those approvals. They remain required before Gmail creation. Reuse the current guide and still-valid contacts; never restart the case or source reads for another contact. Only an explicit request to edit the To list inside one email uses beta_get_verified_outreach_recipient; that control does not prepare a second email. Other workflow requirements are unchanged.",
      });
    } else if (request.method === "tools/list") {
      respond(request.id, { tools: visibleTools });
    } else if (request.method === "tools/call") {
      const toolName = request.params?.name;
      const startedAt = Date.now();
      Promise.resolve(callTool(toolName, request.params?.arguments || {}))
        .then((result) => {
          let outcome = null;
          try { outcome = JSON.parse(result.content?.[0]?.text || "null"); } catch { /* never inspect or log content */ }
          const observedTool = toolName === "beta_continue_book_of_business_read"
            ? outcome?.kind === "summary" ? "beta_read_book_of_business_summary" :
              outcome?.kind === "accounts" ? "beta_query_book_of_business_accounts" : toolName
            : toolName;
          recordWorkflowOutcome(workflowSourceObservations, {
            toolName: observedTool,
            resultStatus: outcome?.status,
            sourceReadState: outcome?.account_brief_read_state,
            errorCode: result.isError || outcome?.status === "failed" ? outcome?.code || "SOURCE_READ_FAILED" : null,
            elapsedMs: outcome?.source_elapsed_ms ?? Date.now() - startedAt,
          });
          respond(request.id, result);
        })
        .catch((error) => {
          recordWorkflowOutcome(workflowSourceObservations, {
            toolName,
            errorCode: error?.code || "SOURCE_READ_FAILED",
            elapsedMs: Date.now() - startedAt,
          });
          fail(request.id, error);
        });
    } else if (request.method === "ping") {
      respond(request.id, {});
    } else if (request.id !== undefined) {
      throw new BetaError("METHOD_NOT_FOUND", `Unsupported method: ${request.method}`);
    }
  } catch (error) {
    if (request?.id !== undefined) fail(request.id, error);
  }
});
