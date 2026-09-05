import { execFile } from 'child_process';
import { ObjectId } from 'mongodb';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getDb } from './db.js';
import { resolveAudioRecord, resolveAudioPath, listUserAudio } from './files.js';

export const MODEL = process.env.AUDIO_EARS_MODEL || 'google/gemini-3.8-flash';

const SCRIPT = '/app/describe_audio.py';
const DAILY_LIMIT = parseInt(process.env.AUDIO_EARS_DAILY_LIMIT ?? '20', 10);
const COOLDOWN_SEC = parseInt(process.env.AUDIO_EARS_COOLDOWN_SEC ?? '5', 10);
/** Wall-clock ceiling for one listen, chunking included. */
const RUN_TIMEOUT_MS = parseInt(process.env.AUDIO_EARS_TIMEOUT_SEC ?? '600', 10) * 1000;

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
    return { isError: true, content: [{ type: 'text', text: `Error listing audio: ${err.message}` }] };
  }
}

/**
 * Per-user spend guard, same shape and same reasoning as mcp-image-gen's: the
 * OpenRouter key is server-wide, so the limit is what bounds who can spend on it.
 * Measured on gemini-3.8-flash: 45s of shrunk audio cost $0.0047, most of it the
 * ~950 output tokens rather than the audio itself, so a full track lands around a
 * cent — roughly an image. A 90-minute podcast chunks into a dozen of those.
 */
async function checkLimit(userId) {
  if (!userId) {
    console.warn('No userId on this request; allowing the listen unmetered.');
    return { allowed: true };
  }
  const db = await getDb();
  const now = new Date();
  const userObjectId = new ObjectId(userId);

  if (COOLDOWN_SEC > 0) {
    const last = await db
      .collection('mcp_audio_ears_usage')
      .findOne({ userId: userObjectId }, { sort: { createdAt: -1 } });
    if (last) {
      const elapsed = Math.floor((now.getTime() - last.createdAt.getTime()) / 1000);
      if (elapsed < COOLDOWN_SEC) {
        return { allowed: false, reason: `Wait ${COOLDOWN_SEC - elapsed}s before the next listen.` };
      }
    }
  }

  if (DAILY_LIMIT > 0) {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const count = await db
      .collection('mcp_audio_ears_usage')
      .countDocuments({ userId: userObjectId, createdAt: { $gte: startOfDay } });
    if (count >= DAILY_LIMIT) {
      return { allowed: false, reason: `Daily limit of ${DAILY_LIMIT} listens reached.` };
    }
  }

  return { allowed: true };
}

/**
 * One row per listen. `cost` is OpenRouter's settled figure, summed across chunks.
 * Same reason as the image sidecar: this spend never reaches LibreChat's
 * `transactions` collection, so this collection is the only record it exists.
 */
async function logUsage(userId, record, model, usage, meta) {
  if (!userId) return;
  try {
    const db = await getDb();
    await db.collection('mcp_audio_ears_usage').insertOne({
      userId: new ObjectId(userId),
      createdAt: new Date(),
      file_id: record?.file_id ?? null,
      filename: record?.filename ?? null,
      bytes: record?.bytes ?? null,
      model,
      cost: usage?.cost_total ?? null,
      audioTokens: usage?.audio_tokens_total ?? null,
      calls: usage?.calls?.length ?? null,
      usage: usage ?? null,
      ...meta,
    });
  } catch (err) {
    console.error('Failed to log audio usage:', err.message);
  }
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
  try {
    if (!(process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY)) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'OPENROUTER_KEY is not set on the audio server.' }],
      };
    }

    const userId = context.getStore()?.userId;
    const limitCheck = await checkLimit(userId);
    if (!limitCheck.allowed) {
      return { isError: true, content: [{ type: 'text', text: `Limit: ${limitCheck.reason}` }] };
    }

    const record = await resolveAudioRecord(file_id, userId);
    const absolute = await resolveAudioPath(record);
    const chosenModel = model || MODEL;

    usagePath = path.join(os.tmpdir(), `ears-usage-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const args = [absolute, '--model', chosenModel, '--usage-json', usagePath];
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

    let usage = null;
    try {
      usage = JSON.parse(await fs.readFile(usagePath, 'utf8'));
    } catch {
      /* no usage file: the script died before writing one */
    }
    await logUsage(userId, record, chosenModel, usage, {
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
    return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
  } finally {
    if (usagePath) {
      fs.unlink(usagePath).catch(() => {});
    }
  }
}
