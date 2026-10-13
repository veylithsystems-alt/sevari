// Contract §4 lint rules. Each rule maps to a contract line; changing one is a contract amendment.
const norm = (f) => f.replaceAll('\\', '/');
const inPkg = (filename, pkg) => norm(filename).includes(`/packages/${pkg}/`);
const isTestFile = (filename) => /\/(test|tests)\//.test(norm(filename)) || /\.test\.ts$/.test(filename);

const NETWORK_MODULES = new Set([
  'http', 'https', 'node:http', 'node:https', 'http2', 'node:http2', 'net', 'node:net', 'tls', 'node:tls',
  'dgram', 'node:dgram', 'axios', 'undici', 'node-fetch', 'got', 'ky', 'superagent',
]);

/** §4: No fetch/http/https/axios/undici imports outside packages/egress. */
const noNetworkOutsideEgress = {
  meta: { type: 'problem', docs: { description: 'Network I/O only via @sevari/egress (INV-3)' }, schema: [] },
  create(context) {
    const filename = context.filename;
    if (inPkg(filename, 'egress')) return {};
    // Allow-listed infrastructure exceptions: the database driver and the HTTP server framework
    // are inbound/local only and are not imported here by name.
    const report = (node, what) =>
      context.report({ node, message: `${what} is forbidden outside packages/egress (contract §4, INV-3). Use the allowlisted egress client.` });
    return {
      ImportDeclaration(node) {
        if (NETWORK_MODULES.has(node.source.value)) report(node, `Import of '${node.source.value}'`);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal' && NETWORK_MODULES.has(node.source.value)) report(node, `Dynamic import of '${node.source.value}'`);
      },
      CallExpression(node) {
        const c = node.callee;
        if (c.type === 'Identifier' && c.name === 'require' && node.arguments[0]?.type === 'Literal' && NETWORK_MODULES.has(node.arguments[0].value)) {
          report(node, `require('${node.arguments[0].value}')`);
        }
        if (c.type === 'Identifier' && c.name === 'fetch') report(node, 'Global fetch()');
        if (c.type === 'MemberExpression' && c.property.type === 'Identifier' && c.property.name === 'fetch' &&
            c.object.type === 'Identifier' && ['globalThis', 'window', 'self'].includes(c.object.name)) report(node, 'globalThis.fetch()');
      },
    };
  },
};

/** §4: No I/O imports inside packages/domain. */
const DOMAIN_ALLOWED = [/^zod$/, /^@sevari\/domain(\/|$)/, /^\.\.?\//];
const noIoInDomain = {
  meta: { type: 'problem', docs: { description: 'packages/domain is pure (contract §4, §5.3)' }, schema: [] },
  create(context) {
    if (!inPkg(context.filename, 'domain') || isTestFile(context.filename)) return {};
    const check = (node, src) => {
      if (!DOMAIN_ALLOWED.some((r) => r.test(src))) {
        context.report({ node, message: `packages/domain must not import '${src}' (no I/O in the deterministic core, contract §4).` });
      }
    };
    return {
      ImportDeclaration(node) { check(node, node.source.value); },
      ImportExpression(node) { context.report({ node, message: 'Dynamic import is forbidden in packages/domain.' }); },
      MemberExpression(node) {
        if (node.object.type === 'Identifier' && node.object.name === 'process') {
          context.report({ node, message: 'process.* is forbidden in packages/domain (inject configuration instead).' });
        }
      },
      CallExpression(node) {
        if (node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' &&
            node.callee.object.name === 'Math' && node.callee.property.name === 'random') {
          context.report({ node, message: 'Math.random() is non-deterministic; inject an IdSource/Random port.' });
        }
      },
    };
  },
};

/** §4: No Date.now() / new Date() outside an injected Clock. */
const noRawDate = {
  meta: { type: 'problem', docs: { description: 'Time only via the injected Clock (contract §4)' }, schema: [] },
  create(context) {
    const f = norm(context.filename);
    if (f.endsWith('/packages/clock/src/system-clock.ts')) return {};
    return {
      CallExpression(node) {
        const c = node.callee;
        if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.object.name === 'Date' &&
            c.property.type === 'Identifier' && c.property.name === 'now') {
          context.report({ node, message: 'Date.now() is forbidden; use the injected Clock (contract §4).' });
        }
      },
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Date' && node.arguments.length === 0) {
          context.report({ node, message: 'new Date() is forbidden; use the injected Clock (contract §4).' });
        }
      },
    };
  },
};

/** §4: No raw string SQL that touches tenant tables outside packages/db. */
const SQL_RE = /\b(select\s[\s\S]*?\sfrom|insert\s+into|update\s+\w+\s+set|delete\s+from|alter\s+table|create\s+table|truncate)\b/i;
const noRawSqlOutsideDb = {
  meta: { type: 'problem', docs: { description: 'SQL only inside packages/db (contract §4)' }, schema: [] },
  create(context) {
    const f = context.filename;
    if (inPkg(f, 'db') || isTestFile(f) || /\/scripts\//.test(norm(f))) return {};
    const check = (node, text) => {
      if (typeof text === 'string' && SQL_RE.test(text)) {
        context.report({ node, message: 'Raw SQL outside packages/db is forbidden (contract §4). Add a repository function to @sevari/db.' });
      }
    };
    return {
      Literal(node) { check(node, node.value); },
      TemplateLiteral(node) { check(node, node.quasis.map((q) => q.value.cooked).join(' ')); },
    };
  },
};

/** §4: Only packages/grounding may construct a GroundedDraft. */
const noGroundedDraftForgery = {
  meta: { type: 'problem', docs: { description: 'GroundedDraft is constructed only by @sevari/grounding (INV-5)' }, schema: [] },
  create(context) {
    if (inPkg(context.filename, 'grounding')) return {};
    const isGD = (t) => t && t.type === 'TSTypeReference' && t.typeName.type === 'Identifier' && t.typeName.name === 'GroundedDraft';
    const report = (node) => context.report({ node, message: 'Casting to GroundedDraft outside packages/grounding is forbidden (contract §4, INV-5).' });
    return {
      TSAsExpression(node) { if (isGD(node.typeAnnotation)) report(node); },
      TSTypeAssertion(node) { if (isGD(node.typeAnnotation)) report(node); },
      Identifier(node) { if (node.name === '__groundedBrand' || node.name === 'GROUNDED_BRAND') report(node); },
    };
  },
};

/** INV-11: reserved decisions list may only be read, never mutated, and never configured from data. */
const noReservedOverride = {
  meta: { type: 'problem', docs: { description: 'Reserved decisions cannot be unlocked by config (INV-11, T-RES)' }, schema: [] },
  create(context) {
    if (inPkg(context.filename, 'autonomy') && norm(context.filename).endsWith('/src/reserved.ts')) return {};
    return {
      AssignmentExpression(node) {
        const l = node.left;
        if (l.type === 'MemberExpression' && l.object.type === 'Identifier' && /^RESERVED/.test(l.object.name)) {
          context.report({ node, message: 'Reserved decisions are constitutional (contract §8.3, INV-11).' });
        }
      },
    };
  },
};

export default {
  meta: { name: 'eslint-plugin-sevari', version: '0.1.0' },
  rules: {
    'no-network-outside-egress': noNetworkOutsideEgress,
    'no-io-in-domain': noIoInDomain,
    'no-raw-date': noRawDate,
    'no-raw-sql-outside-db': noRawSqlOutsideDb,
    'no-grounded-draft-forgery': noGroundedDraftForgery,
    'no-reserved-override': noReservedOverride,
  },
};
