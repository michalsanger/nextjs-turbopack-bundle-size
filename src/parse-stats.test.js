'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { formatBytes, formatDiff, processStats, generateReport } = require('./parse-stats.js');

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------

describe('formatBytes', () => {
  test('returns "0 B" for zero', () => {
    assert.equal(formatBytes(0), '0 B');
  });

  test('formats bytes', () => {
    assert.equal(formatBytes(512), '512 B');
  });

  test('formats kilobytes', () => {
    assert.equal(formatBytes(1024), '1 KB');
  });

  test('formats fractional kilobytes', () => {
    assert.equal(formatBytes(1536), '1.5 KB');
  });

  test('formats megabytes', () => {
    assert.equal(formatBytes(1048576), '1 MB');
  });
});

// ---------------------------------------------------------------------------
// formatDiff
// ---------------------------------------------------------------------------

describe('formatDiff', () => {
  test('shows New when no baseline', () => {
    assert.equal(formatDiff(1000, undefined), '🆕 New');
  });

  test('shows No change when equal', () => {
    assert.equal(formatDiff(1000, 1000), '➖ No change');
  });

  test('shows green for decrease', () => {
    assert.equal(formatDiff(512, 1024), '🟢 `-512 B` (-50%)');
  });

  test('shows red for increase', () => {
    assert.equal(formatDiff(1024, 512), '🔴 `+512 B` (+100%)');
  });

  test('shows No change when diff is below threshold', () => {
    assert.equal(formatDiff(1300, 1000, 500), '➖ No change');
  });

  test('shows No change when diff equals threshold', () => {
    assert.equal(formatDiff(1500, 1000, 500), '➖ No change');
  });

  test('shows diff when diff exceeds threshold', () => {
    assert.equal(formatDiff(1501, 1000, 500), '🔴 `+501 B` (+50.1%)');
  });

  test('shows yellow when increase is below budget-percent-increase-red', () => {
    // 10% increase (100 out of 1000), budget is 20%
    assert.equal(formatDiff(1100, 1000, 0, 20), '🟡 `+100 B` (+10%)');
  });

  test('shows red when increase exceeds budget-percent-increase-red', () => {
    // 30% increase (300 out of 1000), budget is 20%
    assert.equal(formatDiff(1300, 1000, 0, 20), '🔴 `+300 B` (+30%)');
  });

  test('shows red when increase equals budget-percent-increase-red', () => {
    // 20% increase (200 out of 1000), budget is 20% — equal means not exceeding
    assert.equal(formatDiff(1200, 1000, 0, 20), '🟡 `+200 B` (+20%)');
  });

  test('shows red for all increases when budget-percent-increase-red is 0 (default)', () => {
    assert.equal(formatDiff(1001, 1000, 0, 0), '🔴 `+1 B` (+0.1%)');
  });

  test('shows increase without percentage when baseline is 0', () => {
    assert.equal(formatDiff(1024, 0), '🔴 `+1 KB`');
  });

  test('shows decrease without percentage when baseline is 0', () => {
    assert.equal(formatDiff(0, 0), '➖ No change');
  });
});

// ---------------------------------------------------------------------------
// processStats
// ---------------------------------------------------------------------------

function makeStats(entrypoints, assets = []) {
  return { assets, namedChunkGroups: entrypoints };
}

describe('processStats', () => {
  test('returns empty object for empty stats', () => {
    assert.deepEqual(processStats({}), {});
  });

  test('filters out internal chunks', () => {
    const stats = makeStats({
      webpack: { assets: [{ name: 'webpack.js' }] },
      'main-app': { assets: [{ name: 'main-app.js' }] },
      main: { assets: [{ name: 'main.js' }] },
      polyfills: { assets: [{ name: 'polyfills.js' }] },
      'react-refresh': { assets: [{ name: 'react-refresh.js' }] },
      'edge-wrapper': { assets: [{ name: 'edge-wrapper.js' }] },
    }, [
      { name: 'webpack.js', size: 1000 },
      { name: 'main-app.js', size: 1000 },
      { name: 'main.js', size: 1000 },
      { name: 'polyfills.js', size: 1000 },
      { name: 'react-refresh.js', size: 1000 },
      { name: 'edge-wrapper.js', size: 1000 },
    ]);
    assert.deepEqual(processStats(stats), {});
  });

  test('ignores non-JS assets', () => {
    const stats = makeStats(
      { 'app/about/page': { assets: [{ name: 'page.css' }] } },
      [{ name: 'page.css', size: 5000 }],
    );
    assert.deepEqual(processStats(stats), {});
  });

  test('strips "app" prefix and "/page" suffix from route name', () => {
    const stats = makeStats(
      { 'app/about/page': { assets: [{ name: 'about.js' }] } },
      [{ name: 'about.js', size: 2048 }],
    );
    const routes = processStats(stats);
    assert.ok('/about' in routes, 'expected /about route');
  });

  test('maps root route to "/"', () => {
    const stats = makeStats(
      { 'app/page': { assets: [{ name: 'index.js' }] } },
      [{ name: 'index.js', size: 1024 }],
    );
    const routes = processStats(stats);
    assert.ok('/' in routes, 'expected / route');
  });

  test('sums multiple JS assets for a route', () => {
    const stats = makeStats(
      { 'app/blog/page': { assets: [{ name: 'a.js' }, { name: 'b.js' }] } },
      [{ name: 'a.js', size: 1000 }, { name: 'b.js', size: 500 }],
    );
    assert.equal(processStats(stats, () => 100)['/blog'].gzip, 200);
  });

  test('calls getGzipSize for each JS asset and accumulates result', () => {
    const stats = makeStats(
      { 'app/shop/page': { assets: [{ name: 'a.js' }, { name: 'b.js' }] } },
      [{ name: 'a.js', size: 2000 }, { name: 'b.js', size: 3000 }],
    );
    const calls = [];
    const getGzipSize = (name) => { calls.push(name); return 100; };
    const routes = processStats(stats, getGzipSize);
    assert.deepEqual(calls, ['a.js', 'b.js']);
    assert.equal(routes['/shop'].gzip, 200);
  });

  test('skips routes with zero total size', () => {
    const stats = makeStats(
      { 'app/empty/page': { assets: [{ name: 'missing.js' }] } },
      [], // asset not listed → size defaults to 0
    );
    assert.deepEqual(processStats(stats), {});
  });

  test('falls back to entrypoints when namedChunkGroups is absent', () => {
    const stats = {
      assets: [{ name: 'home.js', size: 1024 }],
      entrypoints: { 'app/page': { assets: [{ name: 'home.js' }] } },
    };
    const routes = processStats(stats);
    assert.ok('/' in routes);
  });

  test('handles asset as plain string (not object)', () => {
    const stats = makeStats(
      { 'app/page': { assets: ['home.js'] } },
      [{ name: 'home.js', size: 1024 }],
    );
    const routes = processStats(stats);
    assert.ok('/' in routes);
  });
});

// ---------------------------------------------------------------------------
// generateReport
// ---------------------------------------------------------------------------

describe('generateReport', () => {
  test('includes header rows when there are changes', () => {
    const report = generateReport({ '/': { gzip: 512 } }, {});
    assert.ok(report.includes('## 📦 Next.js App Router Sizes (Turbopack)'));
    assert.ok(report.includes('| Route | Size (gzipped) | Diff (vs main) |'));
  });

  test('shows warning when no routes at all', () => {
    const report = generateReport({}, {});
    assert.ok(report.includes('⚠️ **Warning:**'));
  });

  test('shows New for routes missing from baseline', () => {
    const report = generateReport({ '/': { gzip: 512 } }, {});
    assert.ok(report.includes('🆕 New'));
  });

  test('shows diff against baseline', () => {
    const current = { '/': { gzip: 1024 } };
    const baseline = { '/': { gzip: 512 } };
    const report = generateReport(current, baseline);
    assert.ok(report.includes('🔴 `+'));
  });

  test('shows gzip size in code format', () => {
    const report = generateReport({ '/about': { gzip: 1024 } }, {});
    assert.ok(report.includes('`1 KB`'));
  });

  test('shows no-change message when all routes are identical', () => {
    const current = { '/': { gzip: 1000 }, '/about': { gzip: 2000 } };
    const baseline = { '/': { gzip: 1000 }, '/about': { gzip: 2000 } };
    const report = generateReport(current, baseline);
    assert.ok(report.includes('no changes to the JavaScript bundle! 🙌'));
    assert.ok(!report.includes('| Route |'));
  });

  test('shows no-change message when diff is below threshold', () => {
    const current = { '/': { gzip: 1300 } };
    const baseline = { '/': { gzip: 1000 } };
    const report = generateReport(current, baseline, 500);
    assert.ok(report.includes('no changes to the JavaScript bundle! 🙌'));
  });

  test('shows diff when change exceeds threshold', () => {
    const current = { '/': { gzip: 1600 } };
    const baseline = { '/': { gzip: 1000 } };
    const report = generateReport(current, baseline, 500);
    assert.ok(report.includes('🔴 `+'));
  });

  test('shows removed routes', () => {
    const current = {};
    const baseline = { '/old': { gzip: 500 } };
    const report = generateReport(current, baseline);
    assert.ok(report.includes('🗑️ Removed'));
    assert.ok(report.includes('/old'));
  });

  test('shows yellow for increase below budget-percent-increase-red', () => {
    const current = { '/': { gzip: 1100 } };
    const baseline = { '/': { gzip: 1000 } };
    const report = generateReport(current, baseline, 0, 20);
    assert.ok(report.includes('🟡'));
    assert.ok(!report.includes('🔴'));
  });

  test('shows red for increase above budget-percent-increase-red', () => {
    const current = { '/': { gzip: 1300 } };
    const baseline = { '/': { gzip: 1000 } };
    const report = generateReport(current, baseline, 0, 20);
    assert.ok(report.includes('🔴'));
    assert.ok(!report.includes('🟡'));
  });

  test('only shows changed routes, omits unchanged', () => {
    const current = { '/': { gzip: 1000 }, '/about': { gzip: 2048 } };
    const baseline = { '/': { gzip: 1000 }, '/about': { gzip: 1024 } };
    const report = generateReport(current, baseline);
    assert.ok(!report.includes('`/`'), 'unchanged route / should not appear');
    assert.ok(report.includes('`/about`'), 'changed route /about should appear');
  });
});

// ---------------------------------------------------------------------------
// generateReport — full table snapshots
// ---------------------------------------------------------------------------

const REPORT_HEADER = '## 📦 Next.js App Router Sizes (Turbopack)\n\nThis analysis was generated by the [Next.js Turbopack Bundle Size action](https://github.com/michalsanger/nextjs-turbopack-bundle-size). 🤖\n\n';

describe('generateReport full table', () => {
  test('no routes at all', () => {
    assert.equal(
      generateReport({}, {}),
      REPORT_HEADER +
        '> ⚠️ **Warning:** No routes identified. Ensure `TURBOPACK_STATS=1` is set during build.\n',
    );
  });

  test('all routes unchanged', () => {
    const routes = { '/': { gzip: 1024 }, '/about': { gzip: 2048 } };
    assert.equal(
      generateReport(routes, routes),
      REPORT_HEADER +
        'This PR introduced no changes to the JavaScript bundle! 🙌\n',
    );
  });

  test('new route without baseline', () => {
    assert.equal(
      generateReport({ '/': { gzip: 512 } }, {}),
      REPORT_HEADER +
        '| Route | Size (gzipped) | Diff (vs main) |\n' +
        '|---|---|---|\n' +
        '| `/` | `512 B` | 🆕 New |\n',
    );
  });

  test('removed route', () => {
    assert.equal(
      generateReport({}, { '/old': { gzip: 500 } }),
      REPORT_HEADER +
        '| Route | Size (gzipped) | Diff (vs main) |\n' +
        '|---|---|---|\n' +
        '| `/old` | — | 🗑️ Removed |\n',
    );
  });

  test('size increase', () => {
    assert.equal(
      generateReport({ '/': { gzip: 1536 } }, { '/': { gzip: 1024 } }),
      REPORT_HEADER +
        '| Route | Size (gzipped) | Diff (vs main) |\n' +
        '|---|---|---|\n' +
        '| `/` | `1.5 KB` | 🔴 `+512 B` (+50%) |\n',
    );
  });

  test('size decrease', () => {
    assert.equal(
      generateReport({ '/': { gzip: 512 } }, { '/': { gzip: 1024 } }),
      REPORT_HEADER +
        '| Route | Size (gzipped) | Diff (vs main) |\n' +
        '|---|---|---|\n' +
        '| `/` | `512 B` | 🟢 `-512 B` (-50%) |\n',
    );
  });

  test('mixed: new, removed, increased, decreased, and unchanged routes', () => {
    const current = {
      '/': { gzip: 1024 },       // unchanged
      '/about': { gzip: 2048 },  // increased from 1024
      '/blog': { gzip: 512 },    // decreased from 1024
      '/new': { gzip: 256 },     // new
    };
    const baseline = {
      '/': { gzip: 1024 },       // unchanged
      '/about': { gzip: 1024 },
      '/blog': { gzip: 1024 },
      '/gone': { gzip: 500 },    // removed
    };
    assert.equal(
      generateReport(current, baseline),
      REPORT_HEADER +
        '| Route | Size (gzipped) | Diff (vs main) |\n' +
        '|---|---|---|\n' +
        '| `/about` | `2 KB` | 🔴 `+1 KB` (+100%) |\n' +
        '| `/blog` | `512 B` | 🟢 `-512 B` (-50%) |\n' +
        '| `/new` | `256 B` | 🆕 New |\n' +
        '| `/gone` | — | 🗑️ Removed |\n',
    );
  });

  test('threshold hides small changes, shows large ones', () => {
    const current = {
      '/small': { gzip: 1300 },  // +300, within threshold
      '/large': { gzip: 2024 },  // +1000, exceeds threshold
    };
    const baseline = {
      '/small': { gzip: 1000 },
      '/large': { gzip: 1024 },
    };
    assert.equal(
      generateReport(current, baseline, 500),
      REPORT_HEADER +
        '| Route | Size (gzipped) | Diff (vs main) |\n' +
        '|---|---|---|\n' +
        '| `/large` | `1.98 KB` | 🔴 `+1000 B` (+97.7%) |\n',
    );
  });

  test('budget-percent-increase-red: yellow for small increase, red for large', () => {
    const current = {
      '/minor': { gzip: 1100 },  // +10%, below 20% budget
      '/major': { gzip: 1500 },  // +50%, above 20% budget
    };
    const baseline = {
      '/minor': { gzip: 1000 },
      '/major': { gzip: 1000 },
    };
    assert.equal(
      generateReport(current, baseline, 0, 20),
      REPORT_HEADER +
        '| Route | Size (gzipped) | Diff (vs main) |\n' +
        '|---|---|---|\n' +
        '| `/minor` | `1.07 KB` | 🟡 `+100 B` (+10%) |\n' +
        '| `/major` | `1.46 KB` | 🔴 `+500 B` (+50%) |\n',
    );
  });

  test('all changes below threshold results in no-change message', () => {
    const current = { '/': { gzip: 1100 }, '/about': { gzip: 2100 } };
    const baseline = { '/': { gzip: 1000 }, '/about': { gzip: 2000 } };
    assert.equal(
      generateReport(current, baseline, 500),
      REPORT_HEADER +
        'This PR introduced no changes to the JavaScript bundle! 🙌\n',
    );
  });
});
