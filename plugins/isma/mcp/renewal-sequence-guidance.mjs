import { BetaError } from "./core.mjs";

const GUIDANCE = {
  P0: { action_window_days: 7, sequence_days: [1, 3, 6, 8], ae_alignment_reminder: true },
  P1: { action_window_days: 14, sequence_days: [1, 3, 6, 10], ae_alignment_reminder: true },
  P2: { action_window_days: null, sequence_days: [1, 3, 6, 10, 12], ae_alignment_reminder: false },
  P3: { action_window_days: null, sequence_days: [1, 4, 8, 12], ae_alignment_reminder: false },
};

export function getRenewalSequenceGuidance(priority) {
  if (!/^P[0-4]$/.test(priority || "")) {
    throw new BetaError("INVALID_RENEWAL_PRIORITY", "Choose a renewal priority from P0 to P4.");
  }
  const guidance = GUIDANCE[priority];
  if (!guidance) return {
    priority,
    status: "policy_not_defined",
    send_state: "not_sent",
    review_required: true,
    progress_blocked_by_ae_alignment: false,
    message: "There is no approved renewal sequence for this priority. Do not draft from a guessed template.",
  };
  return {
    priority,
    ...guidance,
    source_use: "Read the selected approved sequence in its current source at draft time. Do not copy a stored version into the plugin.",
    send_state: "not_sent",
    review_required: true,
    progress_blocked_by_ae_alignment: false,
    required_checks: [
      "Confirm the account and CTA are still the right focus.",
      "Verify the contact in all approved sources before choosing them.",
      "Use current account evidence and metrics only when it is relevant and clearly tied to the product or feature.",
      "Review the draft against the current approved sequence before any human sending decision.",
    ],
    csm_reminders: guidance.ae_alignment_reminder
      ? ["Consider whether the Account Executive should be informed or involved. This does not block research, drafting, or review."]
      : [],
    message: "The sequence is a reviewed guide, not automatic email copy. This tool does not send or enroll anyone.",
  };
}
