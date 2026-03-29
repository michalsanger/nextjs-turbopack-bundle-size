"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const INTERNAL_CHUNKS = [
  "webpack",
  "main-app",
  "main",
  "polyfills",
  "react-refresh",
  "edge-wrapper",
];

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDiff(current, baseline, threshold = 0, budgetPercentIncreaseRed = 0) {
  if (baseline === undefined) return "🆕 New";
  const diff = current - baseline;
  if (Math.abs(diff) <= threshold) return "➖ No change";
  if (baseline === 0) {
    return diff > 0 ? `🔴 \`+${formatBytes(diff)}\`` : `🟢 \`-${formatBytes(Math.abs(diff))}\``;
  }
  const percent = (Math.abs(diff) / baseline) * 100;
  if (diff > 0) {
    const icon = percent > budgetPercentIncreaseRed ? "🔴" : "🟡";
    return `${icon} \`+${formatBytes(diff)}\``;
  }
  return `🟢 \`-${formatBytes(Math.abs(diff))}\``;
}

/**
 * Builds a map from clean URL routes to their route-group-prefixed paths
 * using the app-paths-manifest.json file that Next.js generates.
 *
 * For example: `/book-session/[hash]` → `/(frontend)/book-session/[hash]`
 *
 * @param {string} manifestPath - Path to app-paths-manifest.json
 * @returns {Record<string, string>} clean route → route-group-prefixed route
 */
function buildRouteGroupMap(manifestPath) {
  if (!fs.existsSync(manifestPath)) return {};
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const map = {};
  for (const key of Object.keys(manifest)) {
    // Only process page routes (not API routes)
    if (!key.endsWith("/page")) continue;
    // Skip keys that have no route groups
    if (!/\/\([^)]+\)/.test(key)) continue;
    let cleanRoute = key.replace(/\/\([^)]+\)/g, "").replace(/\/page$/, "");
    cleanRoute = cleanRoute === "" ? "/" : cleanRoute;
    map[cleanRoute] = key.replace(/\/page$/, "");
  }
  return map;
}

/**
 * Processes the new route-bundle-stats.json format (Next.js 16.2+).
 *
 * The new format is an array of route objects with pre-computed sizes and
 * chunk paths. Shared chunks (present in ALL routes) are extracted into
 * a "global" entry, and per-route sizes exclude those shared chunks.
 *
 * @param {Array<{ route: string, firstLoadUncompressedJsBytes: number, firstLoadChunkPaths: string[] }>} stats
 * @param {((chunkPath: string) => number) | null} getGzipSize
 * @param {Record<string, string>} routeGroupMap - clean route → route-group-prefixed route
 * @returns {Record<string, { gzip: number }>}
 */
function processNewStats(stats, getGzipSize = null, routeGroupMap = {}) {
  if (!Array.isArray(stats) || stats.length === 0) return {};

  // Find JS chunks shared by ALL routes
  const allChunkSets = stats.map(
    (r) => new Set((r.firstLoadChunkPaths || []).filter((c) => c.endsWith(".js"))),
  );
  const sharedChunks = new Set(
    [...allChunkSets[0]].filter((chunk) => allChunkSets.every((s) => s.has(chunk))),
  );

  // Compute shared (global) gzip size
  let globalGzip = 0;
  if (getGzipSize) {
    for (const chunk of sharedChunks) {
      globalGzip += getGzipSize(chunk);
    }
  }

  const routes = {};

  if (globalGzip > 0) {
    routes["global"] = { gzip: globalGzip };
  }

  for (const entry of stats) {
    const route = entry.route;
    if (!route) continue;

    const hasContent = (entry.firstLoadUncompressedJsBytes || 0) > 0;
    if (!hasContent) continue;

    let routeGzip = 0;
    if (getGzipSize) {
      for (const chunk of entry.firstLoadChunkPaths || []) {
        if (!chunk.endsWith(".js")) continue;
        if (sharedChunks.has(chunk)) continue;
        routeGzip += getGzipSize(chunk);
      }
    }

    if (routeGzip === 0 && getGzipSize) continue;

    const routeKey = routeGroupMap[route] || route;
    routes[routeKey] = { gzip: routeGzip };
  }

  return routes;
}

/**
 * Processes a parsed stats object into a routes map.
 *
 * @param {object} stats - Parsed webpack-stats.json content
 * @param {((assetName: string) => number) | null} getGzipSize - Optional
 *   callback returning the gzip size for an asset path. Return 0 if not found.
 * @returns {Record<string, { gzip: number }>}
 */
function processStats(stats, getGzipSize = null) {
  const assetSizes = {};
  (stats.assets || []).forEach((a) => {
    assetSizes[a.name] = a.size;
  });

  const entrypoints = stats.namedChunkGroups || stats.entrypoints || {};
  const routes = {};

  let globalRaw = 0;
  let globalGzip = 0;

  for (const [routeName, chunkGroup] of Object.entries(entrypoints)) {
    const isInternal = INTERNAL_CHUNKS.some(
      (chunk) =>
        routeName === chunk ||
        routeName.startsWith(chunk + "-") ||
        routeName.startsWith(chunk + "."),
    );

    let totalRaw = 0;
    let totalGzip = 0;

    (chunkGroup.assets || []).forEach((asset) => {
      const assetName = typeof asset === "string" ? asset : asset.name;
      if (!assetName.endsWith(".js")) return;

      totalRaw += assetSizes[assetName] || 0;
      if (getGzipSize) totalGzip += getGzipSize(assetName);
    });

    if (isInternal) {
      globalRaw += totalRaw;
      globalGzip += totalGzip;
      continue;
    }

    if (totalRaw === 0) continue;

    let cleanRoute = routeName.replace(/^app/, "").replace(/\/page$/, "");
    cleanRoute = cleanRoute === "" ? "/" : cleanRoute;
    routes[cleanRoute] = { gzip: totalGzip };
  }

  if (globalRaw > 0) {
    routes["global"] = { gzip: globalGzip };
  }

  return routes;
}

const KNOWN_STATS_PATHS = [
  ".next/diagnostics/route-bundle-stats.json",
  ".next/server/webpack-stats.json",
];

/**
 * Resolves the stats file path by checking known locations.
 *
 * If the given path exists, returns it. Otherwise tries known alternative
 * locations (new Next.js 16.2+ path and legacy path).
 *
 * @param {string} statsPath
 * @returns {string}
 */
function resolveStatsPath(statsPath) {
  if (fs.existsSync(statsPath)) return statsPath;
  for (const knownPath of KNOWN_STATS_PATHS) {
    if (knownPath !== statsPath && fs.existsSync(knownPath)) {
      console.log(`ℹ️ Stats file not found at ${statsPath}, using ${knownPath}`);
      return knownPath;
    }
  }
  return statsPath;
}

/**
 * Returns the absolute path to the `.next` directory that contains the stats file.
 *
 * @param {string} filePath - Path to a file inside `.next` (e.g. diagnostics or server stats)
 * @returns {string}
 */
function findDotNextDir(filePath) {
  const segments = path.resolve(filePath).split(path.sep);
  const idx = segments.lastIndexOf(".next");
  if (idx < 0) {
    console.log(
      `⚠️ Warning: Could not find .next directory in path: ${filePath}, falling back to '.next'`,
    );
    return ".next";
  }
  return segments.slice(0, idx + 1).join(path.sep);
}

/**
 * Reads a stats file from disk and processes it.
 *
 * Automatically detects the format: if the parsed JSON is an array, it uses
 * the new route-bundle-stats format (Next.js 16.2+); otherwise the legacy
 * webpack-stats format.
 *
 * @param {string} statsPath
 * @param {boolean} calculateGzip
 * @returns {Record<string, { gzip: number }>}
 */
function parseStatsFile(statsPath, calculateGzip) {
  const resolvedPath = resolveStatsPath(statsPath);
  if (!fs.existsSync(resolvedPath)) return {};
  const stats = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));

  const dotNextDir = findDotNextDir(resolvedPath);

  const getGzipSize = calculateGzip
    ? (assetName) => {
        const relativeFromDotNext =
          assetName.startsWith(".next/") || assetName.startsWith(".next" + path.sep)
            ? assetName.slice(".next".length + 1)
            : assetName;
        const filePath = path.join(dotNextDir, relativeFromDotNext);
        if (fs.existsSync(filePath)) {
          return zlib.gzipSync(fs.readFileSync(filePath)).length;
        }
        console.log(`⚠️ Warning: Could not find file on disk for gzip: ${filePath}`);
        return 0;
      }
    : null;

  if (Array.isArray(stats)) {
    const manifestPath = path.join(dotNextDir, "server", "app-paths-manifest.json");
    const routeGroupMap = buildRouteGroupMap(manifestPath);
    return processNewStats(stats, getGzipSize, routeGroupMap);
  }
  return processStats(stats, getGzipSize);
}

/**
 * Generates a markdown report comparing current routes to a baseline.
 *
 * @param {Record<string, { gzip: number }>} currentRoutes
 * @param {Record<string, { gzip: number }>} baselineRoutes
 * @param {number} threshold
 * @returns {string}
 */
function generateReport(
  currentRoutes,
  baselineRoutes,
  threshold = 0,
  budgetPercentIncreaseRed = 0,
  appName = "",
) {
  const title = appName
    ? `## 📦 ${appName} — App Router Sizes (Turbopack)`
    : "## 📦 Next.js App Router Sizes (Turbopack)";
  let markdown = `${title}\n\nThis analysis was generated by the [Next.js Turbopack Bundle Size action](https://github.com/michalsanger/nextjs-turbopack-bundle-size). 🤖\n\n`;

  const allRoutes = [
    ...new Set([...Object.keys(currentRoutes), ...Object.keys(baselineRoutes)]),
  ].sort((a, b) => {
    if (a === "global") return -1;
    if (b === "global") return 1;
    return a.localeCompare(b);
  });

  if (allRoutes.length === 0) {
    markdown +=
      "> ⚠️ **Warning:** No routes identified. Ensure `TURBOPACK_STATS=1` is set during build.\n";
    return markdown;
  }

  const currentGlobal = (currentRoutes["global"] || {}).gzip || 0;
  const baselineGlobal = (baselineRoutes["global"] || {}).gzip || 0;

  const changedRows = [];
  for (const route of allRoutes) {
    const current = currentRoutes[route];
    const baseline = baselineRoutes[route];
    const isGlobal = route === "global";

    if (current && baseline === undefined) {
      const firstLoad = isGlobal ? " — |" : ` \`${formatBytes(current.gzip + currentGlobal)}\` |`;
      changedRows.push(`| \`${route}\` | \`${formatBytes(current.gzip)}\` |${firstLoad} 🆕 New |`);
    } else if (current === undefined && baseline) {
      changedRows.push(`| \`${route}\` | — | — | 🗑️ Removed |`);
    } else if (current && baseline) {
      const diff = Math.abs(current.gzip - baseline.gzip);
      if (diff > threshold) {
        const firstLoad = isGlobal ? " — |" : ` \`${formatBytes(current.gzip + currentGlobal)}\` |`;
        changedRows.push(
          `| \`${route}\` | \`${formatBytes(current.gzip)}\` |${firstLoad} ${formatDiff(current.gzip, baseline.gzip, threshold, budgetPercentIncreaseRed)} |`,
        );
      }
    }
  }

  if (changedRows.length === 0) {
    markdown += "This PR introduced no changes to the JavaScript bundle! 🙌\n";
    return markdown;
  }

  markdown += "| Route | Size (gzipped) | First load | Diff (vs baseline) |\n|---|---|---|---|\n";
  markdown += changedRows.join("\n") + "\n";

  return markdown;
}

/**
 * Parses stats, computes gzip sizes, and saves the result as JSON.
 *
 * @param {string} statsPath - Path to webpack-stats.json
 * @param {string} outputPath - Path to write the computed route sizes
 */
function saveRouteSizes(statsPath, outputPath) {
  const resolvedPath = resolveStatsPath(statsPath);
  const routes = parseStatsFile(resolvedPath, true);
  fs.writeFileSync(outputPath, JSON.stringify(routes));
}

/**
 * Loads pre-computed route sizes from a JSON file.
 *
 * @param {string} sizesPath - Path to the saved route sizes JSON
 * @returns {Record<string, { gzip: number }>}
 */
function loadRouteSizes(sizesPath) {
  if (!fs.existsSync(sizesPath)) return {};
  return JSON.parse(fs.readFileSync(sizesPath, "utf8"));
}

module.exports = {
  formatBytes,
  formatDiff,
  processStats,
  processNewStats,
  buildRouteGroupMap,
  resolveStatsPath,
  parseStatsFile,
  generateReport,
  saveRouteSizes,
  loadRouteSizes,
};
