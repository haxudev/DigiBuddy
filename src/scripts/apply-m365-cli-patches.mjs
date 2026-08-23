import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const sourceRoot = join(rootDir, 'vendor', 'm365-cli');
const targetRoot = join(rootDir, 'node_modules', 'm365-cli');

const patchFiles = [
  'src/commands/mail.js',
  'src/graph/client.js',
];

if (!existsSync(targetRoot)) {
  throw new Error(`m365-cli is not installed at ${targetRoot}`);
}

for (const relativePath of patchFiles) {
  const sourcePath = join(sourceRoot, relativePath);
  const targetPath = join(targetRoot, relativePath);

  if (!existsSync(sourcePath)) {
    throw new Error(`Missing patch source file: ${sourcePath}`);
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
  console.log(`Applied m365-cli patch: ${relativePath}`);
}