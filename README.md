# Next.js Turbopack Bundle Size

A GitHub Action that tracks Next.js App Router bundle sizes across pull requests. It stores a baseline on the `main` branch and posts a route-by-route size comparison comment on every PR.

## Usage

```yaml
- name: Analyze bundle sizes
  uses: michalsanger/nextjs-turbopack-bundle-size@v2
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

The action must run **after** the app has been built with `TURBOPACK_STATS=1`. See [`examples/usage.yml`](examples/usage.yml) for a complete workflow.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | Yes | — | GitHub token for downloading baseline artifact and posting PR comments |
| `stats-path` | No | `.next/server/webpack-stats.json` | Path to the Turbopack stats file |
| `artifact-name` | No | `turbopack-main-stats` | Artifact name for storing the baseline stats |
| `minimum-change-threshold` | No | `0` | Byte threshold below which a size change is considered unchanged. For example, `500` means changes of 500 B or less are shown as "➖ No change". |

## Required Permissions

```yaml
permissions:
  contents: read
  pull-requests: write
  actions: read
```

## How It Works

- **On push to `main`**: uploads `.next/server/webpack-stats.json` as a GitHub Actions artifact (the baseline).
- **On pull request**: downloads the baseline artifact, parses both stat files, calculates gzip sizes for each route, and posts (or updates) a sticky comment with a comparison table.

The first PR before any baseline exists will show all routes as "🆕 New" — this is expected.
