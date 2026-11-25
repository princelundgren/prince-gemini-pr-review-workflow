# prince-gemini-pr-review-workflow

[![Lint workflows](https://github.com/princelundgren/prince-gemini-pr-review-workflow/actions/workflows/lint.yml/badge.svg)](https://github.com/princelundgren/prince-gemini-pr-review-workflow/actions/workflows/lint.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A GitHub Actions workflow in which Gemini reviews a pull request with the same prompt as
[`prince-claude-pr-review-workflow`](https://github.com/princelundgren/prince-claude-pr-review-workflow)
and posts one comment review.

**Status: in development.** The action lands in the next release.

## How to call

Call the workflow from a pull request workflow of your own, granting `id-token: write` and passing
`CI_SECRETS_AWS_ACCOUNT`:

```yaml
name: Gemini review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

permissions: {}

# A person's new push cancels the review still running, so only the latest commit is reviewed. An
# event a bot sends gets a group of its own, so it can't cancel a review: the called job skips it.
concurrency:
  group: gemini-review-${{ github.event.pull_request.number }}${{ github.event.sender.type != 'User' && format('-{0}', github.run_id) || '' }}
  cancel-in-progress: true

jobs:
  review:
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    uses: princelundgren/prince-gemini-pr-review-workflow/.github/workflows/gemini-review.yml@v1
    secrets:
      CI_SECRETS_AWS_ACCOUNT: ${{ secrets.CI_SECRETS_AWS_ACCOUNT }}
```

It runs beside the Claude review and needs the `CI_SECRETS_AWS_ACCOUNT` secret and a reader role
that trusts the calling repository.

## License

[MIT](LICENSE)
