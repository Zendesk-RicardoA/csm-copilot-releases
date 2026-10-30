# ISMA automatic setup

Package: **0.3.1-isma.live.codex.20261030162033**.
Frozen package SHA-256: 13e7a956010646871055f2356e3360cdca372b7390f820a5db2a69b78343e45e.
Matching setup release tag: `isma-setup-v0.3.1-isma.live.codex.20261030162033`.

ISMA setup now acquires the exact version's private setup asset directly from the registered GitHub marketplace. It reuses the individual's existing GitHub CLI or Git credential-helper access without copying credentials or asking for a token in chat. No separate setup attachment is required.

Downloads require the exact private repository, a published matching release, one complete asset with bounded size and a matching SHA-256 digest, and the existing full frozen-release and control validation. Cross-host redirects never receive authentication. Downloads stay in an owner-only resumable cache. Failures preserve existing controls and do not start reinstall loops.

Existing local setup authorization, individual company sign-in, source permissions, account identity, draft approvals and no-expiry policy remain in force. This change reads release metadata and setup bytes only. It creates no customer draft, reads no customer account and changes no builder.

All twenty technical stages passed: 1151 source tests, 715 packaged tests and all five invented workflows. Tests cover cold setup, resumed cache, tampering, release mismatch, GitHub authentication fallback, safe redirects and distinct failure recovery. Independent colleague and live customer/model/rendered acceptance have not been claimed.
