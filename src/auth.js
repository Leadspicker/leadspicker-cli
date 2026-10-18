// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError, EXIT, notLoggedIn, postForm, request } from './http.js';
import { errorPage, successPage } from './page.js';

export const DEFAULT_URL = 'https://app.leadspicker.com';
// The server's built-in public OAuth client, which accepts any loopback redirect port.
// A dedicated "Leadspicker CLI" client is a server-side follow-up (t12701).
const CLIENT_ID = 'salesbooster';
const SCOPE = 'mcp offline_access';
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const EXPIRY_MARGIN_MS = 60_000;
const LOCK_STALE_MS = 30_000;

/**
 * @typedef {{url: string, client_id: string, token_endpoint: string,
 *   revocation_endpoint?: string, access_token: string, refresh_token?: string, expires_at: number}} Config
 */

const trimSlash = (/** @type {string} */ url) => url.replace(/\/+$/, '');

/** The server commands talk to: the logged-in one, else LEADSPICKER_URL, else production. */
export const baseUrl = () => trimSlash(readConfig()?.url || process.env.LEADSPICKER_URL || DEFAULT_URL);

export const configDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'leadspicker');
const configPath = () => path.join(configDir(), 'config.json');

/** @returns {Config | null} */
export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return null;
  }
}

/** @param {Config} config */
function writeConfig(config) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  // Write-then-rename, so a parallel reader never sees half a file.
  const tmp = `${configPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, configPath());
}

const b64url = (/** @type {Buffer} */ buf) => buf.toString('base64url');

/** @param {string} url */
async function getJson(url) {
  const res = await request(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new CliError(`GET ${url} failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Authorization code + PKCE with a loopback redirect. With noBrowser, the redirect URL can also be
 * pasted back from another machine's browser (SSH): whichever arrives first wins.
 * @param {{url?: string, noBrowser?: boolean}} opts
 */
export async function login({ url, noBrowser = false }) {
  const base = trimSlash(url || process.env.LEADSPICKER_URL || DEFAULT_URL);
  const meta = await getJson(`${base}/.well-known/oauth-authorization-server`);
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(16));

  const callback = await listenForCallback(state);
  const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
  const authUrl = `${meta.authorization_endpoint}?${new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  })}`;

  // Aborted once a code arrives, so the losing sources (prompt, timer) don't keep the process alive.
  const done = new AbortController();
  const timeout = sleep(LOGIN_TIMEOUT_MS, undefined, { signal: done.signal }).then(() => {
    throw new CliError('Login timed out.', EXIT.AUTH);
  });
  /** @type {Promise<string>[]} */
  const sources = [callback.code, timeout];
  if (noBrowser) {
    process.stderr.write(`Open this URL in a browser and approve access:\n\n  ${authUrl}\n\n`);
    sources.push(readPastedRedirect(state, done.signal));
  } else {
    process.stderr.write(`Opening the browser to log in. If it doesn't open, visit:\n\n  ${authUrl}\n\n`);
    openBrowser(authUrl);
  }
  try {
    const code = await Promise.race(sources);
    done.abort();
    const token = await postForm(meta.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: CLIENT_ID,
    });
    if (!token.ok) throw new CliError(`Login failed: ${token.body.error_description || token.body.error || `HTTP ${token.status}`}`, EXIT.AUTH);

    /** @type {Config} */
    const config = {
      url: base,
      client_id: CLIENT_ID,
      token_endpoint: meta.token_endpoint,
      revocation_endpoint: meta.revocation_endpoint,
      ...tokenFields(token.body),
    };
    writeConfig(config);
    const email = await currentEmail(config);
    callback.finish(200, successPage(base, email));
    return { config, email };
  } catch (err) {
    callback.finish(400, errorPage(base, /** @type {Error} */ (err).message));
    throw err;
  } finally {
    done.abort();
    callback.close();
  }
}

/** The logged-in user's e-mail, for the confirmation; null when it can't be read. @param {Config} config */
async function currentEmail(config) {
  try {
    const res = await request(`${config.url}/app/sb/api/auth/me`, { headers: { authorization: `Bearer ${config.access_token}`, accept: 'application/json' } });
    return res.ok ? ((await res.json()).email ?? null) : null;
  } catch {
    return null;
  }
}

/** @param {any} body */
const tokenFields = (body) => ({
  access_token: body.access_token,
  refresh_token: body.refresh_token,
  expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000,
});

/**
 * Waits for the browser's redirect. Its response is held until `finish`, so the page shows how the
 * login really ended (the token exchange happens after the redirect).
 * @param {string} state
 */
function listenForCallback(state) {
  /** @type {(code: string) => void} */ let resolve;
  /** @type {(err: Error) => void} */ let reject;
  const code = new Promise((res, rej) => { resolve = res; reject = rej; });
  code.catch(() => {}); // a pasted URL may win the race; this promise is then never awaited
  /** @type {import('node:http').ServerResponse | null} */
  let pending = null;
  /** @param {import('node:http').ServerResponse} res @param {number} status @param {string} html */
  const send = (res, status, html) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(html);

  const server = http.createServer((req, res) => {
    const params = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
    if (pending || (!params.has('code') && !params.has('error'))) return res.writeHead(404).end();
    try {
      resolve(codeFromParams(params, state));
      pending = res;
    } catch (err) {
      reject(/** @type {Error} */ (err));
      pending = res;
    }
  });
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      res({
        port: address.port,
        code,
        /** @param {number} status @param {string} html */
        finish: (status, html) => {
          if (pending && !pending.headersSent) send(pending, status, html);
        },
        close: () => server.close(),
      });
    });
  });
}

/** @param {URLSearchParams} params @param {string} state */
function codeFromParams(params, state) {
  if (params.get('error')) throw new CliError(`Login refused: ${params.get('error_description') || params.get('error')}`, EXIT.AUTH);
  if (params.get('state') !== state) throw new CliError('Login failed: state mismatch.', EXIT.AUTH);
  const code = params.get('code');
  if (!code) throw new CliError('Login failed: no code in the redirect.', EXIT.AUTH);
  return code;
}

/** @param {string} state @param {AbortSignal} signal */
async function readPastedRedirect(state, signal) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question('Then paste the URL the browser was redirected to (it may show an error page):\n> ', { signal });
    return codeFromParams(new URL(answer.trim()).searchParams, state);
  } finally {
    rl.close();
  }
}

/** @param {string} url */
function openBrowser(url) {
  const [cmd, args] =
    // Not `cmd /c start`: cmd would cut the URL at its first `&`.
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

/**
 * The current login with a usable access token. Refresh tokens rotate on use, so parallel
 * processes refresh under a lock and re-read the config: whoever comes second uses the
 * token the first one stored instead of spending the already-rotated refresh token.
 * @param {string} [rejectedToken] an access token the server just refused (forces a refresh)
 * @returns {Promise<Config>}
 */
export async function getSession(rejectedToken) {
  const config = readConfig();
  if (!config?.access_token) throw notLoggedIn();
  if (!rejectedToken && config.expires_at - EXPIRY_MARGIN_MS > Date.now()) return config;

  return withLock(async () => {
    const current = readConfig();
    if (!current?.access_token) throw notLoggedIn();
    const usedToken = rejectedToken ?? config.access_token;
    if (current.access_token !== usedToken && current.expires_at - EXPIRY_MARGIN_MS > Date.now()) return current;
    if (!current.refresh_token) throw notLoggedIn('Session expired.');

    const token = await postForm(current.token_endpoint, {
      grant_type: 'refresh_token',
      refresh_token: current.refresh_token,
      client_id: current.client_id,
    });
    if (!token.ok) throw notLoggedIn('Session expired.');
    const next = { ...current, ...tokenFields(token.body) };
    writeConfig(next);
    return next;
  });
}

/** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
async function withLock(fn) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const lockPath = path.join(configDir(), 'refresh.lock');
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx'));
      break;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
      const age = Date.now() - (fs.statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > LOCK_STALE_MS || Date.now() > deadline) fs.rmSync(lockPath, { force: true });
      else await sleep(50 + Math.random() * 100);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

export async function logout() {
  const config = readConfig();
  if (!config) return false;
  if (config.revocation_endpoint) {
    for (const token of [config.refresh_token, config.access_token]) {
      if (token) await postForm(config.revocation_endpoint, { token, client_id: config.client_id }).catch(() => {});
    }
  }
  fs.rmSync(configPath(), { force: true });
  return true;
}
