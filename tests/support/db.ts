import { inject } from 'vitest';
import pg from 'pg';
import type { TestDatabaseInfo } from './database.ts';

export function dbInfo(): Required<Pick<TestDatabaseInfo, 'superUrl' | 'ownerUrl' | 'appUrl' | 'database'>> {
  const info = inject('database');
  if (!info.available || !info.appUrl || !info.ownerUrl || !info.superUrl || !info.database) {
    throw new Error(info.reason ?? 'Test database unavailable');
  }
  return { superUrl: info.superUrl, ownerUrl: info.ownerUrl, appUrl: info.appUrl, database: info.database };
}

export function pool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}
