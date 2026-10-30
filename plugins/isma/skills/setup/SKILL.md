---
name: setup
description: Complete or repair first-run ISMA setup, audit installed and missing dependencies, carry approved supported installations through verification, and resume setup without repeating approvals.
---

# ISMA first-run setup

Installation adds the plugin. It does not approve customer access, authenticate a
person, verify a Slides builder or complete any customer workflow.

## Check before changing anything

Resolve the plugin root from this installed skill's directory (`../..`). Use the
desktop's existing Node runtime to run the packaged helper
`mcp/marketplace-setup.mjs inspect`. Do not fetch or install another runtime.
The helper returns only setup status; never print the private files.

- If `configured`, continue the normal native setup wizard. Do not import again.
- If `private_setup_required`, run the same bundled helper with `download`.
  It discovers this plugin's registered private GitHub marketplace, reuses the
  user's existing GitHub access, and downloads the exact installed version's
  published setup asset. It checks GitHub's size and SHA-256 digest and the
  existing frozen release proof, complete plugin inventory and private controls.
  A valid owner-only local cache is reused when setup resumes. Do not ask the
  user to attach or send a setup file, install another download tool, or paste
  a token. Do not create, edit or guess release controls.
- For `downloaded` or `cached`, use only the returned verified `setup_file` path
  in the apply step below. For `configured`, continue the native setup wizard.
- For a GitHub sign-in error, give the one returned GitHub sign-in step and
  resume after the user completes it. Access, SSO, unavailable-release and
  connectivity errors have different next actions; follow the returned code.
  Do not loop through reinstallations or repeated sign-in attempts. If the
  user explicitly chooses offline setup, the existing matching-file apply path
  remains available; it is not the normal installation route.
- If blocked, show the returned code and next action. Do not modify a manifest,
  retry a sign-in to repair release configuration, or bypass company restrictions.

## Apply only the selected release setup

Use the user's existing setup authorization; ask once only if saving bounded
local release setup has not already been authorized. Ask
for the user's own company sign-in name if it was not already supplied. This is
only an SSO login hint; identity and permissions come from actual authentication.
Never ask for a password, token or sign-in code.

After that authorization, invoke `mcp/marketplace-setup.mjs apply` using the
existing Node runtime. Supply this JSON through the process's standard input,
not command-line arguments, shell interpolation, a repository file or a log:

```json
{
  "setup_file": "/absolute/path/to/selected/private-setup.json",
  "local_configuration_authorized": true,
  "login_hint": "operator@example.invalid"
}
```

Replace the example with only the verified download path and the user's supplied login
hint. The helper verifies the exact plugin, frozen release proof, controls and
renderer contracts before saving anything. It preserves credentials, personal
settings and cases; it does not install software, sign in, query sources, update
builders or create drafts. Do not run customer workflows during this step.

If `restart_required`, tell the user to restart the desktop app and open a fresh
chat. Do not claim the current process has reloaded the configuration.

## Continue the existing setup controls

Start with `beta_get_dependency_checklist` and `beta_start_setup_wizard`.
Choose the requested workflow, or `all` for a complete installation checklist.
Use Plugin Management to inspect Gmail, Google Calendar, Google Drive and Slack;
use the host's enabled tool inventory for Converge and Zendesk Help Center.
Check the local Cerebro plugin with the supported Codex plugin list, without
requiring a separate Cerebro MCP. It is optional for service ownership work.
Use `beta_prepare_snowflake_setup` for the actual local Snowflake prerequisite
check. Never inspect or print credentials. Return bounded observations through
`beta_get_dependency_checklist`: installation, tool availability and connection
state only. A package or exposed tool is installed, not yet verified. Use a
harmless native profile/connection probe to mark access verified; do not run
customer queries to complete onboarding.

Show every checklist row, including optional dependencies, with one of: ready,
installed but not checked, missing, sign-in needed, blocked, optional or not
needed for this workflow. Include the next concrete action for each non-ready
required dependency. A failure or missing result is not proof of absence.

After explicit authorization to install a named missing component, execute the
returned `beta_install_setup_dependency` request with
`installation_authorized:true`. Use `beta_continue_setup_installation` while
the same job runs; never launch a duplicate or ask for the same approval again.
The fixed supported recipes install Snowflake CLI through an existing Homebrew
core formula or Cerebro through its existing company marketplace. Do not
install Homebrew, use sudo, fetch a shell script or bypass company security.
If an approved recipe fails, show its specific safe failure and remedial step.
Retry that same recipe only when requested, with `retry_failed:true`; the
control reuses the prior same-scope approval. A restart with uncertain progress
requires reconciliation, not another installation. Exit success is not enough:
the control verifies the supported local runtime or installed enabled plugin.

For host plugins, resolve the exact provider through Plugin Management and use
its supported install/connect UI, then verify and resume this same checklist.
For Converge and Help Center, use the existing approved company MCP setup and
each person's own sign-in. If no host install/connect action is exposed, show
the one missing company setup or IT step. Do not invent a tool or endpoint,
copy another person's configuration/credentials, or loop through unavailable
actions. Local installation, company authorization and source access remain
separate. Keep optional dependencies from blocking a ready workflow.

Continue `beta_configure_snowflake_zdp`, `beta_connect_snowflake_zdp` and
`beta_resume_setup_wizard` as needed. Profile creation and installation have
separate scopes; existing authorization persists. Browser sign-in belongs to
the individual and is never delegated or imported.

After source identity verification, use `beta_get_account_access_mode` and save
the user's chosen mode through `beta_set_account_access_mode`. CSM mode uses
the assigned book. Manager mode enables bounded name search followed by exact
account selection under actual source permissions; it grants no role, inherits
no CSM book and changes no owned-CTA or portfolio scope. Do not infer a manager's
permissions from their title or the selected mode.

Keep connection readiness separate from workflow verification. ISMA has no Gmail
signature capture or signature-test setup step. Save approved unsent drafts
through Gmail, then ask the user to open the draft and use Gmail's Insert
signature control to apply their saved signature before reviewing/sending it.
Do not claim it was applied automatically. Preserve legacy private signature
files without reading, refreshing or deleting them. Slides setup must not
prevent book analysis or account preparation.
Stop after setup; a setup request does not authorize a customer case, source
acceptance run, email draft or deck. Follow the normal CSM Copilot workflow skill
only when the user requests that work.
