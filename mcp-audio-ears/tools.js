import { execFile } from 'child_process';
import { ObjectId } from 'mongodb';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { getDb } from './db.js';
import { resolveAudioRecord, resolveAudioPath, listUserAudio } from './files.js';

export const MODEL = process.env.AUDIO_EARS_MODEL || 'google/gemini-3.8-flash';

const SCRIPT = '/app/describe_audio.py';
/** Wall-clock ceiling for one listen, chunking included. */
const RUN_TIMEOUT_MS = parseInt(process.env.AUDIO_EARS_TIMEOUT_SEC ?? '600', 10) * 1000;
const configuredWeeklyBudget = Number(process.env.AUDIO_EARS_WEEKLY_BUDGET_USD ?? '1');
if (!Number.isFinite(configuredWeeklyBudget) || configuredWeeklyBudget < 0) {
  throw new Error('AUDIO_EARS_WEEKLY_BUDGET_USD must be a finite non-negative number.');
}
export const WEEKLY_BUDGET_USD = configuredWeeklyBudget;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_LEASE_MS = RUN_TIMEOUT_MS + 60_000;

/**
 * Two prompt characters, both from the skill this server vendors. "feel" is the
 * bundled default — evocative prose a model can respond to. "analyze" is the
 * scannable one: sections, timings, element inventory.
 */
const ANALYZE_PROMPT =
  'Describe this audio in exquisite, structured detail so it can be parsed by a ' +
  'text-only-modality LLM. Use time-stamped sections, an inventory of audible ' +
  'elements, and explicit transcription of any speech or lyrics. Mark anything ' +
  'uncertain as uncertain rather than smoothing it over.';

export async function handleGetUserAudio({ limit }, context) {
  try {
    const userId = context.getStore()?.userId;
    if (!userId) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Authenticated user context is required.' }],
      };
    }
    const files = await listUserAudio(userId, limit || 10);

    if (!files.length) {
      return {
        content: [
          {
            type: 'text',
            text: 'No audio files uploaded by this user. Ask them to attach one to the conversation first.',
          },
        ],
      };
    }

    const list = files
      .map((f, i) => {
        const mb = f.bytes ? ` — ${(f.bytes / 1024 / 1024).toFixed(1)} MB` : '';
        return `${i + 1}. [INDEX_${i + 1}] file_id: "${f.file_id}" — ${f.filename} (${f.type})${mb}`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text:
            `Found ${files.length} audio file(s), newest first:\n${list}\n\n` +
            "Pass either the file_id or the index ('1', 'INDEX_1') as `file_id` to listen_to_audio.",
        },
      ],
    };
  } catch (err) {
    console.error('get_user_audio failed:', err.message);
    return {
      isError: true,
      content: [{ type: 'text', text: `Error listing audio: ${err.message}` }],
    };
  }
}

/**
 * Per-user spend guard, same shape and same reasoning as mcp-image-gen's: the
 * OpenRouter key is server-wide, so the limit is what bounds who can spend on it.
 * Measured on gemini-3.8-flash: 45s of shrunk audio cost $0.0047, most of it the
 * ~950 output tokens rather than the audio itself, so a full track lands around a
 * cent — roughly an image. A 90-minute podcast chunks into a dozen of those.
 */
export function remainingWeeklyBudget(spend, limit = WEEKLY_BUDGET_USD) {
  return Math.max(0, limit - spend);
}

export function hasKnownUsageCost(usage) {
  const callCosts = Array.isArray(usage?.calls) ? usage.calls.map((call) => call?.cost) : [];
  return (
    callCosts.length > 0 &&
    callCosts.every((cost) => Number.isFinite(cost) && cost >= 0) &&
    Number.isFinite(usage?.cost_total) &&
    usage.cost_total >= 0 &&
    Math.abs(callCosts.reduce((sum, cost) => sum + cost, 0) - usage.cost_total) < 1e-9
  );
}

export async function reserveBudget(userId, dbOverride, hooks = {}) {
  if (!userId) {
    return { allowed: false, reason: 'Authenticated user context is required.' };
  }
  const db = dbOverride ?? (await getDb());
  const now = new Date();
  const userObjectId = new ObjectId(userId);
  const owner = crypto.randomUUID();
  const locks = db.collection('mcp_audio_ears_locks');
  await locks.updateOne(
    { _id: userObjectId },
    { $setOnInsert: { leaseUntil: new Date(0) } },
    { upsert: true },
  );
  const lock = await locks.findOneAndUpdate(
    { _id: userObjectId, leaseUntil: { $lte: now } },
    { $set: { owner, leaseUntil: new Date(now.getTime() + LOCK_LEASE_MS) } },
    { returnDocument: 'after' },
  );
  if (!lock || lock.owner !== owner) {
    return { allowed: false, reason: 'Another listen is already running for this user.' };
  }

  const usage = db.collection('mcp_audio_ears_usage');
  const rows = await usage
    .find(
      { userId: userObjectId, createdAt: { $gte: new Date(now.getTime() - WEEK_MS) } },
      { projection: { cost: 1, reservedCost: 1 } },
    )
    .toArray()
    .catch(async (err) => {
      await locks.updateOne(
        { _id: userObjectId, owner },
        { $set: { leaseUntil: new Date(0) }, $unset: { owner: '' } },
      );
      throw err;
    });
  const spend = rows.reduce((sum, row) => {
    if (Number.isFinite(row.cost) && row.cost >= 0) {
      return sum + row.cost;
    }
    if (Number.isFinite(row.reservedCost) && row.reservedCost >= 0) {
      return sum + row.reservedCost;
    }
    return sum + WEEKLY_BUDGET_USD;
  }, 0);
  const reservedCost = remainingWeeklyBudget(spend);
  if (reservedCost <= 0) {
    await locks.updateOne(
      { _id: userObjectId, owner },
      { $set: { leaseUntil: new Date(0) }, $unset: { owner: '' } },
    );
    return {
      allowed: false,
      reason: `Weekly $${WEEKLY_BUDGET_USD.toFixed(2)} audio budget reached.`,
    };
  }

  const reservation = await usage
    .insertOne({
      userId: userObjectId,
      createdAt: now,
      cost: null,
      reservedCost,
      status: 'running',
    })
    .catch(async (err) => {
      await locks.updateOne(
        { _id: userObjectId, owner },
        { $set: { leaseUntil: new Date(0) }, $unset: { owner: '' } },
      );
      throw err;
    });
  await hooks.afterReservationInserted?.({ db, userObjectId, owner });
  const fenced = await locks.findOneAndUpdate(
    { _id: userObjectId, owner, leaseUntil: { $gt: new Date() } },
    { $set: { leaseUntil: new Date(Date.now() + LOCK_LEASE_MS) } },
    { returnDocument: 'after' },
  );
  if (!fenced || fenced.owner !== owner) {
    await usage.updateOne(
      { _id: reservation.insertedId, status: 'running' },
      { $set: { cost: 0, reservedCost: 0, status: 'canceled' } },
    );
    return { allowed: false, reason: 'Audio budget lock changed before dispatch.' };
  }
  return {
    allowed: true,
    db,
    owner,
    userObjectId,
    reservationId: reservation.insertedId,
    reservedCost,
  };
}

/**
 * One row per listen. `cost` is OpenRouter's settled figure, summed across chunks.
 * Same reason as the image sidecar: this spend never reaches LibreChat's
 * `transactions` collection, so this collection is the only record it exists.
 */
export async function settleUsage(reservation, record, model, usage, meta) {
  if (!reservation?.allowed) return;
  try {
    const knownCost = hasKnownUsageCost(usage);
    const knownPartialCost = Array.isArray(usage?.calls)
      ? usage.calls.reduce(
          (sum, call) => (Number.isFinite(call?.cost) && call.cost >= 0 ? sum + call.cost : sum),
          0,
        )
      : 0;
    await reservation.db.collection('mcp_audio_ears_usage').updateOne(
      { _id: reservation.reservationId },
      {
        $set: {
          file_id: record?.file_id ?? null,
          filename: record?.filename ?? null,
          bytes: record?.bytes ?? null,
          model,
          cost: knownCost ? usage.cost_total : null,
          knownPartialCost,
          reservedCost: knownCost ? 0 : reservation.reservedCost,
          status: knownCost ? 'settled' : 'unknown',
          audioTokens: usage?.audio_tokens_total ?? null,
          calls: usage?.calls?.length ?? null,
          usage: usage ?? null,
          ...meta,
        },
      },
    );
  } catch (err) {
    console.error('Failed to log audio usage:', err.message);
  }
}

export async function releaseBudgetLock(reservation) {
  if (!reservation?.allowed) return;
  await reservation.db
    .collection('mcp_audio_ears_locks')
    .updateOne(
      { _id: reservation.userObjectId, owner: reservation.owner },
      { $set: { leaseUntil: new Date(0) }, $unset: { owner: '' } },
    );
}

function runScript(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      'python3',
      [SCRIPT, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          OPENROUTER_API_KEY: process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY || '',
        },
      },
      (err, stdout, stderr) => resolve({ err, stdout, stderr }),
    );
  });
}

export async function handleListenToAudio(
  { file_id, focus, style, max_seconds, shrink, model, cross_check },
  context,
) {
  let usagePath = null;
  let reservation = null;
  let usage = null;
  let record = null;
  let chosenModel = model || MODEL;
  try {
    if (!(process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY)) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'OPENROUTER_KEY is not set on the audio server.' }],
      };
    }

    const userId = context.getStore()?.userId;
    record = await resolveAudioRecord(file_id, userId);
    const absolute = await resolveAudioPath(record);
    reservation = await reserveBudget(userId);
    if (!reservation.allowed) {
      return { isError: true, content: [{ type: 'text', text: `Limit: ${reservation.reason}` }] };
    }

    usagePath = path.join(
      os.tmpdir(),
      `ears-usage-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    const args = [
      absolute,
      '--model',
      chosenModel,
      '--usage-json',
      usagePath,
      '--budget-usd',
      String(reservation.reservedCost),
    ];
    if (style === 'analyze') args.push('--prompt', ANALYZE_PROMPT);
    if (focus) args.push('--prompt-suffix', focus);
    if (max_seconds) args.push('--max-seconds', String(max_seconds));
    if (shrink) args.push('--shrink');
    if (cross_check) args.push('--cross-check');

    console.log(
      `listen_to_audio: ${record.filename} (${record.bytes} bytes) -> ${chosenModel}` +
        `${cross_check ? ' + cross-check' : ''}${shrink ? ' [shrunk]' : ''}`,
    );

    const { err, stdout, stderr } = await runScript(args, RUN_TIMEOUT_MS);

    try {
      usage = JSON.parse(await fs.readFile(usagePath, 'utf8'));
    } catch {
      /* no usage file: the script died before writing one */
    }
    await settleUsage(reservation, record, chosenModel, usage, {
      style: style || 'feel',
      failed: Boolean(err),
    });

    if (err) {
      // The script writes its own diagnostics to stderr and exits non-zero with a
      // one-line reason; both are more useful to the model than "exit code 1".
      const detail = (stderr || err.message || '').trim().slice(-800);
      const killed = err.killed || err.signal === 'SIGTERM';
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: killed
              ? `Listening timed out after ${RUN_TIMEOUT_MS / 1000}s. Retry with shrink: true, or max_seconds to sample the opening.\n\n${detail}`
              : `Listening failed: ${detail}`,
          },
        ],
      };
    }

    // audio_tokens == 0 means the model was handed the audio and ignored it; the
    // description would then be invented from the prompt alone. The script marks
    // this inline too, but a model reading a tool result skims — say it up front.
    const zeroAudio = usage && usage.audio_tokens_total === 0;
    const banner = zeroAudio
      ? `> **WARNING: ${chosenModel} reported 0 audio tokens — it did not ingest the audio. ` +
        'Everything below was invented from the prompt. Do not relay it; try another model.**\n\n'
      : '';

    const footer =
      usage && usage.cost_total != null
        ? `\n\n_listened via ${chosenModel} · ${usage.audio_tokens_total} audio tokens · $${usage.cost_total.toFixed(5)}_`
        : '';

    return { content: [{ type: 'text', text: banner + stdout.trim() + footer }] };
  } catch (err) {
    console.error('listen_to_audio failed:', err.message);
    await settleUsage(reservation, record, chosenModel, usage, {
      style: style || 'feel',
      failed: true,
    });
    return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
  } finally {
    await releaseBudgetLock(reservation).catch((err) =>
      console.error('Failed to release audio budget lock:', err.message),
    );
    if (usagePath) {
      fs.unlink(usagePath).catch(() => {});
    }
  }
}
