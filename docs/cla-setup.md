# Enforcing the CLA

Today the CLA is lightweight: the pull request template has a checkbox, and `CONTRIBUTING.md`
explains the agreement. That is a record of consent, not a gate, so the maintainer checks the box
by hand before merging. When outside contributions become regular, enforce it with one of the two
tools below. Both block the merge until the contributor signs, and both record who signed.

## Option A: CLA Assistant GitHub Action (recommended)

Signatures live in the repository, and there is no third-party service. Source:
https://github.com/contributor-assistant/github-action

1. Settings, Actions, General, Workflow permissions: allow read and write.
2. Decide where `signatures/version1/cla.json` goes. The action commits to the branch named in the
   workflow, and that branch must not be protected. Either use a dedicated unprotected branch such
   as `cla-signatures`, or store signatures in a separate private repository (then create a
   personal access token with `repo` scope and save it as the secret `PERSONAL_ACCESS_TOKEN`, and
   set `remote-repository-name` and `remote-organization-name`).
3. Add `.github/workflows/cla.yml`:

   ```yaml
   name: CLA Assistant
   on:
     issue_comment:
       types: [created]
     pull_request_target:
       types: [opened, closed, synchronize]
   permissions:
     actions: write
     contents: write
     pull-requests: write
     statuses: write
   jobs:
     CLAAssistant:
       runs-on: ubuntu-latest
       steps:
         - name: CLA Assistant
           if: (github.event.comment.body == 'recheck' || github.event.comment.body == 'I have read the CLA and I agree to it.') || github.event_name == 'pull_request_target'
           uses: contributor-assistant/github-action@v2.6.1
           env:
             GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
           with:
             path-to-signatures: signatures/version1/cla.json
             path-to-document: https://github.com/ClavisPiano/clavis/blob/main/CLA.md
             branch: cla-signatures
             allowlist: <your-github-username>,dependabot[bot]
             custom-pr-sign-comment: I have read the CLA and I agree to it.
   ```

   Pin the action to a full commit SHA if you prefer, and check the README for current inputs.
   The workflow uses `pull_request_target`, so it runs the base branch's workflow with write
   access. Never check out or run code from the pull request in this workflow.

4. Settings, Branches, branch protection for `main`: add the `CLAAssistant` job as a required
   status check (it appears in the list after the first run), so an unsigned pull request cannot merge.
5. Open a test pull request from another account. It should get a bot comment asking for the
   exact sentence. Replying with it records the signature and turns the check green.
6. When `CLA.md` changes materially, bump the path to `signatures/version2/cla.json` so everyone
   re-signs. Keep the old file as the record of who agreed to which version.

## Option B: hosted CLA Assistant (cla-assistant.io)

A free hosted service run by SAP: https://cla-assistant.io. Signatures live in its database.

1. Create a secret gist containing the text of `CLA.md`. Optionally add a file named `metadata`
   to the gist to collect extra fields such as name or email.
2. Sign in to https://cla-assistant.io with GitHub and grant access to the repository.
3. Choose the repository, paste the gist URL, and link them.
4. Add the `license/cla` status check as required in the branch protection rules for `main`.
5. Contributors sign once through a link in the bot comment, with their GitHub account.

Prefer Option A while you want all records in your own repository. Choose Option B if you prefer
not to maintain a workflow. Either way, tell the maintainer's lawyer which tool you use, because
the signature record is the evidence of consent.
