# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repository Is

A GitHub **Composite Action** that tracks Next.js App Router bundle sizes across PRs using Turbopack stats. Users reference it as a step in their own workflows:

```yaml
- uses: michalsanger/nextjs-turbopack-bundle-size@v1
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

The action runs two distinct phases based on GitHub context, both within a single `action.yml`. A leading **Resolve baseline artifact name** step (runs on push and PR) slugifies the relevant ref with `slugifyBranch` and exposes the branch-scoped artifact name (`<artifact-name>-<branch>`) as a step output that both the upload and download steps consume — keeping the names identical on both sides (branch names contain `/`, which artifact names forbid).

**On push to any branch** (`if: github.event_name == 'push'`):

- Computes route gzip sizes from the stats file (`saveRouteSizes`) and uploads the result (`bundle-route-sizes.json`) under the branch-scoped artifact name. Both the compute and upload steps are `continue-on-error: true`, so a branch without valid stats does not fail unrelated CI.

**On pull request** (`if: github.event_name == 'pull_request'`):

1. Downloads the baseline artifact from the PR's **target branch** (`github.event.pull_request.base.ref`, branch-scoped name) via `dawidd6/action-download-artifact` (uses this community action because the standard `actions/download-artifact` cannot cross branches; `continue-on-error: true` handles the first-ever PR gracefully)
2. If that download fails (`steps.download-baseline.outcome == 'failure'`), a **legacy-fallback** step retries against the default branch with the unsuffixed artifact name — preserving baselines for repos upgrading from the pre-branch-scoped layout
3. Runs inline JavaScript via `actions/github-script` to parse both stat files, calculate gzip sizes, compute diffs
4. Posts/updates a sticky PR comment via `marocchino/sticky-pull-request-comment`

The `if:` conditions on composite action steps use the **caller's** event context — `github.event_name` is `pull_request` / `push`, not `workflow_call`.

## Stats Parsing Logic

All logic lives in `src/parse-stats.js` and is loaded by the `github-script` step via `require(path.join(process.env.ACTION_PATH, 'src', 'parse-stats.js'))`. `ACTION_PATH` is set via `env:` because `github.action_path` is only available as an expression, not a runtime env variable.

Exported functions:

- `slugifyBranch(ref)` — pure function; replaces any character outside `[A-Za-z0-9._-]` with `-` so a branch name is safe inside a GitHub Actions artifact name. Used by the "Resolve baseline artifact name" step on both push and PR.
- `processStats(stats, getGzipSize?)` — pure function; handles the **legacy** webpack-stats.json format (object with `assets` + `namedChunkGroups`). Filters internal chunks, sums `.js` assets only, normalizes route names (strips `app` prefix and `/page` suffix; empty string → `/`).
- `processNewStats(stats, getGzipSize?, routeGroupMap?)` — pure function; handles the **new** route-bundle-stats.json format (Next.js 16.2+). Input is an array of `{ route, firstLoadUncompressedJsBytes, firstLoadChunkPaths }`. Extracts shared chunks (present in all routes) into a `global` entry; per-route sizes exclude shared chunks.
- `buildRouteGroupMap(manifestPath)` — pure function; reads `app-paths-manifest.json` and maps clean URL routes to their route-group-prefixed paths (e.g. `/about` → `/(frontend)/about`) for the new format.
- `resolveStatsPath(statsPath)` — checks known stats file locations; falls back to `.next/diagnostics/route-bundle-stats.json` (new) or `.next/server/webpack-stats.json` (legacy).
- `parseStatsFile(statsPath, calculateGzip)` — I/O wrapper; resolves the path, reads JSON from disk (returns `{}` on a missing or unparseable file), auto-detects format (array → new, object → legacy), delegates to the appropriate processor.
- `generateReport(currentRoutes, baselineRoutes, threshold?, budgetPercentIncreaseRed?, appName?)` — pure function; builds the markdown table string.
- `formatBytes(bytes)` / `formatDiff(current, baseline, threshold?, budgetPercentIncreaseRed?)` — pure formatting helpers.
- `saveRouteSizes(statsPath, outputPath)` / `loadRouteSizes(sizesPath)` — I/O helpers; the push phase computes and writes the baseline with `saveRouteSizes`, and the PR phase reads a precomputed baseline with `loadRouteSizes`.

The `processStats`/`processNewStats`/`parseStatsFile` split keeps I/O at the boundary and makes the core logic testable without touching the filesystem.

The baseline stats are downloaded to `_bundle-baseline-stats/` in the workspace.

## Inputs

| Input                         | Default                                     | Purpose                                                         |
| ----------------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| `github-token`                | required                                    | Artifact download + PR comment                                  |
| `stats-path`                  | `.next/diagnostics/route-bundle-stats.json` | Override if build output differs; auto-detects legacy path      |
| `artifact-name`               | `turbopack-main-stats`                      | Prefix for baseline artifacts; the branch name is appended      |
| `minimum-change-threshold`    | `0`                                         | Byte threshold below which a change shows "➖ No change"        |
| `budget-percent-increase-red` | `0`                                         | % threshold; increases above show 🔴, below show 🟡             |
| `app-name`                    | `""`                                        | Report header + unique sticky-comment key (for matrix/monorepo) |
