import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFakeServer } from './fake-server.js';

const BIN = fileURLToPath(new URL('../bin/leadspicker.js', import.meta.url));
let server;
let home;

/** Runs the CLI against the fake server; resolves with {code, stdout, stderr}. */
function cli(args, { stdin, onStderr } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), LEADSPICKER_URL: server.base };
    const child = spawn(process.execPath, [BIN, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      onStderr?.(stderr, child);
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const configFile = () => path.join(home, 'config', 'leadspicker', 'config.json');
const readConfig = () => JSON.parse(fs.readFileSync(configFile(), 'utf8'));
const lastRequest = () => server.state.requests.at(-1);
function writeLogin(overrides = {}) {
  const tokens = server.issue();
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(
    configFile(),
    JSON.stringify({
      url: server.base,
      client_id: 'salesbooster',
      token_endpoint: `${server.base}/token`,
      revocation_endpoint: `${server.base}/revoke`,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + 3600_000,
      ...overrides,
    }),
  );
  return tokens;
}

before(async () => {
  server = await startFakeServer();
});
after(() => server.close());
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'leadspicker-cli-'));
  server.state.refreshCalls = 0;
  server.state.specFetches = 0;
});

describe('discovery (works logged out)', () => {
  test('root help lists groups with their actions, without deprecated ones', async () => {
    const { code, stdout } = await cli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /Not logged in: run leadspicker login/);
    assert.match(stdout, /list\s+list, create, get, delete, people, import, export-data/);
    assert.doesNotMatch(stdout, /project/);
    assert.match(stdout, /Next: leadspicker <group> --help/);
  });

  test('group help lists actions and the examples from the API docs', async () => {
    const { stdout } = await cli(['list']);
    assert.match(stdout, /create\s+Create a List/);
    assert.match(stdout, /leadspicker list create --name 'DACH founders' --timezone Europe\/Prague/);
  });

  test('action help shows flags from path, query and body', async () => {
    const people = await cli(['list', 'people', '--help']);
    assert.match(people.stdout, /Usage: leadspicker list people --project-id <integer> \[options\]/);
    assert.match(people.stdout, /--order-by <created\|-created>/);
    assert.match(people.stdout, /API: GET \/app\/sb\/api\/lists\/\{project_id\}\/people/);
    const create = await cli(['list', 'create', '--help']);
    assert.match(create.stdout, /--name <string> \(required\)/);
    assert.match(create.stdout, /--input <file.json\|->/);
    assert.doesNotMatch(create.stdout, /```/);
  });

  test('the schema is cached between runs', async () => {
    await cli(['--help']);
    await cli(['list', '--help']);
    assert.equal(server.state.specFetches, 1);
  });

  test('unknown names suggest the closest ones', async () => {
    const group = await cli(['lists']);
    assert.equal(group.code, 2);
    assert.match(group.stderr, /Did you mean list/);
    const action = await cli(['list', 'peple']);
    assert.match(action.stderr, /Did you mean people/);
  });
});

describe('login', () => {
  const authUrlOf = (stderr) => stderr.match(/(http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+)/)?.[1];

  test('--no-browser: following the printed URL completes the loopback login', async () => {
    let followed = false;
    const result = await cli(['login', '--no-browser'], {
      onStderr: async (stderr) => {
        const authUrl = authUrlOf(stderr);
        if (!authUrl || followed) return;
        followed = true;
        const consent = await fetch(authUrl, { redirect: 'manual' });
        await fetch(consent.headers.get('location')); // the browser landing on the CLI's loopback port
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(readConfig().access_token, /^at-/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(configFile()).mode & 0o777, 0o600);
  });

  test('--no-browser: a pasted redirect URL works too', async () => {
    let pasted = false;
    const result = await cli(['login', '--no-browser'], {
      onStderr: async (stderr, child) => {
        const authUrl = authUrlOf(stderr);
        if (!authUrl || pasted || !stderr.includes('paste')) return;
        pasted = true;
        const consent = await fetch(authUrl, { redirect: 'manual' });
        child.stdin.end(`${consent.headers.get('location')}\n`);
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(readConfig().access_token, /^at-/);
  });

  test('commands need a login (exit code 3)', async () => {
    const { code, stderr } = await cli(['list', 'get', '--project-id', '1']);
    assert.equal(code, 3);
    assert.match(stderr, /Run: leadspicker login/);
  });

  test('logout revokes and forgets the session', async () => {
    const tokens = writeLogin();
    assert.equal((await cli(['logout'])).code, 0);
    assert.ok(server.state.revoked.includes(tokens.refresh_token));
    assert.equal(fs.existsSync(configFile()), false);
  });
});

describe('calling the API', () => {
  beforeEach(() => writeLogin());

  test('path and query flags', async () => {
    const { code } = await cli(['list', 'people', '--project-id', '7', '--tags', 'a', '--tags=b c', '--include-deleted', '--order-by', '-created']);
    assert.equal(code, 0);
    const req = lastRequest();
    assert.equal(req.path, '/app/sb/api/lists/7/people');
    assert.deepEqual(Object.fromEntries([...new URLSearchParams(req.query)].reduce((m, [k, v]) => m.set(k, [...(m.get(k) ?? []), v]), new Map())), {
      tags: ['a', 'b c'],
      include_deleted: ['true'],
      order_by: ['-created'],
    });
  });

  test('body flags become a JSON body, merged over --input', async () => {
    const { code } = await cli(['list', 'create', '--input', '-', '--name', 'Q3', '--labels', '1', '--labels', '2'], { stdin: '{"timezone": "UTC", "name": "x"}' });
    assert.equal(code, 0);
    assert.equal(lastRequest().contentType, 'application/json');
    assert.deepEqual(JSON.parse(lastRequest().body), { timezone: 'UTC', name: 'Q3', labels: [1, 2] });
  });

  test('a file field is uploaded as multipart', async () => {
    const csv = path.join(home, 'people.csv');
    fs.writeFileSync(csv, 'name\nAda\n');
    const { code } = await cli(['list', 'import', '--project-id', '3', '--file', csv, '--delimiter', ';']);
    assert.equal(code, 0);
    assert.match(lastRequest().contentType, /^multipart\/form-data/);
    assert.match(lastRequest().body, /filename="people.csv"[\s\S]*name\nAda/);
  });

  test('non-JSON responses are written raw, for redirecting to a file', async () => {
    const { stdout } = await cli(['list', 'export-data', '--project-id', '3']);
    assert.equal(stdout, 'name,email\nAda,ada@example.com\n');
  });

  test('usage errors show usage and an example', async () => {
    const missing = await cli(['list', 'create', '--timezone', 'UTC']);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /Missing --name/);
    assert.match(missing.stderr, /Example: leadspicker list create --name 'DACH founders'/);
    assert.match((await cli(['list', 'get', '--project-id', 'abc'])).stderr, /--project-id expects an integer/);
    assert.match((await cli(['list', 'get', '--project', '1'])).stderr, /Unknown flag --project\. Did you mean --project-id/);
    assert.match((await cli(['list', 'people', '--project-id', '1', '--order-by', 'x'])).stderr, /one of created, -created/);
  });

  test('DELETE needs --yes when not interactive', async () => {
    const refused = await cli(['list', 'delete', '--project-id', '1']);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /Re-run with --yes/);
    const confirmed = await cli(['list', 'delete', '--project-id', '1', '--yes']);
    assert.equal(confirmed.code, 0);
    assert.equal(lastRequest().method, 'DELETE');
  });

  test('API errors go to stderr with exit code 1', async () => {
    const { code, stdout, stderr } = await cli(['list', 'get', '--project-id', '404']);
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /HTTP 404[\s\S]*List not found/);
    assert.doesNotMatch(stderr, /at printResponse/); // a clean message, not a crash
  });

  test('whoami and raw api', async () => {
    assert.equal(JSON.parse((await cli(['whoami'])).stdout).email, 'test@example.com');
    const raw = await cli(['api', 'post', '/lists', '--input', '-'], { stdin: '{"name": "raw"}' });
    assert.equal(raw.code, 0);
    assert.deepEqual(JSON.parse(lastRequest().body), { name: 'raw' });
  });
});

describe('token refresh', () => {
  test('parallel processes share one refresh of a rotating token', async () => {
    writeLogin({ expires_at: Date.now() - 1000 });
    const results = await Promise.all(Array.from({ length: 8 }, () => cli(['whoami'])));
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    assert.equal(server.state.refreshCalls, 1);
  });

  test('a token the server rejects is refreshed and the call retried', async () => {
    const tokens = writeLogin();
    server.state.access.delete(tokens.access_token);
    assert.equal((await cli(['whoami'])).code, 0);
    assert.equal(server.state.refreshCalls, 1);
    assert.notEqual(readConfig().access_token, tokens.access_token);
  });

  test('a dead refresh token means logging in again', async () => {
    writeLogin({ expires_at: Date.now() - 1000, refresh_token: 'rt-dead' });
    const { code, stderr } = await cli(['whoami']);
    assert.equal(code, 3);
    assert.match(stderr, /Session expired\. Run: leadspicker login/);
  });
});
