# Add Vault Dialog Design

## Goal

Make the normal vault-onboarding path short and explicit: users supply a
repository URL, declare whether it is public or private, and explicitly choose
the Git author identity used by automatic sync commits.

## Chosen Design

`Add vault` opens a native modal dialog. Its primary fields are repository URL,
repository visibility, Git commit author name, and Git commit email. Selecting
**Private repository** reveals HTTPS username and token fields and makes both
required. Selecting **Public repository** hides those fields and sends no
credential. Identity, workspace, scheduling, embedding, and access settings
are available only after creation through the vault's Edit action.

The backend remains the enforcement boundary. A vault cannot be created without
a non-blank commit author name and email. A private repository must provide a
non-blank HTTPS username and token; public repositories save no credential.
The registry therefore stops manufacturing default Git author values for new
records. Per-vault credentials remain in the secret store and never appear in
API responses or registry metadata.

## Non-goals

This does not add SSH authentication, alter existing stored credentials during
an edit, or change sync scheduling behavior.
