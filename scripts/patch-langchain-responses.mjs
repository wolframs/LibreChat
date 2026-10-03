import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['responses.js', 'responses.cjs'].map((name) =>
  path.join(root, 'node_modules', '@langchain', 'openai', 'dist', 'converters', name),
);
const declaration = 'const cleanedOutput = response.output.map((item) => {';
const replacement = [
  'const responseOutput = Array.isArray(response.output) ? response.output : [];',
  '\tconst cleanedOutput = responseOutput.map((item) => {',
].join('\n');
const overIndentedReplacement = replacement.replace(
  '\n\tconst cleanedOutput',
  '\n\t\tconst cleanedOutput',
);
const iteration = 'for (const item of response.output) if (item.type === "message")';
const replacedIteration = 'for (const item of responseOutput) if (item.type === "message")';

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(replacement) && source.includes(replacedIteration)) {
    continue;
  }
  if (source.includes(overIndentedReplacement) && source.includes(replacedIteration)) {
    fs.writeFileSync(file, source.replace(overIndentedReplacement, replacement));
    continue;
  }
  if (!source.includes(declaration) || !source.includes(iteration)) {
    throw new Error(`Unsupported @langchain/openai Responses converter: ${file}`);
  }
  const patched = source.replace(declaration, replacement).replace(iteration, replacedIteration);
  fs.writeFileSync(file, patched);
}
