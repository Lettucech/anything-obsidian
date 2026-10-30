# Production operations

Approved scope: the operational review of 2026-10-30, with breaking changes
explicitly allowed. Native Node, external AnythingLLM, loopback administration,
and preservation of vault/source files remain constraints.

1. Separate client and gateway configuration. Persist installed roles and
   autostart preference; pin the absolute data root in every service definition.
2. Make setup/start/stop/restart/status/logs the normal CLI. Start is idempotent
   and backgrounded through the OS supervisor. Foreground runners are diagnostic
   entry points. Stop preserves autostart; disabling autostart is explicit.
3. Serialize source/vault mutations across processes. Commit manifests atomically
   only after remote verification. Repair missing documents, expose forced
   rebuilds, add deadlines, and retain old documents until replacements verify.
4. Persist gateway jobs, progress, logs, and interrupted outcomes. Deduplicate
   active jobs, bound history, provide retries, and make removal a tracked purge.
5. Apply workspace permissions to source/job metadata and refresh operations.
6. Expose the same lifecycle and job state in both dashboards and MCP. Add a
   gateway operations view that survives reload and reconnects after restart.
7. Stage and validate updates before switching; restart installed roles, verify
   readiness, and roll back failed activation.
8. Update installer, setup skills, README, and operations documentation together.

Verification: focused regression tests for each changed contract, integration
tests against fake AnythingLLM HTTP endpoints, generated launchd/systemd unit
checks, full Node test suite, shell syntax checks, and browser QA against an
isolated gateway. Actual OS reboot and live embedding-provider verification
remain deployment checks and must not be represented as completed locally.

No changes are applied to this machine's installed services or real vaults.

## Verification completed

- Full suite: 280 tests passed on Node 22.14.0 and Node 26; no failures or skips.
- Shell syntax and `git diff --check` passed.
- Disposable gateway browser/API checks: incremental refresh, failed rebuild
  preserving the last good index, UI retry completing a rebuild, missing remote
  documents repaired without a content change, and four job records preserved
  across an actual gateway-process restart. Expanded job logs and verified
  upload/remove/repair counts were checked in the Operations view.
- Regression coverage includes cross-process locks, service definitions and
  registration status, configuration isolation, credential rotation, scoped
  source/job access, durable cleanup, installer quoting, and update rollback.
- CI now defines Linux/macOS checks on Node 22, 24, and 26. Remote CI, an actual
  OS reboot, and a live AnythingLLM/provider run have not been performed.
