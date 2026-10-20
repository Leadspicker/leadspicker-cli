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
    assert.match(stdout, /list\s+list, create, get, delete, export-data, import, people/);
    assert.doesNotMatch(stdout, /project/);
    assert.match(stdout, /\n  logout\s+log out/);
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

  /** Plays the browser: approve, then land on the CLI's loopback port. Resolves with the page shown. */
  function browserLogin() {
    let page;
    return new Promise((resolve) => {
      cli(['login', '--no-browser'], {
        onStderr: async (stderr) => {
          const authUrl = authUrlOf(stderr);
          if (!authUrl || page) return;
          page = fetch(authUrl, { redirect: 'manual' }).then((consent) => fetch(consent.headers.get('location')));
        },
      }).then(async (result) => {
        const res = await page;
        resolve({ ...result, status: res.status, html: await res.text() });
      });
    });
  }

  test('--no-browser: following the printed URL completes the loopback login', async () => {
    const result = await browserLogin();
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Logged in to http:\/\/127\.0\.0\.1:\d+ as test@example\.com/);
    assert.equal(result.status, 200);
    assert.match(result.html, /You&#39;re logged in/);
    assert.match(result.html, /<strong>test@example\.com<\/strong>/);
    assert.match(readConfig().access_token, /^at-/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(configFile()).mode & 0o777, 0o600);
  });

  test('a stray request on the loopback port does not abort the login', async () => {
    let done = false;
    const result = await cli(['login', '--no-browser'], {
      onStderr: async (stderr) => {
        const authUrl = authUrlOf(stderr);
        if (!authUrl || done) return;
        done = true;
        const redirect = new URL(new URL(authUrl).searchParams.get('redirect_uri'));
        const stray = await fetch(`${redirect}?error=access_denied&state=wrong`);
        assert.equal(stray.status, 400);
        const consent = await fetch(authUrl, { redirect: 'manual' });
        await fetch(consent.headers.get('location'));
      },
    });
    assert.equal(result.code, 0, result.stderr);
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

  test('a refused consent shows the error page and exits with code 3', async () => {
    server.state.denyConsent = true;
    try {
      const result = await browserLogin();
      assert.equal(result.code, 3);
      assert.match(result.stderr, /Login refused: The user denied access\./);
      assert.equal(result.status, 400);
      assert.match(result.html, /Login didn&#39;t complete/);
      assert.match(result.html, /leadspicker login/);
    } finally {
      server.state.denyConsent = false;
    }
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

  test('help words are only help where a flag can stand', async () => {
    for (const value of ['help', '-h', '--help']) {
      const { code, stdout } = await cli(['list', 'create', '--timezone', 'UTC', '--name', value]);
      assert.equal(code, 0, value);
      assert.equal(JSON.parse(lastRequest().body).name, value);
      assert.doesNotMatch(stdout, /Usage:/);
    }
    assert.match((await cli(['list', 'create', '--name', 'x', '--help'])).stdout, /Usage: leadspicker list create/);
    assert.match((await cli(['list', 'create', '--nmae', 'x', '--help'])).stdout, /Usage: leadspicker list create/);
    assert.match((await cli(['help', 'list', 'create'])).stdout, /Usage: leadspicker list create/);
    assert.match((await cli(['list', 'people', '--project-id', '1', '--include-deleted', '-h'])).stdout, /Usage: leadspicker list people/);
  });

  test('DELETE needs --yes when not interactive', async () => {
    const refused = await cli(['list', 'delete', '--project-id', '1']);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /Re-run with --yes/);
    const confirmed = await cli(['list', 'delete', '--project-id', '1', '--yes']);
    assert.equal(confirmed.code, 0);
    assert.equal(lastRequest().method, 'DELETE');
  });

  test('raw api DELETE needs --yes too', async () => {
    const before = server.state.requests.length;
    const refused = await cli(['api', 'DELETE', '/lists/5']);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /Re-run with --yes/);
    assert.equal(server.state.requests.length, before);
    assert.equal((await cli(['api', 'delete', '/lists/5', '-y'])).code, 0);
    assert.equal(lastRequest().method, 'DELETE');
  });

  test('a body labelled JSON that is not is printed, not a crash', async () => {
    const { code, stdout, stderr } = await cli(['api', 'GET', '/broken-json']);
    assert.equal(code, 0, stderr);
    assert.equal(stdout, '<html>not json</html>');
  });

  test('long non-JSON error pages are cut short', async () => {
    const { code, stderr } = await cli(['api', 'GET', '/bad-gateway']);
    assert.equal(code, 1);
    assert.match(stderr, /HTTP 502[\s\S]*more characters\)/);
    assert.ok(stderr.length < 1300);
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

  test('a refresh that fails for another reason is an error, not a logout', async () => {
    writeLogin({ expires_at: Date.now() - 1000 });
    server.state.refreshStatus = 503;
    try {
      const { code, stderr } = await cli(['whoami']);
      assert.equal(code, 1);
      assert.match(stderr, /Could not refresh the login: HTTP 503/);
      assert.ok(fs.existsSync(configFile()));
    } finally {
      server.state.refreshStatus = 0;
    }
  });

  test('a dead refresh token means logging in again', async () => {
    writeLogin({ expires_at: Date.now() - 1000, refresh_token: 'rt-dead' });
    const { code, stderr } = await cli(['whoami']);
    assert.equal(code, 3);
    assert.match(stderr, /Session expired\. Run: leadspicker login/);
  });
});
