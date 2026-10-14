import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Starting the built API as real server processes, for the claims that are about what
 * several *processes* do together rather than what one server does.
 *
 * Every other test suite runs the API inside the test's own process. That is enough for
 * behaviour a single server owns — a route's answer, a policy's arithmetic — but it cannot
 * show anything about two instances sharing one database: whether an idempotency key
 * written by one process answers a retry at another, or whether a request budget is the
 * deployment's or each process's own. Those need separate PIDs, separate connections and a
 * shared file, which is what this starts.
 *
 * `dist/` is checked before anything boots: a test that quietly ran against a stale build
 * would prove nothing about the source it names.
 */

const PROJECT_ROOT = process.cwd();
const SERVER_ENTRY = resolve(PROJECT_ROOT, 'dist', 'main.js');

/** Shared by the processes an individual test boots, so a token lifts from one to another. */
export const TEST_JWT_SECRET = 'cross_process_test_jwt_secret_long_enough';

export interface ServerProcess {
  pid: number;
  url: string;
  output(): string;
  stop(): Promise<void>;
}

export interface BootOptions {
  /** The database file this process serves. Two processes given one file share its state. */
  databaseFile: string;
  /** Environment for this process, on top of the defaults a test deployment needs. */
  env?: Record<string, string>;
  /** How long to wait for the process to answer. */
  readyTimeoutMs?: number;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newestSourceMtimeMs(): number {
  const newestIn = (path: string): number => {
    let newest = 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      newest = Math.max(newest, entry.isDirectory() ? newestIn(full) : statSync(full).mtimeMs);
    }
    return newest;
  };

  const candidates = [newestIn(join(PROJECT_ROOT, 'src'))];
  for (const config of ['tsconfig.json', 'package.json']) {
    const path = join(PROJECT_ROOT, config);
    if (existsSync(path)) candidates.push(statSync(path).mtimeMs);
  }
  return Math.max(...candidates);
}

/**
 * Compiles the API when `dist/` is missing or older than the source, and refuses to go on if
 * that build fails. The alternative — running whatever `dist/` happens to contain — is how
 * a test passes while the code it names is broken.
 */
export function ensureBuiltServer(): void {
  const builtAt = existsSync(SERVER_ENTRY) ? statSync(SERVER_ENTRY).mtimeMs : 0;
  if (builtAt > newestSourceMtimeMs()) return;

  const build = spawnSync('npm', ['run', 'build'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });
  if (build.status !== 0) {
    throw new Error(
      `A cross-process test needs a current build and 'npm run build' failed (exit ${String(build.status)}).\n${build.stdout ?? ''}\n${build.stderr ?? ''}`
    );
  }
}

/** Starts one server process and waits until it answers `/health`. */
export async function bootServer(options: BootOptions): Promise<ServerProcess> {
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: '0',
      SQLITE_STORAGE_PATH: options.databaseFile,
      JWT_SECRET: TEST_JWT_SECRET,
      SMS_MOCK_MODE: 'true',
      LOG_LEVEL: 'info',
      ...options.env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const lines: string[] = [];
  let url: string | null = null;
  const collect = (chunk: Buffer): void => {
    for (const raw of String(chunk).split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      lines.push(line);
      try {
        const entry = JSON.parse(line) as { message?: unknown };
        if (typeof entry.message === 'string') {
          url = entry.message.match(/listening on (http:\/\/\S+)/)?.[1] ?? url;
        }
      } catch {
        /* not a structured log line */
      }
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const output = (): string => lines.join('\n');
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const killed = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]);
    if (!killed && child.exitCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  };

  // Readiness is polled through `/health`, which the rate limiter exempts — so waiting for
  // a process configured with a tiny request budget does not spend that budget.
  const deadline = Date.now() + (options.readyTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    await sleep(100);
    if (url !== null) {
      try {
        const health = await fetch(`${url}/health`);
        if (health.status === 200) {
          return { pid: child.pid ?? -1, url, output, stop };
        }
      } catch {
        /* still starting */
      }
    }
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`A server process exited with code ${String(child.exitCode)} before answering:\n${output()}`);
    }
  }

  await stop();
  throw new Error(`A server process never became ready:\n${output()}`);
}

/** Stops every process that is still running, so a failing test cannot leak one. */
export async function stopAll(processes: (ServerProcess | undefined)[]): Promise<void> {
  for (const process of processes) {
    await process?.stop();
  }
}
