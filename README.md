# Install ISMA

ISMA brings customer information and recent interactions together to prepare outreach, meetings, plans and presentations. One plugin serves CSMs and managers.

**No GitHub account or invitation is needed.** You need the Codex desktop app and your own company access to the connected tools.

## 1. Open Codex

Start a new chat. If Codex asks for a folder, create an empty folder called ISMA setup and select it.

## 2. Copy and send this message

```text
Install ISMA from https://github.com/Zendesk-RicardoA/csm-copilot-releases.git. I approve installing ISMA and saving its setup settings. Keep my existing settings and use GitHub for future updates. Download the required setup automatically. Ask before installing additional software. Guide me through my company sign-in and tell me when to restart. Setup only; do not read customer data.
```

Codex downloads the plugin and its matching setup automatically. Follow the permission prompts it shows. You do not need to download or attach a setup file yourself.

## 3. Finish setup

When asked, quit and reopen the desktop app. Start a new chat and send:

```text
Finish ISMA setup. Check the connections I need and explain anything I still need to do.
```

Use your own company accounts for sign-in. Setup shows which connections are ready and which need attention. You are finished when the connections needed for your chosen task are ready.

If setup stops, share the error message with the release owner. Keep passwords and sign-in codes private.

## Existing installations

Ask Codex to update ISMA from this repository while preserving your settings. For a Git-registered installation, the commands are `codex plugin marketplace upgrade isma` and `codex plugin add isma@isma`. Then complete the matching setup and restart into a new chat. A local-folder registration needs to be replaced with this exact HTTPS Git source first.

## Release information

Current package: **0.3.5-isma.live.codex.20261103174914**. The exact versioned setup is published before the installation branch is updated. Setup verifies the release digest, complete installed-file inventory and frozen release proof before importing settings. Shared release policy and non-credential connection settings are public; each person's credentials, profiles, cases and approvals stay local. Company authentication and source permissions determine data access.

The dependency checklist covers Snowflake, Gmail, Google Calendar, Google Drive, Converge, Zendesk Help Center, optional Slack and Cerebro, and private deck components. Supported additional installations need the user's approval and are verified before setup continues. Open an approved email draft in Gmail and use Insert signature to add your saved signature.

This owner-authorized public candidate update retains the existing no-expiry policy and private draft protections. All automated checks passed for the frozen package. Independent colleague installation, live customer workflows and human rendered-output acceptance are separate from these technical checks.
