// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { baseUrl, getSession, login, logout, readConfig } from './auth.js';
import { actionHelp, buildRequest, buildTree, fileFields, findCommand, groupHelp, parseFlags, PROG, rootHelp, suggest } from './commands.js';
import { CliError, EXIT, VERSION, notLoggedIn, request } from './http.js';
import { API_PREFIX, loadSpec } from './spec.js';

/** @param {string[]} argv @returns {Promise<number>} */
export async function main(argv) {
  try {
    await run(argv);
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    process.stderr.write(`${/** @type {Error} */ (err)?.stack ?? err}\n`);
    return EXIT.ERROR;
  }
}

/** @param {string[]} argv */
async function run(argv) {
  const [first, ...rest] = argv;
  if (first === '--version' || first === '-v') return print(VERSION);
  if (first === 'login') {
    if (rest.includes('--help')) return print(`Usage: ${PROG} login [--url URL] [--no-browser]`);
    const opts = parseOwnFlags(rest, { url: 'string', 'no-browser': 'boolean' });
    const config = await login({ url: /** @type {string | undefined} */ (opts.url), noBrowser: Boolean(opts['no-browser']) });
    return void process.stderr.write(`Logged in to ${config.url}. Next: ${PROG} --help\n`);
  }
  if (first === 'logout') return void process.stderr.write((await logout()) ? 'Logged out.\n' : 'Not logged in.\n');
  if (first === 'whoami') return printResponse(await send('GET', '/auth/me'));
  if (first === 'api') return api(rest);

  const wantsHelp = argv.includes('--help') || argv.includes('-h') || first === 'help';
  const words = argv.filter((a) => a !== '--help' && a !== '-h' && a !== 'help');
  const [groupName, actionName, ...flags] = words;

  let { spec, fromCache } = await loadSpec(baseUrl());
  let tree = buildTree(spec);
  // A cached schema may predate a new endpoint: look again in a fresh one before giving up.
  if (fromCache && groupName && !findCommand(tree, groupName, actionName ?? '') && !(tree.has(groupName) && !actionName)) {
    tree = buildTree((await loadSpec(baseUrl(), { fresh: true })).spec);
  }

  if (!groupName) {
    const config = readConfig();
    return print(rootHelp(tree, config ? `Logged in to ${config.url}.` : `Not logged in: run ${PROG} login.`));
  }
  const actions = tree.get(groupName);
  if (!actions) throw new CliError(`Unknown command "${groupName}".${suggest(groupName, [...tree.keys()])}\nRun ${PROG} --help for the list.`, EXIT.USAGE);
  const cmd = findCommand(tree, groupName, actionName ?? '');
  if (!cmd) {
    if (wantsHelp || !actionName) return print(groupHelp(groupName, actions));
    throw new CliError(`Unknown action "${actionName}" in ${groupName}.${suggest(actionName, [...actions.keys()])}\nRun ${PROG} ${groupName} --help for its actions.`, EXIT.USAGE);
  }
  if (wantsHelp) return print(actionHelp(cmd, tree));

  const { input, yes, remaining } = takeCommonFlags(flags);
  const values = parseFlags(cmd, remaining);
  const req = buildRequest(cmd, values, input === undefined ? undefined : readJsonInput(input));
  if (cmd.method === 'DELETE' && !yes) await confirm(`${groupName} ${actionName}`);

  let body;
  if (cmd.body?.mediaType === 'multipart/form-data') body = formData(/** @type {Record<string, unknown>} */ (req.body ?? {}), fileFields(cmd));
  else if (cmd.body?.mediaType === 'application/x-www-form-urlencoded') body = new URLSearchParams(/** @type {any} */ (req.body ?? {}));
  else if (req.body !== undefined) body = JSON.stringify(req.body);
  await printResponse(await send(cmd.method, req.path, body));
}

/**
 * An authenticated request; a 401 refreshes the login once and retries.
 * @param {string} method @param {string} apiPath a path under the API prefix, or a full /app/… path
 * @param {BodyInit} [body]
 */
async function send(method, apiPath, body) {
  let session = await getSession();
  const url = `${session.url}${apiPath.startsWith('/app/') ? apiPath : `${API_PREFIX}${apiPath.startsWith('/') ? '' : '/'}${apiPath}`}`;
  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json' };
  if (typeof body === 'string') headers['content-type'] = 'application/json';
  const attempt = () => request(url, { method, headers: { ...headers, authorization: `Bearer ${session.access_token}` }, body });
  let res = await attempt();
  if (res.status === 401) {
    session = await getSession(session.access_token);
    res = await attempt();
    if (res.status === 401) throw notLoggedIn('The server refused the login.');
  }
  return res;
}

/** JSON is printed as JSON, text as text, anything else (exports) as raw bytes. @param {Response} res */
async function printResponse(res) {
  const type = res.headers.get('content-type') ?? '';
  const bytes = Buffer.from(await res.arrayBuffer());
  let out = bytes;
  if (type.includes('json') && bytes.length) {
    const json = JSON.parse(bytes.toString('utf8'));
    out = Buffer.from(`${process.stdout.isTTY ? JSON.stringify(json, null, 2) : JSON.stringify(json)}\n`);
  }
  if (!res.ok) throw new CliError(`HTTP ${res.status} ${res.statusText}\n${out.toString('utf8').trim()}`);
  if (out.length) process.stdout.write(out);
}

/** @param {Record<string, unknown>} fields @param {Set<string>} files */
function formData(fields, files) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (files.has(name)) {
        const file = String(v);
        if (!fs.existsSync(file)) throw new CliError(`--${name.replaceAll('_', '-')}: no such file ${file}`, EXIT.USAGE);
        form.append(name, new Blob([fs.readFileSync(file)]), path.basename(file));
      } else {
        form.append(name, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
    }
  }
  return form;
}

/** Pulls --input / --yes out of the command's flags. @param {string[]} flags */
function takeCommonFlags(flags) {
  /** @type {string | undefined} */ let input;
  let yes = false;
  /** @type {string[]} */ const remaining = [];
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--yes' || flags[i] === '-y') yes = true;
    else if (flags[i] === '--input') input = flags[++i];
    else if (flags[i].startsWith('--input=')) input = flags[i].slice(8);
    else remaining.push(flags[i]);
  }
  return { input, yes, remaining };
}

/** @param {string} source a path or "-" for stdin */
function readJsonInput(source) {
  try {
    return JSON.parse(fs.readFileSync(source === '-' ? 0 : source, 'utf8'));
  } catch (err) {
    throw new CliError(`--input: ${/** @type {Error} */ (err).message}`, EXIT.USAGE);
  }
}

/** @param {string} what */
async function confirm(what) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new CliError(`${what} deletes data. Re-run with --yes to confirm.`, EXIT.USAGE);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${what} deletes data. Continue? [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new CliError('Cancelled.');
}

const print = (/** @type {string} */ text) => void process.stdout.write(`${text}\n`);

/** `leadspicker api <METHOD> <path> [--input body.json|-]`: any API path, raw. @param {string[]} argv */
async function api(argv) {
  const usage = `Usage: ${PROG} api <METHOD> <path> [--input body.json|-]\nExample: ${PROG} api GET /lists`;
  const [method, apiPath, ...flags] = argv;
  if (!method || method === '--help' || method === '-h') return print(usage);
  if (!apiPath) throw new CliError(usage, EXIT.USAGE);
  const { input, remaining } = takeCommonFlags(flags);
  if (remaining.length) throw new CliError(`Unexpected ${remaining.join(' ')}\n${usage}`, EXIT.USAGE);
  await printResponse(await send(method.toUpperCase(), apiPath, input === undefined ? undefined : JSON.stringify(readJsonInput(input))));
}

/**
 * Flags of the built-in commands. @param {string[]} argv @param {Record<string, 'string' | 'boolean'>} spec
 * @returns {Record<string, string | boolean | undefined>}
 */
function parseOwnFlags(argv, spec) {
  /** @type {Record<string, string | boolean | undefined>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].replace(/^--/, '').split(/=(.*)/s);
    if (!argv[i].startsWith('--') || !spec[name]) throw new CliError(`Unknown option ${argv[i]}. Options: ${Object.keys(spec).map((k) => `--${k}`).join(' ')}`, EXIT.USAGE);
    out[name] = spec[name] === 'boolean' ? true : inline ?? argv[++i];
  }
  return out;
}
