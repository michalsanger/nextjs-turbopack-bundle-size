# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repository Is

A GitHub **Composite Action** that tracks Next.js App Router bundle sizes across PRs using Turbopack stats. Users reference it as a step in their own workflows:

```yaml
- uses: michalsanger/nextjs-turbopack-bundle-size@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

## File Structure

- `action.yml` — the action definition (root is required by GitHub)
- `examples/usage.yml` — a complete example workflow for consuming repos
- `README.md` — usage docs including inputs and permissions

## Action Architecture

The action runs two distinct phases based on GitHub context, both within a single `action.yml`:

**On push to `main`** (`if: github.ref == 'refs/heads/main'`):
- Uploads `.next/server/webpack-stats.json` as artifact `turbopack-main-stats`

**On pull request** (`if: github.event_name == 'pull_request'`):
1. Downloads the baseline artifact from `main` via `dawidd6/action-download-artifact` (uses this community action because the standard `actions/download-artifact` cannot cross branches; `continue-on-error: true` handles the first-ever PR gracefully)
2. Runs inline JavaScript via `actions/github-script` to parse both stat files, calculate gzip sizes, compute diffs
3. Posts/updates a sticky PR comment via `marocchino/sticky-pull-request-comment`

The `if:` conditions on composite action steps use the **caller's** event context — `github.event_name` is `pull_request` / `push`, not `workflow_call`.

## Stats Parsing Logic

The inline JS in the `github-script` step:

- Reads `stats.namedChunkGroups` (falling back to `stats.entrypoints`) for route entrypoints
- Filters out internal chunks: `webpack`, `main-app`, `main`, `polyfills`, `react-refresh`, `edge-wrapper`
- Sums `.js` assets only per route
- Gzip-calculates current build by reading files from disk with `zlib.gzipSync`; baseline only needs raw sizes
- Normalizes route names: strips `app` prefix and `/page` suffix; empty string → `/`
- Writes `bundle-report.md` to workspace root, picked up by the comment step

The baseline stats are downloaded to `_bundle-baseline-stats/` in the workspace.

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `github-token` | required | Artifact download + PR comment |
| `stats-path` | `.next/server/webpack-stats.json` | Override if build output differs |
| `artifact-name` | `turbopack-main-stats` | Override to avoid name collisions |
