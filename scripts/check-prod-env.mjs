// Boot check for production env files.
// Usage:
//   npm run build && npm run check:prod
//   npm run check:prod -- --env-file=.env.production
// Exit 0 = boot would proceed; exit 1 = validateEnv /
// assertSecureProductionConfig refused, with the reason printed.
// Real environment variables always win over the file (same as src/main.ts).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseEnvFile(path) {
  const vars = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[line.slice(0, eq).trim()] = value;
  }
  return vars;
}

const args = process.argv.slice(2);
const fileFlag = args.find((a) => a.startsWith('--env-file='));
const fileArg = fileFlag ? fileFlag.slice('--env-file='.length) : '.env.production.example';
const envFile = resolve(process.cwd(), fileArg);

if (!existsSync(envFile)) {
  console.error(`[check:prod] env file not found: ${envFile}`);
  process.exit(1);
}

let validateEnv;
let assertSecureProductionConfig;
try {
  ({ validateEnv, assertSecureProductionConfig } = await import('../dist/config/env.js'));
} catch {
  console.error('[check:prod] FAIL — could not load dist/config/env.js. Run `npm run build` first.');
  process.exit(1);
}

// File first, real environment wins — mirrors src/main.ts load order.
const fileVars = parseEnvFile(envFile);
const merged = { ...fileVars, ...process.env };

// Only keys the file declares count toward placeholders: an unrelated process
// variable that happens to contain CHANGE_ME must not fail the check.
const leftovers = Object.keys(fileVars).filter(
  (k) => typeof merged[k] === 'string' && merged[k].includes('CHANGE_ME')
);
if (leftovers.length > 0) {
  console.error(`[check:prod] FAIL — ${leftovers.length} placeholder(s) still set in ${envFile}:`);
  for (const k of leftovers) console.error(`  - ${k}`);
  process.exit(1);
}

try {
  const config = validateEnv(merged);
  assertSecureProductionConfig(config);
} catch (error) {
  console.error(`[check:prod] FAIL — ${envFile} would refuse to boot:`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log(`[check:prod] OK — ${envFile} passes validateEnv + assertSecureProductionConfig.`);
