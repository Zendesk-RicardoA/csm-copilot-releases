const RECOVERY_RENDERER_BASELINE = "recovery-v3";
const RECOVERY_DESIGN_FAMILY = "journey-b-approved-design-v3";

import { validateApprovedRecoveryDesignContract } from "./approved-recovery-design.mjs";
import { assertNoPowerPointOutput } from "./presentation-output-policy.mjs";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

/**
 * The beta control plane must not emit an envelope that the reference-locked
 * Apps Script renderer will reject. It accepts only the accepted 23-slide v3
 * source contract; no legacy role aliases, compact templates, or fallback
 * renderer may be revived by a package manifest.
 */
export function assertReferenceLockedRendererRequest({ rendererBaseline, bridgeInput }) {
  if (rendererBaseline !== RECOVERY_RENDERER_BASELINE) {
    fail(
      "RENDERER_BASELINE_RETIRED",
      "This beta package uses a retired deck renderer. Install the approved reference-locked recovery-v3 package before creating a draft.",
    );
  }
  const binding = bridgeInput?.templateBinding;
  assertNoPowerPointOutput(bridgeInput?.output || {});
  if (binding?.recoveryFamily !== RECOVERY_DESIGN_FAMILY || binding.strictFieldCoverage !== true) {
    fail(
      "RECOVERY_BINDING_REQUIRED",
      "The approved Customer Planning and Meeting Prep v3 design requires a complete strict-field native template binding.",
    );
  }
  const contract = binding.approvedDesignContract;
  try {
    validateApprovedRecoveryDesignContract(contract);
  } catch (error) {
    fail(error.code || "APPROVED_DESIGN_CONTRACT_REQUIRED", error.message);
  }
  if (binding.bindingMode === "capture_active_private_master") return true;
  if (!contract.slideFingerprints) {
    fail(
      "APPROVED_DESIGN_CONTRACT_REQUIRED",
      "A non-sealed renderer request must include a complete approved source contract.",
    );
  }
  return true;
}

export { RECOVERY_RENDERER_BASELINE, RECOVERY_DESIGN_FAMILY };
