import fs from 'fs/promises';
import path from 'path';
import { ObjectId } from 'mongodb';
import { getDb } from './db.js';

/**
 * Must match what the api container writes:  api:  ./uploads -> /app/uploads
 * (file records carry `filepath: /uploads/<userId>/<file_id>__<name>`).
 *
 * Unlike images, audio never lands in ./images — LibreChat only routes generated
 * and pasted images there — so there is one root here, not two.
 */
const UPLOADS_DIR = '/app/uploads';

/** Same set the picker accepts; `audio/mpeg` is the common one (mp3). */
const AUDIO_TYPE_RE = /^audio\//;

/**
 * Resolve a file_id, or a 1-based index as handed out by `get_user_audio`, to a
 * `files` record. Scoped to the calling user: a file_id belonging to somebody
 * else on this stack resolves to nothing rather than to their audio.
 */
export async function resolveAudioRecord(input, userId) {
  const db = await getDb();
  const raw = String(input ?? '').trim();
  if (!raw) {
    throw new Error('No file_id given. Call get_user_audio first to list what is available.');
  }

  const indexMatch = raw.toUpperCase().match(/^(INDEX_)?(\d+)$/);
  if (indexMatch) {
    if (!userId) {
      throw new Error(
        `Cannot resolve index "${raw}": no user context on this request. Pass a file_id instead.`,
      );
    }
    const idx = parseInt(indexMatch[2], 10) - 1;
    const files = await listUserAudio(userId, Math.max(idx + 1, 10));
    if (!files[idx]) {
      throw new Error(
        `Index "${raw}" is out of range — ${files.length} audio file(s) available. Call get_user_audio.`,
      );
    }
    return files[idx];
  }

  const query = { file_id: raw };
  if (userId) {
    query.user = new ObjectId(userId);
  }
  const record = await db.collection('files').findOne(query);
  if (!record) {
    throw new Error(
      `No audio file found for file_id "${raw}" belonging to this user. Call get_user_audio to list what is available.`,
    );
  }
  if (!AUDIO_TYPE_RE.test(record.type ?? '')) {
    throw new Error(
      `File "${record.filename}" is ${record.type || 'of unknown type'}, not audio. This tool only listens to audio.`,
    );
  }
  return record;
}

/** Recent audio uploads for one user, newest first. */
export async function listUserAudio(userId, limit = 10) {
  const db = await getDb();
  const query = { type: { $regex: AUDIO_TYPE_RE } };
  if (userId) {
    query.user = new ObjectId(userId);
  }
  return db.collection('files').find(query).sort({ createdAt: -1 }).limit(limit).toArray();
}

/**
 * Absolute on-disk path for a `files` record, guarded against a `filepath` that
 * tries to climb out of the uploads mount.
 */
export async function resolveAudioPath(record) {
  const relative = String(record.filepath ?? '').replace(/^(\/)?uploads\//, '');
  const absolute = path.resolve(UPLOADS_DIR, relative);
  if (absolute !== UPLOADS_DIR && !absolute.startsWith(UPLOADS_DIR + path.sep)) {
    throw new Error(`Refusing to read outside the uploads mount: ${record.filepath}`);
  }
  await fs.access(absolute);
  return absolute;
}
