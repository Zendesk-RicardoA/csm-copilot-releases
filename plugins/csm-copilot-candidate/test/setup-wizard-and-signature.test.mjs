import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateCapabilityReadiness } from "../mcp/core.mjs";
import { buildOutreachPack } from "../mcp/outreach-pack.mjs";
import { resolveRenewalSourceWithGoogleDrive, selectRenewalSequence } from "../mcp/renewal-source-resolver.mjs";
import {
  confirmSignatureTest,
  readSignatureForApprovedDraft,
  removeSignatureProfile,
  saveSignatureProfile,
  signatureProfileStatus,
  signatureTestDraft,
} from "../mcp/signature-profile.mjs";
import { buildSetupWizardStatus, resumeSetupWizard, startSetupWizard } from "../mcp/setup-wizard.mjs";

const packageResult = { package_version: "0.0.0-test", renderer_baseline: "recovery-v3" };
const credentialState = {
  mode: "limited_beta",
  identity: { state: "connected", provider: "snowflake_zdp_sso", subject: "opaque", verified: true },
  snowflake: { state: "connected", read_only_verified: true },
  presenter_profile: { state: "not_configured" },
};

test("outreach and renewal evidence do not require a deck while full meeting prep does", () => {
  const outreach = evaluateCapabilityReadiness({ credentialState, packageResult, workflow: "outreach", signatureStatus: { state: "not_configured" } });
  assert.equal(outreach.status, "ready");
  assert.equal(outreach.capabilities.cta_queue, "ready");
  assert.equal(outreach.capabilities.gmail_draft, "setup_needed");
  assert.equal(outreach.next_action, null);
  const renewal = evaluateCapabilityReadiness({ credentialState, packageResult, workflow: "renewal_conversation_brief" });
  assert.equal(renewal.status, "ready");
  assert.equal(renewal.capabilities.renewal_evidence, "ready");
  assert.equal(renewal.capabilities.private_google_slides_draft, "setup_needed");
  assert.equal(renewal.next_action, null);
  assert.match(renewal.setup_notes[0], /only after you approve/i);
  const meeting = evaluateCapabilityReadiness({ credentialState, packageResult, workflow: "meeting_prep" });
  assert.equal(meeting.status, "action_required");
  assert.equal(meeting.next_action.code, "PERSONALIZE_PRIVATE_MASTER_DECK");
});

test("signature profile is private, verified once, and removable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "csm-signature-test-"));
  const profilePath = path.join(directory, "gmail-signature-profile.json");
  try {
    const saved = saveSignatureProfile(profilePath, {
      html: '<div><img src="cid:logo">Regards</div>',
      inline_assets: [{ cid: "logo", mime_type: "image/png", data_base64: Buffer.from("invented-image").toString("base64") }],
    });
    assert.equal(saved.state, "test_required");
    assert.equal(fs.statSync(profilePath).mode & 0o777, 0o600);
    const draft = signatureTestDraft(profilePath);
    assert.deepEqual(draft.to, []);
    assert.equal(draft.send_state, "not_sent");
    assert.equal(confirmSignatureTest(profilePath).state, "ready");
    assert.equal(readSignatureForApprovedDraft(profilePath).inline_assets.length, 1);
    assert.equal(removeSignatureProfile(profilePath).state, "not_configured");
    assert.equal(fs.existsSync(profilePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("signature profile rejects active HTML and never needs a source email", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "csm-signature-test-"));
  try {
    assert.throws(() => saveSignatureProfile(path.join(directory, "profile.json"), { html: '<script>alert(1)</script>' }), { code: "INVALID_SIGNATURE_PROFILE" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("setup wizard resumes without creating a customer case", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "csm-wizard-test-"));
  const wizardPath = path.join(directory, "setup-wizard.json");
  try {
    const status = buildSetupWizardStatus({
      core: { status: "ready", next_action: null },
      signature: { state: "ready", next_action: null },
      salesforce: { state: "ready" },
      presenter: { status: "ready", next_action: null },
      renderer: { state: "ready", next_action: null },
      sharedSources: { state: "automatic_check_pending" },
    });
    const started = startSetupWizard(wizardPath, status);
    const resumed = resumeSetupWizard(wizardPath, status);
    assert.equal(started.status, "ready");
    assert.equal(resumed.resumed, true);
    assert.equal(fs.statSync(wizardPath).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(fs.readFileSync(wizardPath, "utf8")).includes("case_id"), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("renewal source maps a reviewed guide and surfaces a missing copy", async () => {
  const mapping = selectRenewalSequence({
    templateRows: [["Priority", "Language", "Sequence"], ["P0: Non-Monthly Renewal", "Spanish", "Spanish renewal"]],
    sequenceRows: [["Language", "Localized One Pager", "Completed"], ["Spanish", "Spanish guide", "TRUE"]],
    priority: "P0", language: "es",
  });
  assert.equal(mapping.sequence_title, "Spanish renewal");
  assert.equal(mapping.reviewed, true);
  const calls = [];
  const response = await resolveRenewalSourceWithGoogleDrive({
    accessToken: "invented", priority: "P0", language: "es",
    fetchImpl: async (url) => {
      calls.push(url);
      const body = url.includes("drive/v3/files") && !url.includes("name%20%3D")
        ? { files: [{ id: "invented-tracker", name: "H2 Renewal Sequences" }] }
        : url.includes("spreadsheets")
          ? { valueRanges: [{ values: [["Priority", "Language", "Sequence"], ["P0: Non-Monthly Renewal", "Spanish", "Spanish renewal"]] }, { values: [["Language", "Localized One Pager", "Completed"], ["Spanish", "Spanish guide", "TRUE"]] }] }
          : { files: [] };
      return { ok: true, json: async () => body };
    },
  });
  assert.equal(response.status, "sequence_copy_unavailable");
  assert.match(response.next_action, /wait/i);
  assert.ok(calls.length >= 3);
});

test("outreach pack keeps tables and source gaps explicit", () => {
  const pack = buildOutreachPack({ brief: { account_summary: { account: "Invented" } }, contacts: [{ display_name: "Invented Contact" }], sourceGaps: ["QBR_UNAVAILABLE"] });
  assert.deepEqual(pack.sections.source_gaps, ["QBR_UNAVAILABLE"]);
  assert.equal(pack.presentation.format, "fixed_sections_and_tables");
  assert.equal(pack.sections.suggested_contacts.length, 1);
});
