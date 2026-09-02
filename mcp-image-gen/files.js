import fs from 'fs/promises';
import path from 'path';
import { getDb } from './db.js';

const UPLOADS_DIR = "/app/uploads";
const IMAGES_DIR = "/app/images";

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

export async function fetchImageById(fileId) {
  const db = await getDb();
  const fileRecord = await db.collection('files').findOne({ file_id: fileId });
  if (!fileRecord) {
    throw new Error(`File details not found in MongoDB for file_id: ${fileId}`);
  }

  const relativePath = fileRecord.filepath;
  let absolutePath;

  if (relativePath.startsWith('/images/') || relativePath.startsWith('images/')) {
    const cleanPath = relativePath.replace(/^(\/)?images\//, '');
    absolutePath = path.join(IMAGES_DIR, cleanPath);
  } else {
    const cleanPath = relativePath.replace(/^(\/)?uploads\//, '');
    absolutePath = path.join(UPLOADS_DIR, cleanPath);
  }

  console.log(`Reading file directly from disk: ${absolutePath}`);
  const buffer = await fs.readFile(absolutePath);

  return {
    buffer,
    contentType: fileRecord.type || 'image/png',
  };
}
