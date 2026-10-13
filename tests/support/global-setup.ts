import type { TestProject } from 'vitest/node';
import { startTestDatabase, type TestDatabase } from './database.ts';

let db: TestDatabase | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  db = await startTestDatabase();
  project.provide('database', db.info);
  return async () => {
    await db?.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    database: import('./database.ts').TestDatabaseInfo;
  }
}
