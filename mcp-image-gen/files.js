import fs from 'fs/promises';
import path from 'path';
import { ObjectId } from 'mongodb';
import { getDb } from './db.js';

const UPLOADS_DIR = '/app/uploads';
const IMAGES_DIR = '/app/images';

export function extractFileId(input) {
  if (!input) return null;
  let segment = input;
  if (input.includes('/')) {
    const parts = input.split('/');
    segment = parts[parts.length - 1];
  }
  const withoutExt = segment.includes('.') ? segment.split('.').slice(0, -1).join('.') : segment;
  return withoutExt.includes('__') ? withoutExt.split('__')[0] : withoutExt;
}

export async function fetchImageById(fileId, userId) {
  if (!userId) {
    throw new Error('Authenticated user context is required.');
  }
  const db = await getDb();
  const fileRecord = await db
    .collection('files')
    .findOne({ file_id: fileId, user: new ObjectId(userId) });
  if (!fileRecord) {
    throw new Error(`Image not found for file_id ${fileId} belonging to this user.`);
  }

  const relativePath = fileRecord.filepath;
  let absolutePath;
  let root;

  if (relativePath.startsWith('/images/') || relativePath.startsWith('images/')) {
    const cleanPath = relativePath.replace(/^(\/)?images\//, '');
    root = IMAGES_DIR;
    absolutePath = path.resolve(root, cleanPath);
  } else {
    const cleanPath = relativePath.replace(/^(\/)?uploads\//, '');
    root = UPLOADS_DIR;
    absolutePath = path.resolve(root, cleanPath);
  }
  if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) {
    throw new Error(`Refusing to read outside the image mounts: ${relativePath}`);
  }

  console.log(`Reading file directly from disk: ${absolutePath}`);
  const buffer = await fs.readFile(absolutePath);

  return {
    buffer,
    contentType: fileRecord.type || 'image/png',
  };
}
