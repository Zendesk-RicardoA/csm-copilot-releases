# Candidate release notes

Package: **0.2.27-candidate.live.codex.20261028154814**.

Frozen validation archive SHA-256: ed66c43076d218e9c502a7517bc4d688b7b757b960fbc99c29d23527dc40af02.

## Changes

- Completed native account/contact evidence creates its own account-context receipt. Email preparation no longer needs a caller-created context digest.
- The finished read returns its completion request and the completion control returns the revision to review. Evidence completion grants no approval.
- An explicit address request uses a read-only lookup of the same verified contact evidence. It changes no recipient, approval, draft or expiry and accepts no caller-supplied address.
- Polling the contact run preserves its original expiry. Expired or restarted contact memory cannot be reconstructed from a saved digest.
- The individual-email host fixture now follows native completion without manually injecting account context. Existing independent email reviews and duplicate-draft protection remain in place.

## Verification

- All 20 automated technical stages passed: 1,119 source tests, 683 packaged tests, protocol and fault checks, frozen renderer checks and invented runs for all five workflows.
- Nine new native-handoff and address-disclosure checks cover the reproduced failure, privacy, source gaps, changed evidence, explicit requests, account/owner/run/revision mismatch, expiry and restart.
- The local installed files match the frozen package and a fresh MCP process starts with matching loaded, disk and approved versions. Both new and existing outreach controls are registered.
- Existing credentials, profiles, signature and source permissions are preserved. Renderer components are unchanged; no builder update is included.

## Acceptance limits

The automated tests use invented accounts and Gmail mocks. Fresh actual-model acceptance and live customer/Gmail verification have not been completed for this exact artifact. No customer source read, real Gmail draft, send or Slides build was performed by this installation/update. Earlier acceptance remains attached to its original artifact.

This private Candidate update was explicitly authorized. It does not approve wider distribution or customer communications. Keep the matching private setup file outside Git and authenticate independently.
