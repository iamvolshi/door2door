import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SEEDED,
  createTempDatabaseDir,
  getJson,
  removeTempDatabaseDir,
  startServer,
  type RunningServer
} from './apiTestClient';

/**
 * The storefront directory: what a customer browses before signing in. Public like
 * the menu, and carrying nothing a visitor must not see — no licence numbers, no
 * owner ids, no phone numbers.
 */
let tempDir: string;
let app: RunningServer;

beforeAll(async () => {
  tempDir = createTempDatabaseDir();
  app = await startServer({
    port: 0,
    host: '127.0.0.1',
    databaseFile: `${tempDir}/discovery.sqlite`
  });
});

afterAll(async () => {
  await app?.close();
  removeTempDatabaseDir(tempDir);
});

describe('GET /api/v1/merchants', () => {
  it('lists storefronts publicly, with no owner-identifying columns', async () => {
    const response = await getJson(app, '/api/v1/merchants');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.count).toBeGreaterThan(0);
    const ids = response.body.merchants.map((store: { id: string }) => store.id);
    expect(ids).toContain(SEEDED.merchantId);
    for (const store of response.body.merchants) {
      expect(Object.keys(store).sort()).toEqual(
        ['businessName', 'category', 'description', 'id', 'isOpen', 'rating'].sort()
      );
    }
  });
});
