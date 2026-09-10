import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { buildPrompt, buildResumePrompt } from './prompt.js';
import { completion, groupAlive, runSession } from './session.js';
import { applicationPlan } from './deployment.js';
import { headAt, dirtyAt, gitAt } from './worktrees.js';
import { tokensFrom, describeTokens } from './tokens.js';
import { commandScope } from './commands.js';

export const LIVE = [
  'preparing',
  'running',
  'testing',
  'building',
  'integrating',
  'integrated',
  'deploying',
];
export const RESUMABLE = ['paused', 'needs_input', 'tests_failed', 'awaiting_integration', 'error'];

/** Lifecycle independent of Mongo and the model subprocess, so tests exercise real Git transitions. */
export class Engine {
  constructor({
    worktrees,
    update,
    context,
    prepare,
    test,
    deployment,
    session = runSession,
    model = '',
    maxTurns = 250,
    maxContinuations = 2,
    timeoutMs = 2_700_000,
    maxWorktrees = 12,
    settings,
  }) {
    Object.assign(this, {
      worktrees,
      update,
      context,
      prepare,
      test,
      deployment,
      session,
      model,
      maxTurns,
      maxContinuations,
      timeoutMs,
      maxWorktrees,
      settings,
    });
    this.active = null;
    this.stop = null;
    this.integrationClosed = new Set();
    this.pendingNotes = new Map();
    this.commandStop = null;
  }

  async patch(id, patch) {
    const record = await this.worktrees.save(id, patch);
    await this.update(id, record);
    return record;
  }

  launch(id, operation = () => this.run(id)) {
    const scope = {
      start: async (pid, command, stop) => {
        this.commandStop = stop;
        await this.patch(id, { commandPid: pid, command });
      },
      end: async (pid) => {
        this.commandStop = null;
        const job = await this.worktrees.read(id);
        if (job?.commandPid === pid) await this.patch(id, { commandPid: null, command: null });
      },
    };
    this.task = commandScope
      .run(scope, operation)
      .catch(async (err) => {
        try {
          await this.crashed(id, err);
        } catch (recordError) {
          this.fault = `Cannot mirror job ${id} recovery state: ${recordError.message}. Restart after restoring persistence.`;
          console.error(this.fault);
        }
      })
      .finally(() => {
        this.active = null;
        this.stop = null;
        this.commandStop = null;
      });
  }

  async notesFile(id) {
    const job = await this.worktrees.read(id);
    const file = this.worktrees.paths(id).notes;
    const body =
      `# Job notes — version ${job.notesVersion || 0}\n\n` +
      (job.notes || [])
        .map(
          (n) =>
            `## ${n.at} — ${n.from}${n.late ? ' (record only; integration already began)' : ''}\n\n${n.text}\n`,
        )
        .join('\n');
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, body, { mode: 0o600 });
    await fs.rename(temporary, file);
    return file;
  }

  note(id, text, from = 'filing agent') {
    const closedAtReceipt = this.integrationClosed.has(id);
    const next = (this.pendingNotes.get(id) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const old = await this.worktrees.read(id);
        if (!old)
          throw new Error(
            'This is a legacy job without an isolated worktree. Its old record is read-only.',
          );
        const late =
          closedAtReceipt ||
          !!old.integratedSha ||
          ['done', 'no_change', 'archived', 'rolled_back'].includes(old.status);
        const record = await this.patch(id, (job) => ({
          notes: [...(job.notes || []), { text, from, at: new Date().toISOString(), late }],
          notesVersion: (job.notesVersion || 0) + (late ? 0 : 1),
          ...(late ? {} : { sessionComplete: false }),
        }));
        await this.notesFile(id);
        return { late, version: record.notesVersion, status: record.status };
      });
    this.pendingNotes.set(id, next);
    return next;
  }

  async start(id, premise, userId) {
    if (this.fault) throw new Error(this.fault);
    if (this.active)
      throw new Error(`Job ${this.active} is active. Use check_fix or add_note for that job.`);
    this.active = id;
    try {
      const inventory = await this.worktrees.inventory();
      if (inventory.filter((j) => j.retained).length >= this.maxWorktrees) {
        throw new Error(
          `There are ${this.maxWorktrees} retained worktrees. Resume or explicitly archive an old job first: ${inventory
            .filter((j) => j.retained)
            .map((j) => j.id)
            .join(', ')}`,
        );
      }
      await this.checkChildren(inventory);
      await this.patch(id, {
        premise,
        userId,
        status: 'preparing',
        notes: [],
        notesVersion: 0,
        sessionId: randomUUID(),
        createdAt: new Date().toISOString(),
      });
      this.launch(id);
    } catch (err) {
      this.active = null;
      throw err;
    }
  }

  async checkChildren(inventory = null) {
    for (const row of inventory || (await this.worktrees.inventory())) {
      const job = await this.worktrees.read(row.id);
      if (groupAlive(job?.childPid))
        throw new Error(
          `Job ${row.id} still has process group ${job.childPid}. Inspect it before starting another process.`,
        );
      if (groupAlive(job?.commandPid))
        throw new Error(
          `Job ${row.id} still has ${job.command} process group ${job.commandPid}. Inspect it before starting another process.`,
        );
    }
  }

  async resume(id) {
    if (this.active) throw new Error(`Job ${this.active} is active.`);
    this.active = id;
    try {
      let job = await this.worktrees.validate(id);
      await this.checkChildren();
      if (job.status === 'recovery_required') job = await this.recoverTransaction(id);
      if (!RESUMABLE.includes(job.status))
        throw new Error(
          `Job is ${job.status}; it cannot be resumed automatically. See check_fix for recovery/application details.`,
        );
      if (job.integratedSha) {
        this.integrationClosed.add(id);
        this.launch(id, () => this.applyIntegrated(id));
        return;
      }
      await this.patch(id, {
        status: job.sessionComplete ? 'testing' : 'preparing',
        pauseRequested: false,
        resumeCount: (job.resumeCount || 0) + 1,
        resumedAt: new Date().toISOString(),
        finishedAt: null,
      });
      this.integrationClosed.delete(id);
      this.launch(id);
    } catch (err) {
      this.active = null;
      throw err;
    }
  }

  async pause(id) {
    const job = await this.worktrees.read(id);
    if (!job) throw new Error('Unknown isolated job.');
    if (this.integrationClosed.has(id) || job.integratedSha)
      throw new Error(
        'Integration/application has already begun; check the outcome before requesting further changes.',
      );
    await this.patch(id, { pauseRequested: true });
    if (this.active === id) {
      this.stop?.('pause_requested');
      this.commandStop?.();
    } else await this.patch(id, { status: 'paused', stoppedBecause: 'pause_requested' });
    return 'Pause requested. The coding session stops; any preparation/test/build command may finish before the pause is confirmed. Commits and edits remain in this job. Check status for confirmation.';
  }

  async recoverTransaction(id) {
    let job = await this.worktrees.read(id);
    if (!job.integratedSha && (job.integrationExpected || job.stoppedDuring === 'integrating')) {
      const actual = await headAt(this.worktrees.repo);
      if (actual !== job.integrationExpected) {
        const parents = await gitAt(this.worktrees.repo, [
          'rev-list',
          '--parents',
          '-n',
          '1',
          actual,
        ]);
        if (parents !== `${actual} ${job.integrationExpected} ${job.testedSha}`) {
          throw new Error(
            'The target moved outside the recorded integration transaction. Inspect its history before recovery.',
          );
        }
        job = await this.patch(id, { integratedSha: actual });
      }
    }
    if (job.integratedSha) {
      await this.worktrees.assertTarget(job.rollbackSha || job.integratedSha);
      if (job.application?.automatic) {
        const current = await this.deployment.previousImage();
        if (![job.imageId, job.previousImage].includes(current))
          throw new Error(
            'The running API image is outside this job’s candidate/rollback pair. Inspect it before recovery.',
          );
      }
    }
    return this.patch(id, { status: 'paused', stoppedBecause: 'recovery_requested' });
  }

  async archive(id) {
    if (this.active)
      throw new Error(`Wait for active job ${this.active} before archiving worktrees.`);
    this.active = id;
    try {
      await this.checkChildren();
      const job = await this.worktrees.read(id);
      if (!job || LIVE.includes(job.status) || job.status === 'recovery_required')
        throw new Error('Inspect/recover the active transaction before archiving it.');
      const record = await this.worktrees.archive(id);
      await this.update(id, record);
      return record;
    } finally {
      this.active = null;
    }
  }

  async crashed(id, error) {
    console.error(`[${id}] ${error.stack || error}`);
    const job = await this.worktrees.read(id);
    const uncertain = job?.integratedSha || ['integrating', 'deploying'].includes(job?.status);
    await this.patch(id, {
      status: uncertain ? 'recovery_required' : job?.pauseRequested ? 'paused' : 'error',
      summary: error.message,
      stoppedBecause: job?.pauseRequested ? 'pause_requested' : 'supervisor_error',
      finishedAt: new Date().toISOString(),
    });
  }

  async finish(id, status, patch = {}) {
    await this.patch(id, { status, ...patch, finishedAt: new Date().toISOString() });
    if (
      ['done', 'no_change', 'applied_pending_restart', 'integrated_only', 'rolled_back'].includes(
        status,
      )
    ) {
      try {
        await this.update(id, await this.worktrees.cleanup(id));
      } catch (err) {
        await this.patch(id, { cleanupWarning: err.message });
      }
    }
  }

  async run(id) {
    let job = await this.worktrees.read(id);
    if (!job.baseSha) {
      await this.worktrees.create(id);
      job = await this.worktrees.read(id);
    }
    await this.worktrees.validate(id);
    await this.notesFile(id);
    await this.patch(id, { status: 'preparing' });
    await this.prepare(job.worktree, job, (patch) => this.patch(id, patch));
    job = await this.worktrees.read(id);
    if (job.pauseRequested) return this.finish(id, 'paused', { stoppedBecause: 'pause_requested' });
    if (!job.sessionComplete) {
      const complete = await this.edit(id);
      if (!complete) return;
    }
    await this.publish(id);
  }

  async edit(id) {
    const deadline = Date.now() + this.timeoutMs;
    for (let segment = 0; segment <= this.maxContinuations; segment += 1) {
      let job = await this.worktrees.read(id);
      if (job.pauseRequested || Date.now() >= deadline) {
        await this.finish(id, 'paused', {
          stoppedBecause: job.pauseRequested ? 'pause_requested' : 'wall_clock_limit',
        });
        return false;
      }
      const context = job.sessionStarted ? {} : await this.context(job.userId);
      const args = {
        ...job,
        ...context,
        notesPath: this.worktrees.paths(id).notes,
        maxTurns: this.maxTurns,
        reason: job.stoppedBecause,
      };
      const prompt = job.sessionStarted ? buildResumePrompt(args) : buildPrompt(args);
      await this.patch(id, {
        status: 'running',
        segment: (job.segment || 0) + 1,
        sender: context.sender || job.sender || null,
      });
      const started = Date.now();
      let writes = Promise.resolve();
      let progressError;
      let lastWrite = 0;
      const output = await this.session({
        cwd: job.worktree,
        prompt,
        sessionId: job.sessionId,
        resume: !!job.sessionStarted,
        model: this.model,
        maxTurns: this.maxTurns,
        timeoutMs: deadline - Date.now(),
        settings: this.settings,
        onSpawn: async (pid, stop) => {
          this.stop = stop;
          await this.patch(id, { childPid: pid });
        },
        onProgress: (progress) => {
          if (Date.now() - lastWrite < 2000) return;
          lastWrite = Date.now();
          writes = writes
            .then(() =>
              this.patch(id, {
                progress: { ...progress, at: new Date().toISOString() },
                ...(progress.initialized ? { sessionStarted: true } : {}),
              }),
            )
            .catch((err) => {
              progressError = err;
              this.stop?.('supervisor_error');
            });
        },
      });
      this.stop = null;
      await writes;
      if (progressError) throw progressError;
      await this.pendingNotes.get(id);
      job = await this.worktrees.read(id);
      const tokens = tokensFrom(output.result?.usage) || output.progress?.tokens || null;
      const segmentUsage = {
        elapsed: Math.round((Date.now() - started) / 1000),
        tokens,
        cost: output.result?.total_cost_usd ?? null,
      };
      const usage = [...(job.usage || []), segmentUsage];
      const totalTokens = usage.reduce(
        (sum, item) => {
          for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'thinking'])
            sum[key] += item.tokens?.[key] || 0;
          return sum;
        },
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      );
      const result = completion(output, job.notesVersion || 0);
      if (job.pauseRequested) {
        result.complete = false;
        result.reason = 'pause_requested';
      }
      await this.patch(id, {
        childPid: null,
        progress: { ...output.progress, at: new Date().toISOString() },
        sessionStarted:
          job.sessionStarted || !!output.progress?.initialized || !!output.result?.session_id,
        sessionId: output.progress?.sessionId || job.sessionId,
        usage,
        tokens: totalTokens,
        elapsed: usage.reduce((sum, item) => sum + item.elapsed, 0),
        usageLine: describeTokens(totalTokens, {
          cost: usage.reduce((sum, item) => sum + (item.cost || 0), 0),
        }),
        summary:
          result.report ||
          output.result?.result ||
          output.stderr ||
          'The session stopped before producing a completion report.',
        stoppedBecause: result.reason || null,
        sessionComplete: result.complete,
        acknowledgedNotes: result.complete ? job.notesVersion || 0 : null,
      });
      await this.worktrees.snapshot(id);
      if (result.complete) return true;
      if (
        ['error_max_turns', 'new_notes'].includes(result.reason) &&
        segment < this.maxContinuations &&
        Date.now() < deadline
      )
        continue;
      await this.finish(id, result.reason === 'needs_input' ? 'needs_input' : 'paused');
      return false;
    }
    return false;
  }

  async publicationFence(id) {
    // A note receipt after this point explicitly says it cannot alter the in-flight revision.
    this.integrationClosed.add(id);
    await this.pendingNotes.get(id);
    const job = await this.worktrees.read(id);
    if (job.pauseRequested || job.acknowledgedNotes !== (job.notesVersion || 0)) {
      this.integrationClosed.delete(id);
      await this.finish(id, 'paused', {
        sessionComplete: false,
        stoppedBecause: job.pauseRequested ? 'pause_requested' : 'new_notes',
      });
      return false;
    }
    return true;
  }

  async publish(id) {
    let job;
    try {
      await this.worktrees.verifyPublishable(id);
      await this.worktrees.refresh(id);
      job = await this.worktrees.snapshot(id);
    } catch (err) {
      await this.note(id, err.message, 'supervisor');
      return this.finish(id, 'paused', {
        stoppedBecause: 'worktree_needs_attention',
        summary: err.message,
      });
    }
    if (!job.files.length) {
      if (!(await this.publicationFence(id))) return;
      return this.finish(id, 'no_change');
    }
    await this.patch(id, { status: 'testing' });
    await this.prepare(job.worktree, job, (patch) => this.patch(id, patch));
    const testedSha = await headAt(job.worktree);
    const tests = await this.test(job.worktree, job.files);
    await this.patch(id, { tests: tests.text, flakySuites: tests.flaky || [], testedSha });
    if (!tests.ok) {
      await this.note(
        id,
        `The wrapper's validation failed. Work is retained and was not integrated.\n\n${tests.text}`,
        'supervisor',
      );
      return this.finish(id, 'tests_failed', { stoppedBecause: 'validation_failed' });
    }
    if ((await dirtyAt(job.worktree)) || (await headAt(job.worktree)) !== testedSha) {
      await this.note(
        id,
        'Tests/builds changed the committed tree or left source edits. Inspect, commit intended changes, and rerun validation.',
        'supervisor',
      );
      return this.finish(id, 'paused', { stoppedBecause: 'changed_during_tests' });
    }
    try {
      await this.worktrees.assertTarget(job.integrationBase);
    } catch (err) {
      return this.finish(id, 'awaiting_integration', { integrationReason: err.message });
    }
    const plan = applicationPlan(job.files);
    job = await this.patch(id, { application: plan });
    if (plan.automatic) {
      try {
        await this.deployment.assertRuntimeCurrent?.();
      } catch (err) {
        return this.finish(id, 'awaiting_integration', { integrationReason: err.message });
      }
      await this.patch(id, { status: 'building' });
      await this.deployment.build(job, (patch) => this.patch(id, patch));
      const previousImage = await this.deployment.previousImage();
      await this.patch(id, { previousImage });
    }
    if (!(await this.publicationFence(id))) return;
    try {
      job = await this.worktrees.integrate(id, testedSha);
      await this.update(id, job);
    } catch (err) {
      const state = await this.worktrees.read(id);
      if (state.status === 'integrating') throw err;
      this.integrationClosed.delete(id);
      return this.finish(id, 'awaiting_integration', { integrationReason: err.message });
    }
    return this.applyIntegrated(id);
  }

  async applyIntegrated(id) {
    const job = await this.worktrees.read(id);
    const plan = job.application;
    const revert = `git revert -m 1 ${job.integratedSha}`;
    if (!plan.automatic) {
      const advice = plan.needsApplication.some((f) => f.startsWith('mcp-code-agent/'))
        ? 'Integrated; code-agent is a host process. Check /healthz activeJob is null, then launchctl kickstart -k gui/' +
          process.getuid() +
          '/local.librechat.code-agent. Other changed runtime/sidecar files may need their own application step.'
        : plan.needsApplication.length
          ? `Integrated; runtime/sidecar application needs review: ${plan.needsApplication.join(', ')}. Use the operator deploy procedure when ready.`
          : 'Integrated; no runtime image change was required.';
      return this.finish(
        id,
        plan.needsApplication.length ? 'applied_pending_restart' : 'integrated_only',
        { deploy: advice, revert },
      );
    }
    await this.patch(id, { status: 'deploying' });
    const deployed = job.rollingBack
      ? { ok: false, text: job.deploy || 'Continuing interrupted rollback.' }
      : await this.deployment.apply(job.imageId, job.integratedSha);
    if (deployed.ok)
      return this.finish(id, 'done', {
        deploy: deployed.text,
        revert: `${revert} && ./scripts/deploy.sh`,
      });
    await this.patch(id, { deploy: deployed.text, status: 'deploying', rollingBack: true });
    let sourceError = null;
    try {
      if (!job.rollbackSha) await this.worktrees.rollback(id);
    } catch (err) {
      sourceError = err.message;
    }
    // Restore the old marker script first when possible, but never make image
    // recovery conditional on successfully reverting a concurrently edited tree.
    const restored = deployed.notAttempted
      ? { ok: true, text: 'Application was not attempted; the running image is unchanged.' }
      : await this.deployment.apply(job.previousImage, job.integratedSha, { rollback: true });
    return this.finish(id, restored.ok && !sourceError ? 'rolled_back' : 'recovery_required', {
      deploy: deployed.text,
      rollback: restored.text,
      recoveryReason: sourceError,
      summary: `${job.summary || ''}\n\nDeployment failed. Previous API image ${restored.ok ? 'restored' : 'could not be restored'}.${sourceError ? ` Source integration was retained: ${sourceError}` : ''}`,
    });
  }

  async recover() {
    let count = 0;
    for (const row of await this.worktrees.inventory()) {
      const job = await this.worktrees.read(row.id);
      if (!job) continue;
      if (LIVE.includes(job.status)) {
        const uncertain =
          groupAlive(job.childPid) ||
          groupAlive(job.commandPid) ||
          job.integratedSha ||
          ['integrating', 'deploying'].includes(job.status);
        await this.patch(row.id, {
          status: uncertain ? 'recovery_required' : 'paused',
          stoppedDuring: job.status,
          stoppedBecause: 'server_restarted',
          summary: uncertain
            ? `Server stopped during ${job.status}. Inspect process groups ${job.childPid || '(no session)'} / ${job.commandPid || '(no command)'}, target branch, and live image before recovery. No automatic cleanup or replay was attempted.`
            : `Server stopped during ${job.status}. Session and edits remain in ${job.worktree}; resume_fix continues the same job.`,
        });
        count += 1;
      } else {
        await this.update(row.id, job);
        if (
          !job.cleanedAt &&
          [
            'done',
            'no_change',
            'integrated_only',
            'applied_pending_restart',
            'rolled_back',
            'archived',
          ].includes(job.status)
        ) {
          try {
            await this.update(row.id, await this.worktrees.cleanup(row.id));
          } catch (err) {
            await this.patch(row.id, { cleanupWarning: err.message });
          }
        }
      }
    }
    return count;
  }
}
