import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { bootstrapCluster, runMigrations } from '@sevari/db/admin';

export interface TestDatabaseInfo {
  readonly available: boolean;
  readonly reason?: string;
  /** Superuser connection to the test database (setup and inspection only). */
  readonly superUrl?: string;
  /** Migration owner role. Owns the tables. */
  readonly ownerUrl?: string;
  /** Application role: NOBYPASSRLS, not the owner. Every isolation test runs as this. */
  readonly appUrl?: string;
  readonly database?: string;
}

export interface TestDatabase {
  readonly info: TestDatabaseInfo;
  stop(): Promise<void>;
}

// Test-only credentials for throwaway databases. Never used outside tests (see .gitleaks.toml allowlist).
export const TEST_PASSWORDS = { owner: 'owner_test_only', app: 'app_test_only' } as const;

function withDb(url: string, database: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

async function prepare(adminUrl: string): Promise<TestDatabaseInfo> {
  const database = `sevari_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${database}`);
  } finally {
    await admin.end();
  }
  const superUrl = withDb(adminUrl, database);
  await bootstrapCluster({ superUrl, database, ownerPassword: TEST_PASSWORDS.owner, appPassword: TEST_PASSWORDS.app });
  const ownerUrl = withDb(adminUrl, database, 'sevari_owner', TEST_PASSWORDS.owner);
  const appUrl = withDb(adminUrl, database, 'sevari_app', TEST_PASSWORDS.app);
  await runMigrations({ ownerUrl });
  return { available: true, superUrl, ownerUrl, appUrl, database };
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const external = process.env['SEVARI_TEST_DATABASE_URL'];
  if (external) {
    const info = await prepare(external);
    return {
      info,
      async stop() {
        const admin = new pg.Client({ connectionString: external });
        await admin.connect();
        try {
          await admin.query(`DROP DATABASE IF EXISTS ${info.database} WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      },
    };
  }
  try {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const info = await prepare(container.getConnectionUri());
    return { info, stop: async () => void (await container.stop()) };
  } catch (err) {
    const reason = `No test database: set SEVARI_TEST_DATABASE_URL or run Docker for Testcontainers (${(err as Error).message})`;
    return { info: { available: false, reason }, stop: async () => undefined };
  }
}
