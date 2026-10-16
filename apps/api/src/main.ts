/** Process entry point for one cell's API. Refuses to start unless every boot check passes (INV-9). */
import { assertBoot } from '@sevari/boot';
import { FakeSmsProvider, signedWebhookAdapter, smsAdapter, webformAdapter } from '@sevari/channels';
import { SystemClock } from '@sevari/clock';
import { LocalKeyFileKms, TenantKeyring } from '@sevari/crypto';
import { connect, sql } from '@sevari/db';
import { regionCode } from '@sevari/domain';
import { z } from 'zod';
import { buildServer } from './server.ts';
import { TokenBucketLimiter } from './rate-limit.ts';

const Env = z.object({
  SEVARI_DATABASE_URL: z.string().url(),
  SEVARI_REGION: z.string(),
  SEVARI_CONFIG_DIR: z.string().default('config'),
  SEVARI_KEK_FILE: z.string(),
  SEVARI_PUBLIC_BASE_URL: z.string().url(),
  SEVARI_CELL_URLS: z.string().default('{}'),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('127.0.0.1'),
});
const env = Env.parse(process.env);
const clock = new SystemClock();
const handle = connect(env.SEVARI_DATABASE_URL, { onIdleError: (e) => console.error('db idle error', e.message) });
const kms = await LocalKeyFileKms.fromFile(env.SEVARI_KEK_FILE);
await assertBoot({
  db: handle.db, kms, clock, region: env.SEVARI_REGION, configDir: env.SEVARI_CONFIG_DIR,
  egressPolicyPath: `${env.SEVARI_CONFIG_DIR}/egress.allowlist.yaml`,
});
const app = buildServer({
  intake: {
    db: handle.db, keyring: new TenantKeyring(kms), clock, cellRegion: regionCode(env.SEVARI_REGION),
    cellUrls: z.record(z.string(), z.string().url()).parse(JSON.parse(env.SEVARI_CELL_URLS)),
    // SMS uses the fake provider until the Twilio ADR is approved (§57).
    adapters: { webform: webformAdapter, email: signedWebhookAdapter('email'), api: signedWebhookAdapter('api'), sms: smsAdapter(FakeSmsProvider) },
  },
  publicBaseUrl: env.SEVARI_PUBLIC_BASE_URL,
  limiter: new TokenBucketLimiter(clock, { capacity: 30, perMinute: 60 }),
  ready: async () => (await sql`SELECT 1`.execute(handle.db).then(() => true, () => false)),
  logger: true,
});
await app.listen({ port: env.PORT, host: env.HOST });
const shutdown = async () => {
  await app.close();
  await handle.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
