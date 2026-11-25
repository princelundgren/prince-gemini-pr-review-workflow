# prince-gemini-pr-review-workflow — instructions for agents

This repository is public: everything in it, its commits and its pull requests are public. Write
nothing about the maintainer's own machines, accounts, private repositories or employer.

- **Tests:** `npm ci && node --test && npx tsc --noEmit -p .`
- **The prompt's shared sections** come from `review-prompt.md` in
  `princelundgren/prince-claude-pr-review-workflow`, at a pinned commit SHA.
- **The review lives in the `review` action**, and `gemini-review.yml` runs it on a hosted runner.
  The workflow pins the action by commit SHA, since a called workflow's checkout is the caller's
  repository, so a `./` path would point into it. A change to `.github/actions/review/` lands in
  its own commit, and a second commit moves the pin to it. Pull requests merge with a merge
  commit, so the pinned commit stays on `main`.
- **Lint** with `actionlint`, and shellcheck the action's `run:` blocks as `lint.yml` does, since
  actionlint skips a composite action's steps.
