'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { formatBytes, formatDiff, processStats, processNewStats, buildRouteGroupMap, generateReport } = require('./parse-stats.js');

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
    assert.equal(formatDiff(512, 1024), '🟢 `-512 B`');
  });

  test('shows red for increase', () => {
    assert.equal(formatDiff(1024, 512), '🔴 `+512 B`');
  });

  test('shows No change when diff is below threshold', () => {
    assert.equal(formatDiff(1300, 1000, 500), '➖ No change');
  });

  test('shows No change when diff equals threshold', () => {
    assert.equal(formatDiff(1500, 1000, 500), '➖ No change');
  });

  test('shows diff when diff exceeds threshold', () => {
    assert.equal(formatDiff(1501, 1000, 500), '🔴 `+501 B`');
  });

  test('shows yellow when increase is below budget-percent-increase-red', () => {
    // 10% increase (100 out of 1000), budget is 20%
    assert.equal(formatDiff(1100, 1000, 0, 20), '🟡 `+100 B`');
  });

  test('shows red when increase exceeds budget-percent-increase-red', () => {
    // 30% increase (300 out of 1000), budget is 20%
    assert.equal(formatDiff(1300, 1000, 0, 20), '🔴 `+300 B`');
  });

  test('shows red when increase equals budget-percent-increase-red', () => {
    // 20% increase (200 out of 1000), budget is 20% — equal means not exceeding
    assert.equal(formatDiff(1200, 1000, 0, 20), '🟡 `+200 B`');
  });

  test('shows red for all increases when budget-percent-increase-red is 0 (default)', () => {
    assert.equal(formatDiff(1001, 1000, 0, 0), '🔴 `+1 B`');
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

  test('aggregates internal chunks into global entry', () => {
    const stats = makeStats({
      webpack: { assets: [{ name: 'webpack.js' }] },
      'main-app': { assets: [{ name: 'main-app.js' }] },
      main: { assets: [{ name: 'main.js' }] },
      polyfills: { assets: [{ name: 'polyfills.js' }] },
      'react-refresh': { assets: [{ name: 'react-refresh.js' }] },
      'edge-wrapper': { assets: [{ name: 'edge-wrapper.js' }] },
    }, [
      { name: 'webpack.js', size: 1000 },
      { name: 'main-app.js', size: 2000 },
      { name: 'main.js', size: 1500 },
      { name: 'polyfills.js', size: 500 },
      { name: 'react-refresh.js', size: 800 },
      { name: 'edge-wrapper.js', size: 700 },
    ]);
    const routes = processStats(stats, () => 100);
    assert.deepEqual(Object.keys(routes), ['global']);
    assert.equal(routes['global'].gzip, 600); // 6 chunks × 100
  });

  test('does not create global entry when internal chunks have no JS assets', () => {
    const stats = makeStats({
      webpack: { assets: [{ name: 'webpack.css' }] },
    }, [
      { name: 'webpack.css', size: 1000 },
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
// processNewStats (Next.js 16.2+ route-bundle-stats.json format)
// ---------------------------------------------------------------------------

function makeNewStats(routes) {
  return routes.map(([route, bytes, chunks]) => ({
    route,
    firstLoadUncompressedJsBytes: bytes,
    firstLoadChunkPaths: chunks,
  }));
}

describe('processNewStats', () => {
  test('returns empty object for empty array', () => {
    assert.deepEqual(processNewStats([]), {});
  });

  test('returns empty object for non-array', () => {
    assert.deepEqual(processNewStats({}), {});
  });

  test('extracts routes with gzip sizes', () => {
    const stats = makeNewStats([
      ['/', 1000, ['shared.js', 'home.js']],
      ['/about', 2000, ['shared.js', 'about.js']],
    ]);
    const routes = processNewStats(stats, () => 100);
    assert.ok('/' in routes);
    assert.ok('/about' in routes);
  });

  test('computes shared chunks as global entry', () => {
    const stats = makeNewStats([
      ['/', 1000, ['shared.js', 'framework.js', 'home.js']],
      ['/about', 2000, ['shared.js', 'framework.js', 'about.js']],
    ]);
    const routes = processNewStats(stats, () => 100);
    // shared.js + framework.js are shared → global = 200
    assert.equal(routes['global'].gzip, 200);
    // home.js is route-specific → / = 100
    assert.equal(routes['/'].gzip, 100);
    // about.js is route-specific → /about = 100
    assert.equal(routes['/about'].gzip, 100);
  });

  test('no global entry when getGzipSize is null', () => {
    const stats = makeNewStats([
      ['/', 1000, ['shared.js', 'home.js']],
      ['/about', 2000, ['shared.js', 'about.js']],
    ]);
    const routes = processNewStats(stats);
    assert.ok(!('global' in routes));
  });

  test('skips routes with zero bytes', () => {
    const stats = makeNewStats([
      ['/', 1000, ['shared.js']],
      ['/empty', 0, ['shared.js']],
    ]);
    const routes = processNewStats(stats, () => 100);
    assert.ok(!('/empty' in routes));
  });

  test('ignores non-JS chunk paths', () => {
    const stats = makeNewStats([
      ['/', 1000, ['shared.js', 'styles.css', 'home.js']],
      ['/about', 2000, ['shared.js', 'styles.css', 'about.js']],
    ]);
    const calls = [];
    const getGzipSize = (name) => { calls.push(name); return 100; };
    processNewStats(stats, getGzipSize);
    assert.ok(!calls.includes('styles.css'));
  });

  test('route names are used as-is when no routeGroupMap', () => {
    const stats = makeNewStats([
      ['/holdings/[id]', 5000, ['shared.js', 'holdings.js']],
      ['/login/[[...rest]]', 3000, ['shared.js', 'login.js']],
    ]);
    const routes = processNewStats(stats, () => 100);
    assert.ok('/holdings/[id]' in routes);
    assert.ok('/login/[[...rest]]' in routes);
  });

  test('restores route group prefixes from routeGroupMap', () => {
    const stats = makeNewStats([
      ['/book-session/[hash]', 5000, ['shared.js', 'book.js']],
      ['/admin/orders', 3000, ['shared.js', 'orders.js']],
    ]);
    const routeGroupMap = {
      '/book-session/[hash]': '/(frontend)/book-session/[hash]',
      '/admin/orders': '/(admin)/admin/orders',
    };
    const routes = processNewStats(stats, () => 100, routeGroupMap);
    assert.ok('/(frontend)/book-session/[hash]' in routes);
    assert.ok('/(admin)/admin/orders' in routes);
    assert.ok(!('/book-session/[hash]' in routes));
    assert.ok(!('/admin/orders' in routes));
  });

  test('leaves routes without routeGroupMap entry unchanged', () => {
    const stats = makeNewStats([
      ['/about', 2000, ['shared.js', 'about.js']],
      ['/admin/orders', 3000, ['shared.js', 'orders.js']],
    ]);
    const routeGroupMap = {
      '/admin/orders': '/(admin)/admin/orders',
    };
    const routes = processNewStats(stats, () => 100, routeGroupMap);
    assert.ok('/about' in routes);
    assert.ok('/(admin)/admin/orders' in routes);
  });

  test('single route: all chunks are shared, route is filtered out', () => {
    const stats = makeNewStats([
      ['/', 1000, ['a.js', 'b.js']],
    ]);
    // With only one route, all chunks are "shared" (present in all routes)
    const routes = processNewStats(stats, () => 100);
    assert.equal(routes['global'].gzip, 200);
    assert.ok(!('/' in routes), 'route with 0 gzip should be filtered out');
  });

  test('skips entries without route name', () => {
    const stats = [
      { firstLoadUncompressedJsBytes: 1000, firstLoadChunkPaths: ['a.js'] },
    ];
    const routes = processNewStats(stats, () => 100);
    assert.ok(!('undefined' in routes));
  });
});

// ---------------------------------------------------------------------------
// buildRouteGroupMap
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

describe('buildRouteGroupMap', () => {
  const tmpDir = path.join(process.env.TMPDIR || '/tmp', 'parse-stats-test');

  test('returns empty object when manifest does not exist', () => {
    assert.deepEqual(buildRouteGroupMap('/nonexistent/path.json'), {});
  });

  test('builds map from manifest with route groups', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const manifestPath = path.join(tmpDir, 'app-paths-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      '/(admin)/admin/orders/page': 'app/(admin)/admin/orders/page.js',
      '/(frontend)/book-session/[hash]/page': 'app/(frontend)/book-session/[hash]/page.js',
      '/about/page': 'app/about/page.js',
      '/api/admin/auth/route': 'app/api/admin/auth/route.js',
    }));
    const map = buildRouteGroupMap(manifestPath);
    assert.equal(map['/admin/orders'], '/(admin)/admin/orders');
    assert.equal(map['/book-session/[hash]'], '/(frontend)/book-session/[hash]');
    assert.ok(!('/about' in map), 'routes without groups should not appear');
    assert.ok(!('/api/admin/auth' in map), 'API routes should not appear');
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('handles nested route groups', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const manifestPath = path.join(tmpDir, 'app-paths-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      '/(marketing)/(landing)/pricing/page': 'app/(marketing)/(landing)/pricing/page.js',
    }));
    const map = buildRouteGroupMap(manifestPath);
    assert.equal(map['/pricing'], '/(marketing)/(landing)/pricing');
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('maps root route group to /', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const manifestPath = path.join(tmpDir, 'app-paths-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      '/(frontend)/page': 'app/(frontend)/page.js',
    }));
    const map = buildRouteGroupMap(manifestPath);
    assert.equal(map['/'], '/(frontend)');
    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// generateReport
// ---------------------------------------------------------------------------

describe('generateReport', () => {
  test('includes header rows when there are changes', () => {
    const report = generateReport({ '/': { gzip: 512 } }, {});
    assert.ok(report.includes('## 📦 Next.js App Router Sizes (Turbopack)'));
    assert.ok(report.includes('| Route | Size (gzipped) | First load | Diff (vs baseline) |'));
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
    const routes = { 'global': { gzip: 5000 }, '/': { gzip: 1024 }, '/about': { gzip: 2048 } };
    assert.equal(
      generateReport(routes, routes),
      REPORT_HEADER +
        'This PR introduced no changes to the JavaScript bundle! 🙌\n',
    );
  });

  test('new route without baseline', () => {
    assert.equal(
      generateReport({ 'global': { gzip: 5000 }, '/': { gzip: 512 } }, {}),
      REPORT_HEADER +
        '| Route | Size (gzipped) | First load | Diff (vs baseline) |\n' +
        '|---|---|---|---|\n' +
        '| `global` | `4.88 KB` | — | 🆕 New |\n' +
        '| `/` | `512 B` | `5.38 KB` | 🆕 New |\n',
    );
  });

  test('removed route', () => {
    assert.equal(
      generateReport({}, { '/old': { gzip: 500 } }),
      REPORT_HEADER +
        '| Route | Size (gzipped) | First load | Diff (vs baseline) |\n' +
        '|---|---|---|---|\n' +
        '| `/old` | — | — | 🗑️ Removed |\n',
    );
  });

  test('size increase', () => {
    assert.equal(
      generateReport(
        { 'global': { gzip: 5000 }, '/': { gzip: 1536 } },
        { 'global': { gzip: 5000 }, '/': { gzip: 1024 } },
      ),
      REPORT_HEADER +
        '| Route | Size (gzipped) | First load | Diff (vs baseline) |\n' +
        '|---|---|---|---|\n' +
        '| `/` | `1.5 KB` | `6.38 KB` | 🔴 `+512 B` |\n',
    );
  });

  test('size decrease', () => {
    assert.equal(
      generateReport(
        { 'global': { gzip: 5000 }, '/': { gzip: 512 } },
        { 'global': { gzip: 5000 }, '/': { gzip: 1024 } },
      ),
      REPORT_HEADER +
        '| Route | Size (gzipped) | First load | Diff (vs baseline) |\n' +
        '|---|---|---|---|\n' +
        '| `/` | `512 B` | `5.38 KB` | 🟢 `-512 B` |\n',
    );
  });

  test('mixed: new, removed, increased, decreased, and unchanged routes', () => {
    const current = {
      'global': { gzip: 5120 },  // increased from 5000
      '/': { gzip: 1024 },       // unchanged
      '/about': { gzip: 2048 },  // increased from 1024
      '/blog': { gzip: 512 },    // decreased from 1024
      '/new': { gzip: 256 },     // new
    };
    const baseline = {
      'global': { gzip: 5000 },
      '/': { gzip: 1024 },       // unchanged
      '/about': { gzip: 1024 },
      '/blog': { gzip: 1024 },
      '/gone': { gzip: 500 },    // removed
    };
    assert.equal(
      generateReport(current, baseline),
      REPORT_HEADER +
        '| Route | Size (gzipped) | First load | Diff (vs baseline) |\n' +
        '|---|---|---|---|\n' +
        '| `global` | `5 KB` | — | 🔴 `+120 B` |\n' +
        '| `/about` | `2 KB` | `7 KB` | 🔴 `+1 KB` |\n' +
        '| `/blog` | `512 B` | `5.5 KB` | 🟢 `-512 B` |\n' +
        '| `/gone` | — | — | 🗑️ Removed |\n' +
        '| `/new` | `256 B` | `5.25 KB` | 🆕 New |\n',
    );
  });

  test('threshold hides small changes, shows large ones', () => {
    const current = {
      'global': { gzip: 5100 },  // +100, within threshold
      '/small': { gzip: 1300 },  // +300, within threshold
      '/large': { gzip: 2024 },  // +1000, exceeds threshold
    };
    const baseline = {
      'global': { gzip: 5000 },
      '/small': { gzip: 1000 },
      '/large': { gzip: 1024 },
    };
    assert.equal(
      generateReport(current, baseline, 500),
      REPORT_HEADER +
        '| Route | Size (gzipped) | First load | Diff (vs baseline) |\n' +
        '|---|---|---|---|\n' +
        '| `/large` | `1.98 KB` | `6.96 KB` | 🔴 `+1000 B` |\n',
    );
  });

  test('budget-percent-increase-red: yellow for small increase, red for large', () => {
    const current = {
      'global': { gzip: 5000 },  // unchanged
      '/minor': { gzip: 1100 },  // +10%, below 20% budget
      '/major': { gzip: 1500 },  // +50%, above 20% budget
    };
    const baseline = {
      'global': { gzip: 5000 },
      '/minor': { gzip: 1000 },
      '/major': { gzip: 1000 },
    };
    assert.equal(
      generateReport(current, baseline, 0, 20),
      REPORT_HEADER +
        '| Route | Size (gzipped) | First load | Diff (vs baseline) |\n' +
        '|---|---|---|---|\n' +
        '| `/major` | `1.46 KB` | `6.35 KB` | 🔴 `+500 B` |\n' +
        '| `/minor` | `1.07 KB` | `5.96 KB` | 🟡 `+100 B` |\n',
    );
  });

  test('all changes below threshold results in no-change message', () => {
    const current = { 'global': { gzip: 5050 }, '/': { gzip: 1100 }, '/about': { gzip: 2100 } };
    const baseline = { 'global': { gzip: 5000 }, '/': { gzip: 1000 }, '/about': { gzip: 2000 } };
    assert.equal(
      generateReport(current, baseline, 500),
      REPORT_HEADER +
        'This PR introduced no changes to the JavaScript bundle! 🙌\n',
    );
  });
});
