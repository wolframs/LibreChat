import { spawn } from 'node:child_process';
import { AGENT_ENV } from './worktrees.js';
import { addTokens } from './tokens.js';

export const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['complete', 'needs_input'] },
    report: { type: 'string' },
    notesVersion: { type: 'integer', minimum: 0 },
  },
  required: ['outcome', 'report', 'notesVersion'],
  additionalProperties: false,
};

export function signalGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid < 2) return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}

export function groupAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/** stdin is released only after the child PID has been durably recorded. */
export function runSession({
  cwd,
  prompt,
  sessionId,
  resume,
  model,
  maxTurns,
  timeoutMs,
  settings,
  onProgress,
  onSpawn,
  command = 'claude',
  extraArgs = [],
}) {
  const args =
    command === 'claude'
      ? [
          ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
          '-p',
          '--output-format',
          'stream-json',
          '--verbose',
          '--max-turns',
          String(maxTurns),
          '--json-schema',
          JSON.stringify(RESULT_SCHEMA),
          '--settings',
          settings,
          '--dangerously-skip-permissions',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          ...(model ? ['--model', model] : []),
        ]
      : extraArgs;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...AGENT_ENV },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const progress = {
      messages: 0,
      turns: 0,
      maxTurns,
      tools: 0,
      files: [],
      sessionId,
      phase: 'starting',
    };
    let buffer = '';
    let stderr = '';
    let result = null;
    let stoppedBecause = null;
    let killTimer;
    let settled = false;
    const stop = (reason) => {
      stoppedBecause = reason;
      signalGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), 5000);
    };
    const timer = setTimeout(() => stop('wall_clock_limit'), timeoutMs);
    const event = (line) => {
      if (!line.trim()) return;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e.type === 'system' && e.subtype === 'init') {
        progress.phase = 'working';
        progress.initialized = true;
        progress.sessionId = e.session_id || sessionId;
        progress.model = e.model;
      } else if (e.type === 'assistant') {
        progress.messages += 1;
        progress.tokens = addTokens(progress.tokens, e.message?.usage);
        for (const part of e.message?.content ?? []) {
          if (part.type === 'text' && part.text?.trim())
            progress.lastText = part.text.trim().slice(-600);
          if (part.type === 'tool_use') {
            progress.tools += 1;
            const target =
              part.input?.file_path ?? part.input?.pattern ?? part.input?.command ?? '';
            progress.lastTool = `${part.name} ${String(target).slice(0, 120)}`.trim();
            if (part.input?.file_path && !progress.files.includes(part.input.file_path))
              progress.files.push(part.input.file_path);
          }
        }
      } else if (e.type === 'result') {
        result = e;
        progress.turns = e.num_turns ?? null;
        progress.phase = 'stopped';
      }
      onProgress?.({
        ...progress,
        files: [...progress.files],
        tokens: progress.tokens ? { ...progress.tokens } : null,
      });
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) event(line);
      if (buffer.length > 4_000_000) buffer = '';
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-12000);
    });
    child.stdin.on('error', () => {});
    child.on('spawn', async () => {
      try {
        await onSpawn?.(child.pid, stop);
        child.stdin.end(prompt);
      } catch (err) {
        stderr += `\nCannot record child: ${err.message}`;
        stop('supervisor_error');
      }
    });
    const done = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (child.pid) signalGroup(child.pid, 'SIGKILL');
      event(buffer);
      resolve({
        result,
        code,
        stderr: error ? `${stderr}\n${error.message}` : stderr,
        stoppedBecause,
        progress,
      });
    };
    child.on('close', (code) => done(code));
    child.on('error', (error) => done(-1, error));
  });
}

export function completion(output, notesVersion) {
  const r = output.result;
  if (output.stoppedBecause) return { complete: false, reason: output.stoppedBecause };
  if (output.code !== 0 || !r || r.is_error || r.subtype !== 'success') {
    return { complete: false, reason: r?.subtype || 'session_error' };
  }
  const value = r.structured_output;
  if (
    !value ||
    !['complete', 'needs_input'].includes(value.outcome) ||
    typeof value.report !== 'string'
  ) {
    return { complete: false, reason: 'missing_completion_report' };
  }
  if (value.outcome === 'needs_input')
    return { complete: false, reason: 'needs_input', report: value.report };
  if (value.notesVersion !== notesVersion)
    return { complete: false, reason: 'new_notes', report: value.report };
  return { complete: true, report: value.report };
}
