// Runtime health is deliberately ephemeral. It contains only step names, error
// codes, and timing, never account, CTA, call, or transcript content.
import { WORKFLOW_CATALOG, WORKFLOW_STEPS } from "./workflow-catalog.mjs";
export { WORKFLOW_STEPS };

export function assessLoadedPackageVersion({ loadedVersion, diskVersion, approvedVersion }) {
  if (loadedVersion !== diskVersion) return {
    state: "fresh_session_required",
    loaded_version: loadedVersion,
    disk_version: diskVersion,
    approved_version: approvedVersion,
    next_action: "Start a fresh beta session to load the installed package on disk.",
  };
  if (loadedVersion !== approvedVersion) return {
    state: "approved_version_mismatch",
    loaded_version: loadedVersion,
    disk_version: diskVersion,
    approved_version: approvedVersion,
    next_action: "The loaded package is not the approved version; do not start customer work.",
  };
  return { state: "matched", loaded_version: loadedVersion, disk_version: diskVersion, approved_version: approvedVersion };
}

// Preserve the full-workflow interpretation for existing direct callers. Public
// setup/connection tools explicitly supply the new account_brief default.
export function summarizeWorkflowReadiness({ workflow, availableTools, setupStatus, packageStatus, executionApproval = "approved", observations = {}, rendererCompatibility = null, preparationMode = "selected_call" }) {
  const mode = workflow === "meeting_prep" ? WORKFLOW_CATALOG.workflows.meeting_prep.preparation_modes[preparationMode] : null;
  if (workflow === "meeting_prep" && !mode) throw new Error("Invalid meeting preparation mode.");
  const definition = mode ? WORKFLOW_STEPS[workflow].filter(item => mode.required_steps.includes(item.step)) : WORKFLOW_STEPS[workflow];
  if (!definition) throw new Error(`Unknown workflow: ${workflow}`);
  const toolNames = new Set(availableTools);
  const steps = definition.map(({ step, tools, observed, owner, hostTools }) => {
    const missingTools = tools.filter((name) => !toolNames.has(name));
    const last = observations[step] || null;
    return {
      step,
      ...(owner ? { owner } : {}),
      ...(hostTools ? { host_tools_required: hostTools, host_connection_state: "not_checked_by_local_control" } : {}),
      state: missingTools.length ? "missing" : last?.state === "failed" ? "failed" :
        observed && last?.state === "healthy" ? "healthy" : "available_unverified",
      missing_tools: missingTools,
      ...(last ? { last_checked_at: last.checked_at, last_elapsed_ms: last.elapsed_ms, last_error_code: last.error_code } : {}),
    };
  });
  if(rendererCompatibility && ["meeting_prep","renewal_conversation_brief"].includes(workflow) && (!mode || mode.renderer_required)) steps.push({step:"renderer_compatibility",state:rendererCompatibility.state==="matched"?"healthy":rendererCompatibility.state==="component_mismatch"?"missing":"available_unverified",missing_tools:[],next_action:rendererCompatibility.next_action || "Verify the exact frozen renderer and approved private master before a draft."});
  let state = "available_unverified";
  if (packageStatus.state !== "matched") state = packageStatus.state;
  else if (executionApproval !== "approved") state = "approval_required";
  else if (setupStatus !== "ready") state = "setup_required";
  else if (steps.some((item) => item.state === "missing")) state = "blocked";
  else if (steps.some((item) => item.state === "failed")) state = "degraded";
  else if (steps.every((item) => item.state === "healthy" || item.state === "available_unverified")) state = "available_unverified";
  return {
    state,
    ...(mode ? { preparation_mode: preparationMode, successful_ending: mode.successful_ending } : {}),
    steps,
    meaning: state === "available_unverified"
      ? "Required controls are exposed, but source execution and customer-facing output have not all been verified in this session."
      : state === "degraded" ? "A required source step failed in this session; do not describe this workflow as ready."
        : state === "approval_required" ? "This package and private runtime do not approve live source reads. Connection setup is not permission to read customer data."
        : state === "blocked" ? "A required workflow step is missing from the loaded package."
          : state === "fresh_session_required" ? "The installed package changed after this process loaded; start a fresh beta session."
            : state === "approved_version_mismatch" ? "The loaded package is not the approved version."
              : "Complete connection or setup requirements before this workflow.",
  };
}

const OBSERVED_TOOL_STEPS = Object.freeze({
  beta_read_daily_focus_work_signals: "work_signals",
  beta_read_owned_cta_queue: "cta_queue",
  beta_read_portfolio_recent_relationships: "recent_relationships",
  beta_continue_portfolio_recent_relationships: "recent_relationships",
  beta_read_book_of_business_summary: "book_summary",
  beta_start_book_of_business_summary: "book_summary",
  beta_query_book_of_business_accounts: "book_accounts",
  beta_start_book_of_business_accounts: "book_accounts",
  beta_start_meeting_prep_account_brief: "account_brief",
  beta_continue_meeting_prep_account_brief: "account_brief",
});

export function recordWorkflowOutcome(observations, { toolName, resultStatus, sourceReadState = null, errorCode = null, elapsedMs, now = new Date() }) {
  const step = OBSERVED_TOOL_STEPS[toolName];
  const completedPartial = step === "account_brief" && resultStatus === "partial" && sourceReadState === "completed";
  if (step === "account_brief" && resultStatus === "partial" && !completedPartial) errorCode ||= "ACCOUNT_BRIEF_SOURCE_GAP";
  if (!step || (!errorCode && resultStatus !== "ready" && !completedPartial)) return observations;
  const sourceError = errorCode && /(?:CTA_QUEUE|PORTFOLIO_RELATIONSHIP|SOURCE|SNOWFLAKE|TIMEOUT|READ|QUERY|STATEMENT)/i.test(errorCode);
  if (errorCode && !sourceError) return observations;
  observations[step] = {
    state: errorCode ? "failed" : "healthy",
    checked_at: now.toISOString(),
    elapsed_ms: Math.max(0, Math.round(elapsedMs)),
    error_code: errorCode || null,
  };
  return observations;
}
