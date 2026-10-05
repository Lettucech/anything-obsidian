# Add Vault Dialog Design

## Goal

Make the normal vault-onboarding path short and explicit: users supply a
repository URL, declare whether it is public or private, and explicitly choose
the Git author identity used by automatic sync commits.

## Chosen Design

`Add vault` opens a native modal dialog. Its primary fields are the vault
source, repository URL, repository visibility, Git commit author name, and Git
commit email. Selecting **Private repository** reveals HTTPS username and token
fields and makes both required. Selecting **Public repository** hides those
fields and sends no credential. Identity, workspace, scheduling, embedding, and
access settings are available only after creation through the vault's Edit action.

## Vault source

The dialog's **Add from** select chooses between two sources, matching the
backend's `sourceMode` contract:

- **Clone a repository** (default) clones from an HTTPS repository URL.
- **Import a local repository** registers a Git repository that already sits
  directly beneath the configured vault root. The dialog collects a vault id
  and directory (lowercase dash slugs, both required); the repository URL,
  remote, and branch are discovered from the repository, which must have an
  `origin` remote and a checked-out branch. Commit identity and repository
  visibility still apply — a private import requires an HTTPS credential so
  later scheduled syncs can authenticate. **Test connection** applies only to
  cloning; an import is verified when the vault is created.

The clone-only dialog shipped on 2026-07-30 dropped this select even though the
backend and README kept supporting imports; on 2026-10-05 the select was
restored so the UI matches the backend contract again.

The backend remains the enforcement boundary. A vault cannot be created without
a non-blank commit author name and email. A private repository must provide a
non-blank HTTPS username and token; public repositories save no credential.
The registry therefore stops manufacturing default Git author values for new
records. Per-vault credentials remain in the secret store and never appear in
API responses or registry metadata.

The dialog owns the full onboarding status: connection checks, clone progress,
and creation errors appear inside it, retaining entered values for correction.
**Test connection** verifies the repository with the selected HTTPS credential
and the AnythingLLM API key without cloning, creating a workspace, or saving a
vault record. Vault creation checks AnythingLLM before it clones so an invalid
API key does not leave a newly cloned but unmanaged repository.

## Non-goals

This does not add SSH authentication, alter existing stored credentials during
an edit, or change sync scheduling behavior.
