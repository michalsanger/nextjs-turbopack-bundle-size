"use strict";

/**
 * Baseline resolution for the PR phase.
 *
 * The diff must show only what the PR changes, so the baseline has to be the
 * exact commit the PR build sits on top of — not the live tip of the target
 * branch, which may have moved since (or be older, if its build is still
 * running). Which commit that is depends on what the caller checked out:
 *
 *   - "merge-commit": HEAD is GitHub's merge commit (actions/checkout default
 *     on pull_request). Baseline = its first parent, i.e. the base tip the
 *     merge ref was computed against.
 *   - "merge-base": HEAD is the PR head (`ref: pull_request.head.sha`).
 *     Baseline = merge base of the PR head and the target branch.
 *   - "branch-tip": neither could be determined; fall back to the live tip of
 *     the target branch (the previous behavior).
 */

const MAX_COMMITS = 25;
const PENDING_STATUSES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

/**
 * Determines the commit whose baseline the PR should be compared against.
 *
 * @param {object} opts
 * @param {object} opts.octokit - Authenticated Octokit instance
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.baseRef - PR target branch name
 * @param {string} opts.mergeSha - GITHUB_SHA (the PR merge commit on pull_request)
 * @param {string} opts.prHeadSha - pull_request.head.sha
 * @param {string|null} opts.builtSha - SHA of the checked-out HEAD, or null if unknown
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ sha: string, mode: "merge-commit" | "merge-base" | "branch-tip" }>}
 */
async function resolveTargetSha({
  octokit,
  owner,
  repo,
  baseRef,
  mergeSha,
  prHeadSha,
  builtSha,
  log = () => {},
}) {
  try {
    if (builtSha && prHeadSha && builtSha === prHeadSha) {
      const res = await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${baseRef}...${prHeadSha}`,
        per_page: 1,
      });
      const sha = res.data.merge_base_commit && res.data.merge_base_commit.sha;
      if (sha) return { sha, mode: "merge-base" };
    } else if (mergeSha) {
      if (builtSha && builtSha !== mergeSha) {
        log(
          `checked-out HEAD ${builtSha.slice(0, 8)} is neither the merge commit nor the PR head; ` +
            `assuming the merge commit`,
        );
      }
      const res = await octokit.rest.repos.getCommit({ owner, repo, ref: mergeSha });
      const parents = res.data.parents || [];
      if (parents.length >= 2) return { sha: parents[0].sha, mode: "merge-commit" };
      log(`${mergeSha.slice(0, 8)} is not a merge commit`);
    }
  } catch (err) {
    log(`could not determine the exact baseline commit — ${err.message}`);
  }
  const branch = await octokit.rest.repos.getBranch({ owner, repo, branch: baseRef });
  return { sha: branch.data.commit.sha, mode: "branch-tip" };
}

/**
 * Finds the workflow run holding the baseline artifact, starting at the exact
 * target commit and walking back through its ancestors only if needed. If the
 * target commit's baseline run is still in progress, waits for it (up to
 * `waitTimeoutMs`) instead of silently falling back to an older commit.
 *
 * @param {object} opts
 * @param {object} opts.octokit
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.targetSha - Commit returned by resolveTargetSha
 * @param {string} opts.artifactName
 * @param {(run: object) => boolean} opts.matchesWorkflow - Selects runs of the baseline workflow
 * @param {number} [opts.currentRunId] - Excluded from candidates (never wait on ourselves)
 * @param {number} [opts.waitTimeoutMs]
 * @param {number} [opts.pollIntervalMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ runId: number, sha: string, commitsBehind: number } | null>}
 */
async function findBaselineRun({
  octokit,
  owner,
  repo,
  targetSha,
  artifactName,
  matchesWorkflow,
  currentRunId,
  waitTimeoutMs = 0,
  pollIntervalMs = 15000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = () => {},
}) {
  const runsFor = async (sha) => {
    const res = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      head_sha: sha,
      per_page: 100,
    });
    return (res.data.workflow_runs || []).filter(
      (r) => matchesWorkflow(r) && r.id !== currentRunId,
    );
  };

  const hasArtifact = async (runId) => {
    try {
      const res = await octokit.rest.actions.listWorkflowRunArtifacts({
        owner,
        repo,
        run_id: runId,
      });
      return (res.data.artifacts || []).some((a) => a.name === artifactName && !a.expired);
    } catch (err) {
      log(`run ${runId}: artifact listing failed — ${err.message}`);
      return false;
    }
  };

  // Returns the run id holding the artifact, "pending" if a run that may still
  // produce it is in progress, or null.
  const checkSha = async (sha) => {
    const runs = await runsFor(sha);
    const successful = runs
      .filter((r) => r.conclusion === "success")
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    for (const run of successful) {
      if (await hasArtifact(run.id)) return run.id;
      log(`run ${run.id} (${sha.slice(0, 8)}): no "${artifactName}"`);
    }
    if (runs.some((r) => PENDING_STATUSES.has(r.status))) return "pending";
    if (runs.length === 0) log(`commit ${sha.slice(0, 8)}: no baseline workflow run`);
    return null;
  };

  // 1. The exact target commit — wait for an in-progress run if there is one.
  const deadline = now() + waitTimeoutMs;
  let result = await checkSha(targetSha);
  while (result === "pending" && now() < deadline) {
    log(`baseline run for ${targetSha.slice(0, 8)} is still in progress; waiting…`);
    await sleep(pollIntervalMs);
    result = await checkSha(targetSha);
  }
  if (result === "pending") {
    log(`timed out waiting for the baseline run of ${targetSha.slice(0, 8)}`);
  } else if (result !== null) {
    return { runId: result, sha: targetSha, commitsBehind: 0 };
  }

  // 2. Ancestors, newest first. The diff will include their changes, so the
  // report flags this.
  const commits = await octokit.rest.repos.listCommits({
    owner,
    repo,
    sha: targetSha,
    per_page: MAX_COMMITS,
  });
  const ancestors = commits.data.map((c) => c.sha).filter((sha) => sha !== targetSha);
  for (let i = 0; i < ancestors.length; i++) {
    const runId = await checkSha(ancestors[i]);
    if (runId !== null && runId !== "pending") {
      return { runId, sha: ancestors[i], commitsBehind: i + 1 };
    }
  }
  return null;
}

module.exports = { resolveTargetSha, findBaselineRun, MAX_COMMITS };
