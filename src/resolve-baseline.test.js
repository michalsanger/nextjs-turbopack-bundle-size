"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveTargetSha, findBaselineRun } = require("./resolve-baseline.js");

const OWNER = "o";
const REPO = "r";
const ARTIFACT = "turbopack-main-stats-main";

/**
 * Minimal Octokit fake. `runs` maps sha → array of runs, or a function
 * (callCount) => runs to simulate a run finishing between polls.
 */
function fakeOctokit({
  mergeParents = [],
  mergeBase,
  tip = "tip",
  runs = {},
  artifacts = {},
  history = [],
  compareError,
} = {}) {
  const calls = { runs: {} };
  return {
    calls,
    rest: {
      repos: {
        getCommit: async () => ({ data: { parents: mergeParents.map((sha) => ({ sha })) } }),
        compareCommitsWithBasehead: async () => {
          if (compareError) throw new Error(compareError);
          return { data: { merge_base_commit: { sha: mergeBase } } };
        },
        getBranch: async () => ({ data: { commit: { sha: tip } } }),
        listCommits: async ({ sha }) => ({
          data: [sha, ...history].map((s) => ({ sha: s })),
        }),
      },
      actions: {
        listWorkflowRunsForRepo: async ({ head_sha }) => {
          calls.runs[head_sha] = (calls.runs[head_sha] || 0) + 1;
          const r = runs[head_sha];
          return {
            data: { workflow_runs: typeof r === "function" ? r(calls.runs[head_sha]) : r || [] },
          };
        },
        listWorkflowRunArtifacts: async ({ run_id }) => ({
          data: { artifacts: (artifacts[run_id] || []).map((name) => ({ name, expired: false })) },
        }),
      },
    },
  };
}

const run = (id, extra = {}) => ({
  id,
  path: ".github/workflows/ci.yml",
  status: "completed",
  conclusion: "success",
  created_at: `2026-01-01T00:00:0${id % 10}Z`,
  ...extra,
});
const matchesWorkflow = (r) => r.path === ".github/workflows/ci.yml";
const base = { owner: OWNER, repo: REPO, artifactName: ARTIFACT, matchesWorkflow };

describe("resolveTargetSha", () => {
  const common = { owner: OWNER, repo: REPO, baseRef: "main", mergeSha: "M", prHeadSha: "H" };

  test("uses the merge commit's first parent when the merge commit was built", async () => {
    const octokit = fakeOctokit({ mergeParents: ["B", "H"] });
    assert.deepEqual(await resolveTargetSha({ ...common, octokit, builtSha: "M" }), {
      sha: "B",
      mode: "merge-commit",
    });
  });

  test("assumes the merge commit when the checked-out HEAD is unknown", async () => {
    const octokit = fakeOctokit({ mergeParents: ["B", "H"] });
    assert.deepEqual(await resolveTargetSha({ ...common, octokit, builtSha: null }), {
      sha: "B",
      mode: "merge-commit",
    });
  });

  test("uses the merge base when the PR head was built", async () => {
    const octokit = fakeOctokit({ mergeBase: "MB" });
    assert.deepEqual(await resolveTargetSha({ ...common, octokit, builtSha: "H" }), {
      sha: "MB",
      mode: "merge-base",
    });
  });

  test("falls back to the branch tip when GITHUB_SHA is not a merge commit", async () => {
    const octokit = fakeOctokit({ mergeParents: ["X"], tip: "T" });
    assert.deepEqual(await resolveTargetSha({ ...common, octokit, builtSha: "M" }), {
      sha: "T",
      mode: "branch-tip",
    });
  });

  test("falls back to the branch tip when the API call fails", async () => {
    const octokit = fakeOctokit({ compareError: "boom", tip: "T" });
    assert.deepEqual(await resolveTargetSha({ ...common, octokit, builtSha: "H" }), {
      sha: "T",
      mode: "branch-tip",
    });
  });
});

describe("findBaselineRun", () => {
  test("returns the run on the exact target commit", async () => {
    const octokit = fakeOctokit({ runs: { B: [run(1)] }, artifacts: { 1: [ARTIFACT] } });
    assert.deepEqual(await findBaselineRun({ ...base, octokit, targetSha: "B" }), {
      runId: 1,
      sha: "B",
      commitsBehind: 0,
    });
  });

  test("ignores runs of other workflows and the current run", async () => {
    const octokit = fakeOctokit({
      runs: { B: [run(1, { path: ".github/workflows/other.yml" }), run(2), run(3)] },
      artifacts: { 1: [ARTIFACT], 2: [ARTIFACT], 3: [ARTIFACT] },
    });
    const found = await findBaselineRun({ ...base, octokit, targetSha: "B", currentRunId: 3 });
    assert.equal(found.runId, 2);
  });

  test("waits for an in-progress run on the target commit instead of walking back", async () => {
    let clock = 0;
    const octokit = fakeOctokit({
      runs: {
        B: (n) => [run(5, n < 3 ? { status: "in_progress", conclusion: null } : {})],
        A: [run(4)],
      },
      artifacts: { 4: [ARTIFACT], 5: [ARTIFACT] },
      history: ["A"],
    });
    const found = await findBaselineRun({
      ...base,
      octokit,
      targetSha: "B",
      waitTimeoutMs: 60000,
      pollIntervalMs: 10000,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    assert.deepEqual(found, { runId: 5, sha: "B", commitsBehind: 0 });
    assert.equal(octokit.calls.runs.B, 3);
    assert.equal(octokit.calls.runs.A, undefined);
  });

  test("falls back to an ancestor after the wait times out", async () => {
    let clock = 0;
    const octokit = fakeOctokit({
      runs: { B: [run(5, { status: "in_progress", conclusion: null })], A: [run(4)] },
      artifacts: { 4: [ARTIFACT] },
      history: ["A"],
    });
    const found = await findBaselineRun({
      ...base,
      octokit,
      targetSha: "B",
      waitTimeoutMs: 30000,
      pollIntervalMs: 10000,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    assert.deepEqual(found, { runId: 4, sha: "A", commitsBehind: 1 });
  });

  test("does not wait when the timeout is 0", async () => {
    const octokit = fakeOctokit({
      runs: { B: [run(5, { status: "queued", conclusion: null })], A: [run(4)] },
      artifacts: { 4: [ARTIFACT] },
      history: ["A"],
    });
    const found = await findBaselineRun({
      ...base,
      octokit,
      targetSha: "B",
      sleep: async () => assert.fail("should not sleep"),
    });
    assert.deepEqual(found, { runId: 4, sha: "A", commitsBehind: 1 });
  });

  test("walks back past commits without runs and reports the distance", async () => {
    const octokit = fakeOctokit({
      runs: { C: [run(3)] },
      artifacts: { 3: [ARTIFACT] },
      history: ["A", "C"],
    });
    assert.deepEqual(await findBaselineRun({ ...base, octokit, targetSha: "B" }), {
      runId: 3,
      sha: "C",
      commitsBehind: 2,
    });
  });

  test("skips successful runs without the artifact", async () => {
    const octokit = fakeOctokit({
      runs: { B: [run(1)], A: [run(2)] },
      artifacts: { 1: ["something-else"], 2: [ARTIFACT] },
      history: ["A"],
    });
    const found = await findBaselineRun({ ...base, octokit, targetSha: "B" });
    assert.deepEqual(found, { runId: 2, sha: "A", commitsBehind: 1 });
  });

  test("returns null when nothing is found", async () => {
    const octokit = fakeOctokit({ history: ["A"] });
    assert.equal(await findBaselineRun({ ...base, octokit, targetSha: "B" }), null);
  });
});
