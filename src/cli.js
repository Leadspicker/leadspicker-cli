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
    const { config, email } = await login({ url: /** @type {string | undefined} */ (opts.url), noBrowser: Boolean(opts['no-browser']) });
    return void process.stderr.write(`Logged in to ${config.url}${email ? ` as ${email}` : ''}. Next: ${PROG} --help\n`);
  }
  if (first === 'logout') return void process.stderr.write((await logout()) ? 'Logged out.\n' : 'Not logged in.\n');
  if (first === 'whoami') return printResponse(await send('GET', '/auth/me'));
  if (first === 'api') return api(rest);

  // `help` as the first word, then up to two command words; everything after them is flags.
  const args = first === 'help' ? rest : argv;
  let n = 0;
  while (n < 2 && n < args.length && !args[n].startsWith('-')) n++;
  const [groupName, actionName] = args.slice(0, n);
  const flags = args.slice(n);
  const helpFlag = flags.includes('--help') || flags.includes('-h');

  let { spec, fromCache } = await loadSpec(baseUrl());
  let tree = buildTree(spec);
  // A cached schema may predate a new endpoint: look again in a fresh one before giving up.
  if (fromCache && groupName && !findCommand(tree, groupName, actionName ?? '') && !(tree.has(groupName) && !actionName)) {
    tree = buildTree((await loadSpec(baseUrl(), { fresh: true })).spec);
  }

  if (!groupName) {
    if (flags.length && !helpFlag) throw new CliError(`Unknown option ${flags[0]}.\nRun ${PROG} --help for the commands.`, EXIT.USAGE);
    const config = readConfig();
    return print(rootHelp(tree, config ? `Logged in to ${config.url}.` : `Not logged in: run ${PROG} login.`));
  }
  const actions = tree.get(groupName);
  if (!actions) throw new CliError(`Unknown command "${groupName}".${suggest(groupName, [...tree.keys()])}\nRun ${PROG} --help for the list.`, EXIT.USAGE);
  const cmd = findCommand(tree, groupName, actionName ?? '');
  if (!cmd) {
    if (!actionName) return print(groupHelp(groupName, actions));
    throw new CliError(`Unknown action "${actionName}" in ${groupName}.${suggest(actionName, [...actions.keys()])}\nRun ${PROG} ${groupName} --help for its actions.`, EXIT.USAGE);
  }
  if (first === 'help') return print(actionHelp(cmd, tree));

  const { values, input, yes, help } = parseFlags(cmd, flags);
  if (help) return print(actionHelp(cmd, tree));
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

const MAX_ERROR_BODY = 1000;

/** JSON is printed as JSON, text as text, anything else (exports) as raw bytes. @param {Response} res */
async function printResponse(res) {
  const type = res.headers.get('content-type') ?? '';
  const bytes = Buffer.from(await res.arrayBuffer());
  let out = bytes;
  let isJson = false;
  if (type.includes('json') && bytes.length) {
    try {
      const json = JSON.parse(bytes.toString('utf8'));
      out = Buffer.from(`${process.stdout.isTTY ? JSON.stringify(json, null, 2) : JSON.stringify(json)}\n`);
      isJson = true;
    } catch {} // labelled JSON but isn't: shown as it came
  }
  if (!res.ok) {
    // Error pages (a proxy's HTML 502) can be long: keep the start.
    let text = out.toString('utf8').trim();
    if (!isJson && text.length > MAX_ERROR_BODY) text = `${text.slice(0, MAX_ERROR_BODY)}… (${text.length - MAX_ERROR_BODY} more characters)`;
    throw new CliError(`HTTP ${res.status} ${res.statusText}\n${text}`);
  }
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

/** `leadspicker api <METHOD> <path> [--input body.json|-] [--yes]`: any API path, raw. @param {string[]} argv */
async function api(argv) {
  const usage = `Usage: ${PROG} api <METHOD> <path> [--input body.json|-] [--yes]\nExample: ${PROG} api GET /lists`;
  const [method, apiPath, ...flags] = argv;
  if (!method || method === '--help' || method === '-h') return print(usage);
  if (!apiPath || apiPath.startsWith('-')) {
    if (apiPath === '--help' || apiPath === '-h') return print(usage);
    throw new CliError(usage, EXIT.USAGE);
  }
  const opts = parseOwnFlags(flags, { input: 'string', yes: 'boolean', help: 'boolean' }, { y: 'yes', h: 'help' });
  if (opts.help) return print(usage);
  const verb = method.toUpperCase();
  if (verb === 'DELETE' && !opts.yes) await confirm(`DELETE ${apiPath}`);
  const body = opts.input === undefined ? undefined : JSON.stringify(readJsonInput(String(opts.input)));
  await printResponse(await send(verb, apiPath, body));
}

/**
 * Flags of the built-in commands. @param {string[]} argv @param {Record<string, 'string' | 'boolean'>} spec
 * @param {Record<string, string>} [short] one-letter aliases, e.g. {y: 'yes'}
 * @returns {Record<string, string | boolean | undefined>}
 */
function parseOwnFlags(argv, spec, short = {}) {
  /** @type {Record<string, string | boolean | undefined>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const alias = /^-([a-z])$/.exec(argv[i])?.[1];
    const [name, inline] = alias ? [short[alias] ?? argv[i], undefined] : argv[i].replace(/^--/, '').split(/=(.*)/s);
    if (!(alias || argv[i].startsWith('--')) || !spec[name]) throw new CliError(`Unknown option ${argv[i]}. Options: ${Object.keys(spec).map((k) => `--${k}`).join(' ')}`, EXIT.USAGE);
    if (spec[name] === 'boolean') out[name] = true;
    else {
      out[name] = inline ?? argv[++i];
      if (out[name] === undefined) throw new CliError(`--${name} needs a value.`, EXIT.USAGE);
    }
  }
  return out;
}
