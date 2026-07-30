# Add Vault Dialog Implementation Plan

**Goal:** Replace the inline add-vault flow with a visibility-aware dialog and
make automatic-commit identity explicit and enforced.

1. Add failing server and registry tests for required commit author metadata and
   private HTTPS credentials; run the scoped tests to prove the missing
   validation.
2. Validate those rules before clone/workspace side effects, and make registry
   normalization require a non-blank Git name and email.
3. Replace the inline add form with a native dialog. Make repository visibility
   control the conditional credentials and expose workspace, sync, embedding,
   and access options only through the post-creation Edit flow.
4. Update the getting-started documentation and run dashboard/lib tests plus
   `git diff --check`.
