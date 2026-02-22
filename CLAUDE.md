# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repository Is

A GitHub **Composite Action** that tracks Next.js App Router bundle sizes across PRs using Turbopack stats. Users reference it as a step in their own workflows:

```yaml
- uses: michalsanger/nextjs-turbopack-bundle-size@v3
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Commands

```bash
npm test   # run unit tests (no install needed — uses Node built-in test runner)
```

## File Structure

- `action.yml` — the action definition (root is required by GitHub)
- `src/parse-stats.js` — all parsing, formatting, and report generation logic
- `src/parse-stats.test.js` — unit tests for the above
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

All logic lives in `src/parse-stats.js` and is loaded by the `github-script` step via `require(path.join(process.env.ACTION_PATH, 'src', 'parse-stats.js'))`. `ACTION_PATH` is set via `env:` because `github.action_path` is only available as an expression, not a runtime env variable.

Exported functions:

- `processStats(stats, getGzipSize?)` — pure function; takes a parsed stats object and an optional gzip-size callback; returns a routes map. Filters internal chunks, sums `.js` assets only, normalizes route names (strips `app` prefix and `/page` suffix; empty string → `/`).
- `parseStatsFile(statsPath, calculateGzip)` — I/O wrapper; reads JSON from disk, builds the `getGzipSize` callback using `zlib.gzipSync`, delegates to `processStats`.
- `generateReport(currentRoutes, baselineRoutes)` — pure function; builds the markdown table string.
- `formatBytes(bytes)` / `formatDiff(current, baseline)` — pure formatting helpers.

The `processStats`/`parseStatsFile` split keeps I/O at the boundary and makes the core logic testable without touching the filesystem.

The baseline stats are downloaded to `_bundle-baseline-stats/` in the workspace.

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `github-token` | required | Artifact download + PR comment |
| `stats-path` | `.next/server/webpack-stats.json` | Override if build output differs |
| `artifact-name` | `turbopack-main-stats` | Override to avoid name collisions |
| `budget-percent-increase-red` | `0` | % threshold; increases above show 🔴, below show 🟡 |
