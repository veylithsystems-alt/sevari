import { inject } from 'vitest';
import pg from 'pg';
import type { TestDatabaseInfo } from './database.ts';

export function dbInfo(): Required<Pick<TestDatabaseInfo, 'superUrl' | 'ownerUrl' | 'appUrl' | 'workerUrl' | 'database'>> {
  const info = inject('database');
  if (!info.available || !info.appUrl || !info.ownerUrl || !info.superUrl || !info.workerUrl || !info.database) {
    throw new Error(info.reason ?? 'Test database unavailable');
  }
  return { superUrl: info.superUrl, ownerUrl: info.ownerUrl, appUrl: info.appUrl, workerUrl: info.workerUrl, database: info.database };
}

export function pool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

/** A fresh, fully migrated database for tests that alter schema or roles. Call the returned drop() in afterAll. */
export async function isolatedDatabase(): Promise<{ superUrl: string; ownerUrl: string; appUrl: string; workerUrl: string; database: string; drop(): Promise<void> }> {
  const info = inject('database');
  if (!info.serverUrl) throw new Error(info.reason ?? 'Test database unavailable');
  const { prepare, dropDatabase } = await import('./database.ts');
  const fresh = await prepare(info.serverUrl);
  return {
    superUrl: fresh.superUrl!, ownerUrl: fresh.ownerUrl!, appUrl: fresh.appUrl!, workerUrl: fresh.workerUrl!, database: fresh.database!,
    drop: () => dropDatabase(info.serverUrl!, fresh.database!),
  };
}
