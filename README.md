# ISMA private marketplace

Current package: **0.3.3-isma.live.codex.20261031012538**. One plugin serves CSMs and managers.

Give each colleague access to this private repository. For a first installation, copy this repository’s exact HTTPS clone URL from GitHub and run `codex plugin marketplace add <REPOSITORY_GIT_URL> --ref main`, then `codex plugin add isma@isma`. Replace the placeholder with that URL. Do not silently register a downloaded local folder; existing local registrations need their source replaced while preserving private settings. They can then install ISMA from this Git marketplace and start **ISMA setup**. Setup automatically downloads and verifies this installed version's matching private release asset. No setup attachment needs to be sent or pasted into chat. Each person uses their own GitHub access and company sign-in; installation grants no data permissions.

For an existing Git installation, run `codex plugin marketplace upgrade isma`, then `codex plugin add isma@isma` and complete the packaged local setup steps with the existing desktop Node runtime. Then restart into a fresh chat to continue company sign-in and the native dependency wizard. Local-folder registrations first need their source replaced with this repository's supplied Git URL. The helper obtains the exact new version's setup, checks GitHub's asset size and SHA-256 digest and verifies the frozen release proof, full plugin inventory, private controls and renderer contracts before any local setup import. A valid private cache is reused when setup resumes. GitHub sign-in, access/SSO, missing-release and network failures have distinct next steps; do not reinstall repeatedly or edit manifests.

The release owner publishes `private-setup.json` on the matching versioned private GitHub release before updating the installation branch. The asset contains release policy and connection templates, never another person's credentials or case approvals. It stays outside Git history. Only frozen plugin files and sanitized release notes belong here.

The dependency checklist covers Snowflake, Gmail, Google Calendar, Google Drive, Converge, Zendesk Help Center, optional Slack and Cerebro, and private deck components. Explicitly approved supported installs are verified and resumable. Company MCPs and host plugins retain their own approved connection flow.

CSM book and owned-CTA scope remain authoritative. Manager mode supports bounded account-name search and exact account selection under actual verified read-only source permissions. ISMA has no package calendar expiry; package approval, source permissions, evidence deadlines and private draft review remain enforced. Open approved email drafts in Gmail and choose Insert signature to use your saved signature.

One ISMA identity replaces Candidate/Test on the owner laptop. Preserve settings when upgrading other existing laptops and retire only the exact older registrations after replacement verification. Historical versions remain recoverable.

All technical checks passed for this exact package. The actual private GitHub setup download and local startup are verified separately in the installation receipt. Independent colleague installation, fresh actual-model, live customer/Gmail and human rendered-output acceptance remain pending; this is a controlled private update, not a wider approved release.

This update corrects the public developer and author attribution in package metadata. The renderer and workflow behavior are unchanged.
