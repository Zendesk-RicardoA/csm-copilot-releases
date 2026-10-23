# First-run Snowflake setup

The Copilot package and the local Snowflake prerequisites are separate. Never mark Snowflake ready
merely because the plugin installed, the CLI exists or a profile was created.

1. Run `beta_prepare_snowflake_setup`. It checks only local software/configuration, without SSO,
   a customer query, download or file change. Give its one returned next action.
2. For `INSTALL_SNOWFLAKE_CLI`, explain the software installation and ask for explicit approval.
   Use the desktop host's normal approved installation mechanism. The supported Homebrew core
   command is `brew install snowflake-cli`; it needs Homebrew already available and company approval.
   Do not install a package manager, use administrator privileges or override security policy
   automatically. If installation is blocked, use IT support. The managed reader needs the CLI's
   Python environment (Python 3.11+), not an arbitrary standalone binary or another connector.
3. Repeat the offline check after installation. Child processes can locate standard Homebrew paths
   without asking the tester to edit their shell or environment variables.
4. For `CONFIGURE_SNOWFLAKE_ZDP`, describe the bounded local change and get approval. Call
   `beta_configure_snowflake_zdp` only with `local_configuration_authorized: true`. It creates only
   the missing named profile from `snowflake-setup-template.json` and the named handoff. It preserves
   other profiles and never replaces an existing named profile. The profile contains a browser-SSO
   login hint, not shared credentials or proof of source identity. Local files are owner-only.
5. A missing private template, missing named handoff, malformed/unsafe config, conflicting shared
   `connections.toml` or unsupported runtime is a visible setup gap. Stop that change and report the
   returned code. Never guess an account, broaden a role, overwrite another profile or retry SSO
   as a repair for these local failures.
6. When configured, use `beta_connect_snowflake_zdp`. The tester signs in through their company
   browser. It verifies current user, role and warehouse only. No customer data is read. An
   unapproved role remains a permission gap even after successful sign-in.

Do not set up schema-discovery memory, ZDM API keys, another Snowflake region, Gmail or Slides for
this connection check. Continue their separate setup only when relevant to the requested workflow.
