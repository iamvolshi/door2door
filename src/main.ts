import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Process entry point for the API (`npm start`).
 *
 * Configuration is validated the moment `src/config/env.ts` is imported, so `.env`
 * must be loaded first — hence the dynamic import of the server below. Values already
 * present in the real environment always win over the file (Node's own semantics).
 */
function loadDotEnvFile(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  process.loadEnvFile(envPath);
}

async function main(): Promise<void> {
  loadDotEnvFile();

  const [{ startServer }, { logger }] = await Promise.all([
    import('./server.js'),
    import('./core/logger.js')
  ]);

  const running = await startServer();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down gracefully`);
    try {
      await running.close();
      process.exit(0);
    } catch (error) {
      logger.error('Graceful shutdown failed', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error: unknown) => {
  const { logger } = await import('./core/logger.js');
  logger.error("Failed to start Cox's Bazar Door2Door API", error);
  process.exit(1);
});
