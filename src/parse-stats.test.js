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
    assert.equal(formatDiff(512, 1024), '🟢 512 B');
  });

  test('shows red for increase', () => {
    assert.equal(formatDiff(1024, 512), '🔴 +512 B');
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
  test('includes header rows', () => {
    const report = generateReport({ '/': { gzip: 512 } }, {});
    assert.ok(report.includes('### 📦 Next.js App Router Sizes (Turbopack)'));
    assert.ok(report.includes('| Route | Size (gzipped) | Diff (vs main) |'));
  });

  test('shows warning when no routes', () => {
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
    assert.ok(report.includes('🔴 +'));
  });

  test('shows gzip size in bold', () => {
    const report = generateReport({ '/about': { gzip: 1024 } }, {});
    assert.ok(report.includes('**1 KB**'));
  });
});
