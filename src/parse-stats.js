'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const INTERNAL_CHUNKS = [
  'webpack',
  'main-app',
  'main',
  'polyfills',
  'react-refresh',
  'edge-wrapper',
];

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDiff(current, baseline) {
  if (baseline === undefined) return '🆕 New';
  const diff = current - baseline;
  if (diff === 0) return '➖ No change';
  const sign = diff > 0 ? '🔴 +' : '🟢 ';
  return `${sign}${formatBytes(Math.abs(diff))}`;
}

/**
 * Processes a parsed stats object into a routes map.
 *
 * @param {object} stats - Parsed webpack-stats.json content
 * @param {((assetName: string) => number) | null} getGzipSize - Optional
 *   callback returning the gzip size for an asset path. Return 0 if not found.
 * @returns {Record<string, { raw: number, gzip: number }>}
 */
function processStats(stats, getGzipSize = null) {
  const assetSizes = {};
  (stats.assets || []).forEach((a) => {
    assetSizes[a.name] = a.size;
  });

  const entrypoints = stats.namedChunkGroups || stats.entrypoints || {};
  const routes = {};

  for (const [routeName, chunkGroup] of Object.entries(entrypoints)) {
    if (INTERNAL_CHUNKS.some((chunk) => routeName.includes(chunk))) continue;

    let totalRaw = 0;
    let totalGzip = 0;

    (chunkGroup.assets || []).forEach((asset) => {
      const assetName = typeof asset === 'string' ? asset : asset.name;
      if (!assetName.endsWith('.js')) return;

      totalRaw += assetSizes[assetName] || 0;
      if (getGzipSize) totalGzip += getGzipSize(assetName);
    });

    if (totalRaw === 0) continue;

    let cleanRoute = routeName.replace(/^app/, '').replace(/\/page$/, '');
    cleanRoute = cleanRoute === '' ? '/' : cleanRoute;
    routes[cleanRoute] = { raw: totalRaw, gzip: totalGzip };
  }

  return routes;
}

/**
 * Reads a stats file from disk and processes it.
 *
 * @param {string} statsPath
 * @param {boolean} calculateGzip
 * @returns {Record<string, { raw: number, gzip: number }>}
 */
function parseStatsFile(statsPath, calculateGzip) {
  if (!fs.existsSync(statsPath)) return {};
  const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));

  const getGzipSize = calculateGzip
    ? (assetName) => {
        let filePath = assetName;
        if (!fs.existsSync(filePath) && !filePath.startsWith('.next')) {
          filePath = path.join('.next', assetName);
        }
        if (fs.existsSync(filePath)) {
          return zlib.gzipSync(fs.readFileSync(filePath)).length;
        }
        console.log(`⚠️ Warning: Could not find file on disk for gzip: ${filePath}`);
        return 0;
      }
    : null;

  return processStats(stats, getGzipSize);
}

/**
 * Generates a markdown report comparing current routes to a baseline.
 *
 * @param {Record<string, { raw: number, gzip: number }>} currentRoutes
 * @param {Record<string, { raw: number, gzip: number }>} baselineRoutes
 * @returns {string}
 */
function generateReport(currentRoutes, baselineRoutes) {
  let markdown = '### 📦 Next.js App Router Sizes (Turbopack)\n\n';
  markdown += '| Route | Uncompressed | Gzipped | Diff (vs main) |\n|---|---|---|---|\n';

  let foundRoutes = false;
  for (const [route, sizes] of Object.entries(currentRoutes)) {
    foundRoutes = true;
    const baselineSize = baselineRoutes[route]?.raw;
    markdown += `| \`${route}\` | ${formatBytes(sizes.raw)} | **${formatBytes(sizes.gzip)}** | ${formatDiff(sizes.raw, baselineSize)} |\n`;
  }

  if (!foundRoutes) {
    markdown +=
      '> ⚠️ **Warning:** No routes identified. Ensure `TURBOPACK_STATS=1` is set during build.\n';
  }

  return markdown;
}

module.exports = { formatBytes, formatDiff, processStats, parseStatsFile, generateReport };
