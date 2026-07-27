# Multi-Vault Dashboard Design

## Summary

Evolve `anything-obsidian` from its single configured vault into a shared local
runtime that manages zero or more Git-backed Obsidian vaults. One Docker Compose
stack continues to run AnythingLLM, MCP, the dashboard, and worker image. Each
managed vault maps to its own AnythingLLM workspace, sync state, embedding
manifest, schedule, and access policy.

Vault setup moves into the dashboard. A new stack starts successfully with no
vaults configured. The dashboard owns the registry and lets a user create or
import a vault later.

## Goals

- Run any number of vaults with one AnythingLLM server, MCP server, dashboard,
  and worker image.
- Make the dashboard the only normal vault-management surface after Compose is
  running.
- Keep Git as the source of truth and AnythingLLM as a derived index.
- Give every vault an independent AnythingLLM workspace and embedding manifest.
- Allow per-vault access policy without making access control mandatory.
- Avoid arbitrary host-path access from the dashboard or worker jobs.
- Keep an empty, newly installed system useful and healthy before its first
  vault is added.

## Non-goals

- Do not create one Compose project or one AnythingLLM server per vault.
- Do not scan, mount, or allow dashboard input to select arbitrary host paths.
- Do not delete a user's local Git repository when they remove a vault from the
  registry.
- Do not build multi-user authentication in the first implementation; retain
  the data model and MCP enforcement boundary for it.
- Do not use the dashboard to display Git, AnythingLLM, or other runtime secret
  values.

## Runtime And Mount Model

Compose establishes one fixed host vault root when the stack starts. Its default
should be a directory in the user's home folder, for example:

```text
~/.anything-obsidian/vaults -> /vaults
```

The exact host path is configurable in `.env` or `docker-compose.yml`, so a user
can point it at a preferred disk or an existing Obsidian-vault parent directory.
It is not a per-vault dashboard setting. The mounted root may initially be
empty.

Every managed vault is a direct child directory of `/vaults`:

```text
/vaults/work
/vaults/personal
/vaults/project-a
```

Dashboard, scheduler, and worker operations receive only the validated vault
id and its relative directory. They must resolve it beneath `/vaults` and reject
path traversal. This removes the need for dynamic arbitrary Docker bind mounts
and ensures Docker Desktop needs access to only one predictable location.

## Vault Registry And Namespacing

The dashboard stores the registry in a dedicated Docker named volume. It must
not live in `.env`, because vaults are created and edited after initial setup.
Each record contains:

- stable `id` and user-facing `name`;
- validated relative `directory` below `/vaults`;
- Git remote and branch settings, with credentials referenced from the runtime
  secret store rather than included in API responses;
- unique AnythingLLM `workspaceSlug` and workspace identity;
- sync interval and enabled state;
- `accessMode`: `open` or `restricted`;
- an allowlist for `restricted` vaults.

All mutable runtime state is namespaced by `vaultId`:

```text
registry/vaults/<vaultId>
manifests/<vaultId>
locks/<vaultId>
jobs/<vaultId>
```

Rebuilding one vault, removing a record, or a failed sync must not alter the
state of another vault.

## Dashboard Experience

The dashboard home screen becomes a vault list with service health as supporting
information. With an empty registry it presents an explicit "Add your first
vault" state; AnythingLLM and MCP may remain running.

Each vault card shows its workspace, Git branch and last known commit, last and
next sync time, recent error summary, and job state. Its fixed actions are:

- Sync now
- Embed changed
- Rebuild index
- Edit
- Remove from management

The add/edit flow collects, in order:

1. Name and vault id.
2. A child directory in the mounted vault root, validated as a Git repository.
3. Create a new workspace or attach an existing one.
4. Sync schedule and enabled state.
5. `open` or `restricted` access; an allowlist appears only for `restricted`.
6. A final confirmation of the resulting Git repository and workspace mapping.

The dashboard supports two onboarding actions:

- **Create vault:** create a new Git repository as a child of the mounted vault
  root.
- **Import existing vault:** the user first puts an existing vault under the
  configured root (by moving it, copying it, or creating a symlink), then the
  dashboard validates and registers it.

Removing a vault only removes its registry entry and stops future jobs. Deleting
its AnythingLLM workspace, embedding manifest, or local repository requires a
separate, explicitly confirmed destructive action; deletion of the local
repository is out of scope for normal dashboard management.

## Sync, Embedding, And Scheduling

A single scheduler reads all enabled vault records and dispatches bounded worker
jobs. It must not create one permanent syncer container per vault. Each job is
tagged with `vaultId`, resolves its directory under `/vaults`, runs the existing
Git workflow, and embeds only to the vault's mapped workspace.

At most one job may be active per vault. A scheduler job and a dashboard action
for the same vault queue or report an existing job; jobs for different vaults
may run within a configured global concurrency limit. Failure is isolated:
record the vault-specific failure, preserve the last successful Git and embed
state, and continue processing other vaults.

## MCP Access

MCP exposes vaults as an explicit search scope, using `vaultId` as the stable
caller-facing selector. It resolves that selector to the mapped AnythingLLM
workspace internally.

- A caller with one accessible vault may omit the selector; MCP uses that vault.
- A caller with more than one accessible vault must specify one; MCP must not
  silently search across vaults.
- `open` vaults are visible to every authenticated MCP caller.
- `restricted` vaults are visible only to caller identities in their allowlist.

The first release can persist restricted policies before identity authentication
is available, but the dashboard must label that state clearly as not enforced.
Once MCP caller identity is introduced, enforcement belongs in MCP before any
workspace lookup; hiding cards or controls in the dashboard is never security.

## Error Handling And Security

The implementation must report vault-specific, actionable errors for:

- path absent, outside `/vaults`, or not a Git repository;
- duplicate directory, workspace, or id;
- workspace creation, lookup, or attachment failure;
- missing Git credentials, Git conflict, pull, commit, or push failure;
- AnythingLLM unavailable or workspace access failure;
- another active job for the same vault;
- unavailable or not-yet-enforced restricted policy.

The dashboard must validate the effective container-visible path, not merely the
submitted string. API endpoints accept stable ids and fixed action names only;
they must never accept shell fragments, Docker arguments, arbitrary filesystem
paths, or raw secrets. Existing Docker-socket safeguards remain: local binding,
fixed project containers, and no generic Docker command surface.

## Testing And Verification

The implementation is complete only when automated coverage proves:

- an empty registry starts and renders the first-vault state;
- vault create, import, edit, and non-destructive remove behavior;
- path resolution rejects traversal and directories outside the mounted root;
- unique workspace mapping and per-vault manifest isolation;
- job locks prevent duplicate work for a vault while failures do not stop other
  scheduled vaults;
- worker commands target only the requested vault and workspace;
- MCP scope selection and `open`/`restricted` policy behavior;
- dashboard responses and logs never expose secrets;
- `docker compose config` validates the single fixed vault-root mount;
- `git diff --check` succeeds.

Runtime verification should also create/import two vaults, sync and rebuild each
independently, confirm both AnythingLLM workspaces contain only their respective
documents, and confirm removing one registry record leaves the other vault and
its local Git repository intact.

## Migration

Existing single-vault users receive a one-time migration path that creates a
registry entry from the current `HOST_VAULT_PATH`, Git environment settings, and
`ANYTHINGLLM_WORKSPACE_SLUG`. The dashboard presents this as an import preview;
it does not silently move the user's repository. After migration, the fixed
vault-root mount becomes the supported path. Documentation must tell existing
users how to move or link their vault beneath that root, or deliberately change
the root to their current vault parent directory.
