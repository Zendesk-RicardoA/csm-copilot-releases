import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nativeGmailSignatureHandling } from './gmail-native-signature.mjs';

const STEPS = ["snowflake", "salesforce_direct_verification", "private_master", "private_renderer", "shared_sources"];

function privateWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function step(state, title, action, blocking = true) {
  return { state, title, next_action: action, blocking };
}

export function buildSetupWizardStatus({ core, signature, salesforce, presenter, renderer, sharedSources, dependencyChecklist = null }) {
  const steps = {
    snowflake: step(core.status === "ready" ? "ready" : "action_required", "Company data access", core.next_action),
    salesforce_direct_verification: step(
      salesforce?.state === "ready" ? "ready" : salesforce?.state === "skipped" ? "skipped" : "action_required",
      "Salesforce direct verification",
      salesforce?.state === "ready" || salesforce?.state === "skipped" ? null : {
        code: "CONNECT_SALESFORCE_DIRECT_VERIFICATION",
        title: "Connect Salesforce direct verification",
        instruction: "Complete Salesforce browser sign-in. This supports selected relationship checks; normal Copilot work still uses the approved Snowflake source.",
      },
      false,
    ),
    private_master: step(presenter.status === "ready" ? "ready" : "action_required", "Private master deck", presenter.next_action),
    private_renderer: step(renderer.state === "ready" ? "ready" : "action_required", "Private deck renderer", renderer.next_action),
    shared_sources: { ...step(sharedSources?.state === "ready" ? "ready" : "source_gap", "Shared renewal sources", sharedSources?.next_action || null, false), warning: sharedSources?.warning || null },
  };
  if (dependencyChecklist && dependencyChecklist.workflow !== 'all') {
    for (const key of ['private_master', 'private_renderer']) {
      if (!dependencyChecklist.rows.find(row => row.dependency_id === key)?.required) steps[key].blocking = false;
    }
  }
  const next = STEPS.map((key) => ({ key, ...steps[key] })).find((item) => item.blocking && item.state === "action_required") || null;
  const dependency = dependencyChecklist?.rows.find(row => row.required && ['missing', 'sign_in_needed', 'blocked'].includes(row.state));
  const unchecked = dependencyChecklist?.rows.some(row => row.required && ['check_required', 'installed_not_checked'].includes(row.state));
  return {
    command: "Start setup wizard",
    status: next || dependency ? "action_required" : unchecked ? 'available_unverified' : "ready",
    next_action: next?.next_action || dependency?.next_action || (unchecked ? { code: 'VERIFY_SETUP_DEPENDENCIES', title: 'Check the installed connections', instruction: 'Complete the returned host inventory and harmless connection checks. Installed software alone is not verified access.' } : null),
    steps,
    dependency_checklist: dependencyChecklist,
    signature_handling: nativeGmailSignatureHandling(),
    completion_message: next || dependency
      ? "Complete the next step, then say “resume setup wizard.” You can still use any Copilot capability that is already ready."
      : unchecked ? 'Installation is present or still needs checking. Verify the required connections before calling this workflow ready.'
        : "Setup is complete for the selected workflow. Insert your saved signature in Gmail when reviewing a draft. Shared renewal sources are checked during renewal preparation.",
  };
}

export function startSetupWizard(filePath, status, now = new Date()) {
  const existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {};
  const record = {
    schema_version: "1.0",
    wizard_ref: existing.wizard_ref || `setup_${crypto.randomBytes(10).toString("hex")}`,
    started_at: existing.started_at || now.toISOString(),
    updated_at: now.toISOString(),
    last_status: status.status,
  };
  privateWrite(filePath, record);
  return { ...status, wizard_ref: record.wizard_ref, started_at: record.started_at, resumed: Boolean(existing.wizard_ref) };
}

export function resumeSetupWizard(filePath, status, now = new Date()) {
  return startSetupWizard(filePath, status, now);
}
