// @ts-check
import { CliError, EXIT } from './http.js';
import { API_PREFIX } from './spec.js';

export const PROG = 'leadspicker';

/**
 * One API operation as a command. Flags come from its path, query and body parameters.
 * @typedef {{name: string, in: 'path' | 'query' | 'body', schema: any, required: boolean, description: string}} Param
 * @typedef {{group: string, action: string, method: string, path: string, op: any, params: Param[],
 *   body: {mediaType: string, schema: any, required: boolean} | null, examples: {title?: string, args: Record<string, unknown>}[]}} Command
 * @typedef {Map<string, Map<string, Command>>} Tree
 */

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const isParam = (/** @type {string} */ segment) => segment.startsWith('{');
const kebab = (/** @type {string} */ s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Groups are the OpenAPI tags; actions come from the path and method:
 * `GET /lists` → `list list`, `GET /lists/{id}` → `list get`, `POST /lists/{id}/magic-columns/{cid}/rerun`
 * → `list magic-columns-rerun`. `x-cli-group` / `x-cli-action` on an operation override both.
 * Deprecated operations are left out.
 * @param {any} spec @returns {Tree}
 */
export function buildTree(spec) {
  const ref = makeResolver(spec);
  const ops = Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m] && !item[m].deprecated).map((method) => ({ path, method, op: item[method], item })),
  );
  // Each tag's resource root (`lists` for List) is dropped from its actions.
  /** @type {Map<string, Map<string, number>>} */
  const roots = new Map();
  for (const { path, op } of ops) {
    const tag = op.tags?.[0] ?? 'other';
    const first = segmentsOf(path)[0] ?? '';
    const counts = roots.get(tag) ?? new Map();
    counts.set(first, (counts.get(first) ?? 0) + 1);
    roots.set(tag, counts);
  }
  const rootOf = (/** @type {string} */ tag) => [...(roots.get(tag) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0];

  /** @type {Tree} */
  const tree = new Map();
  for (const { path, method, op, item } of ops) {
    const tag = op.tags?.[0] ?? 'other';
    const group = op['x-cli-group'] ?? kebab(tag);
    let action = op['x-cli-action'] ?? deriveAction(method, path, Boolean(item.get), rootOf(tag));
    const actions = tree.get(group) ?? new Map();
    if (actions.has(action)) action = `${action}-${method}`;
    if (actions.has(action)) action = kebab(op.operationId ?? `${method} ${path}`);
    const params = paramsOf(op, item, ref);
    actions.set(action, { group, action, method: method.toUpperCase(), path, op, ...params, examples: examplesOf(op, params.params) });
    tree.set(group, actions);
  }
  return new Map([...tree].sort(([a], [b]) => a.localeCompare(b)));
}

const segmentsOf = (/** @type {string} */ path) => path.replace(API_PREFIX, '').split('/').filter(Boolean);

/** @param {string} method @param {string} path @param {boolean} hasGet @param {string | undefined} root */
export function deriveAction(method, path, hasGet, root) {
  const segments = segmentsOf(path);
  const rest = segments[0] === root ? segments.slice(1) : segments;
  const words = rest.filter((s) => !isParam(s));
  const endsWithId = isParam(segments.at(-1) ?? '');
  const verb =
    method === 'get' ? (endsWithId ? 'get' : words.length ? '' : 'list')
    : method === 'delete' ? 'delete'
    : method === 'post' ? (endsWithId || hasGet ? 'create' : words.length ? '' : 'create')
    : 'update';
  return [...words, verb].filter(Boolean).join('-');
}

/** Follows `$ref`s into components. @param {any} spec */
function makeResolver(spec) {
  /** @param {any} schema @returns {any} */
  const resolve = (schema) => {
    if (!schema?.$ref) return schema ?? {};
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((/** @type {any} */ node, /** @type {string} */ key) => node?.[key], spec);
    return resolve(target);
  };
  return resolve;
}

/** @param {any} op @param {any} item @param {(s: any) => any} ref */
function paramsOf(op, item, ref) {
  /** @type {Param[]} */
  const params = [...(item.parameters ?? []), ...(op.parameters ?? [])]
    .map(ref)
    .filter((p) => p.in === 'path' || p.in === 'query')
    .map((p) => ({ name: p.name, in: p.in, schema: deref(p.schema, ref), required: Boolean(p.required), description: p.description ?? p.schema?.description ?? '' }));

  const content = ref(op.requestBody)?.content ?? {};
  const mediaType = ['application/json', 'multipart/form-data', 'application/x-www-form-urlencoded'].find((t) => content[t]) ?? null;
  if (!mediaType) return { params, body: null };
  const schema = deref(content[mediaType].schema, ref);
  const required = new Set(schema.required ?? []);
  const taken = new Set(params.map((p) => p.name));
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const s = deref(prop, ref);
    params.push({ name: taken.has(name) ? `body_${name}` : name, in: 'body', schema: s, required: required.has(name), description: s.description ?? '' });
  }
  return { params, body: { mediaType, schema, required: Boolean(ref(op.requestBody)?.required) } };
}

/** Resolves refs at the top level and inside anyOf/items, which is all the flag logic looks at. @param {any} schema @param {(s: any) => any} ref */
function deref(schema, ref) {
  const s = { ...ref(schema) };
  if (s.anyOf) s.anyOf = s.anyOf.map((/** @type {any} */ x) => deref(x, ref));
  if (s.allOf?.length === 1) Object.assign(s, deref(s.allOf[0], ref));
  if (s.items) s.items = ref(s.items);
  return s;
}

/**
 * `x-cli-examples` if the server provides them; else the ```json payloads the API docs already
 * show in operation descriptions, turned into flags.
 * @param {any} op @param {Param[]} params
 */
function examplesOf(op, params) {
  if (Array.isArray(op['x-cli-examples'])) return op['x-cli-examples'];
  const bodyNames = new Set(params.filter((p) => p.in === 'body').map((p) => p.name));
  return [...(op.description ?? '').matchAll(/```json\s*\n([\s\S]*?)```/g)].flatMap(([, block]) => {
    try {
      const args = JSON.parse(block);
      return args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).every((k) => bodyNames.has(k)) ? [{ args }] : [];
    } catch {
      return [];
    }
  });
}

/** @param {Tree} tree @param {string} group @param {string} action */
export const findCommand = (tree, group, action) => tree.get(group)?.get(action) ?? null;

// ---------- flags ----------

const flagOf = (/** @type {string} */ name) => `--${name.replaceAll('_', '-')}`;

/** The schema's own type, ignoring the `null` that marks a field optional. @param {any} schema */
function baseType(schema = {}) {
  if (schema.anyOf) return baseType(schema.anyOf.find((/** @type {any} */ s) => s.type !== 'null') ?? {});
  if (Array.isArray(schema.type)) return { ...schema, type: schema.type.find((/** @type {string} */ t) => t !== 'null') };
  return schema;
}

const isFile = (/** @type {any} */ schema) => baseType(schema).format === 'binary';

/** @param {any} schema */
function typeLabel(schema) {
  const s = baseType(schema);
  if (isFile(s)) return 'file';
  if (s.enum) return s.enum.join('|');
  if (s.type === 'array') return `${baseType(s.items).type ?? 'value'}…`;
  return s.type ?? 'json';
}

/** @param {string} raw @param {any} schema @param {string} flag */
function convert(raw, schema, flag) {
  const s = baseType(schema);
  const fail = (/** @type {string} */ what) => {
    throw new CliError(`${flag} expects ${what}, got "${raw}"`, EXIT.USAGE);
  };
  let value;
  if (s.type === 'integer' || s.type === 'number') {
    value = Number(raw);
    if (raw.trim() === '' || Number.isNaN(value) || (s.type === 'integer' && !Number.isInteger(value))) fail(`an ${s.type}`);
  } else if (s.type === 'boolean') {
    if (raw !== 'true' && raw !== 'false') fail('true or false');
    value = raw === 'true';
  } else if (s.type === 'string' || isFile(s)) {
    value = raw;
  } else {
    // objects, arrays given whole, and untyped values: JSON, or the plain string
    try {
      value = JSON.parse(raw);
    } catch {
      if (s.type === 'object' || s.type === 'array') fail('JSON');
      value = raw;
    }
  }
  if (s.enum && !s.enum.includes(value)) fail(`one of ${s.enum.join(', ')}`);
  return value;
}

/**
 * `--flag value` pairs → values per parameter. Arrays take repeated flags (or one JSON array),
 * booleans take `--flag` / `--no-flag`, objects take JSON.
 * @param {Command} cmd @param {string[]} argv @returns {Record<string, unknown>}
 */
export function parseFlags(cmd, argv) {
  const byFlag = new Map(cmd.params.map((p) => [flagOf(p.name), p]));
  /** @type {Record<string, unknown>} */
  const values = {};
  const seenArrays = new Set();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw usageError(cmd, `Unexpected argument "${token}".`);
    const eq = token.indexOf('=');
    const [flag, inline] = eq > 0 ? [token.slice(0, eq), token.slice(eq + 1)] : [token, undefined];
    const negated = flag.startsWith('--no-') && !byFlag.has(flag) && byFlag.has(`--${flag.slice(5)}`);
    const param = byFlag.get(negated ? `--${flag.slice(5)}` : flag.replaceAll('_', '-'));
    if (!param) throw usageError(cmd, `Unknown flag ${flag}.${suggest(flag, [...byFlag.keys()])}`);
    const schema = baseType(param.schema);
    if (schema.type === 'boolean' && inline === undefined && (negated || argv[i + 1] === undefined || argv[i + 1].startsWith('--'))) {
      values[param.name] = !negated;
      continue;
    }
    const raw = inline ?? argv[++i];
    if (raw === undefined) throw usageError(cmd, `${flag} needs a value.`);
    if (schema.type === 'array' && !raw.trimStart().startsWith('[')) {
      if (!seenArrays.has(param.name)) values[param.name] = [];
      seenArrays.add(param.name);
      /** @type {unknown[]} */ (values[param.name]).push(convert(raw, schema.items ?? {}, flag));
    } else {
      values[param.name] = convert(raw, schema, flag);
    }
  }
  return values;
}

/**
 * Splits flag values into the request parts, with `--input` as the base body.
 * @param {Command} cmd @param {Record<string, unknown>} values @param {unknown} [input]
 */
export function buildRequest(cmd, values, input) {
  const missing = cmd.params.filter((p) => p.required && values[p.name] === undefined && !(p.in === 'body' && isObject(input) && p.name in input));
  if (missing.length) throw usageError(cmd, `Missing ${missing.map((p) => flagOf(p.name)).join(', ')}.`);

  let path = cmd.path;
  const query = new URLSearchParams();
  /** @type {Record<string, unknown>} */
  const fields = {};
  for (const p of cmd.params) {
    const value = values[p.name];
    if (value === undefined) continue;
    if (p.in === 'path') path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
    else if (p.in === 'query') for (const v of Array.isArray(value) ? value : [value]) query.append(p.name, typeof v === 'object' ? JSON.stringify(v) : String(v));
    else fields[p.name.replace(/^body_/, '')] = value;
  }
  let body = input;
  if (Object.keys(fields).length) {
    if (input !== undefined && !isObject(input)) throw usageError(cmd, 'Body flags can only be combined with an --input JSON object.');
    body = { ...(/** @type {object} */ (input) ?? {}), ...fields };
  }
  if (body === undefined && cmd.body?.required) body = {};
  return { path: `${path}${query.size ? `?${query}` : ''}`, body };
}

const isObject = (/** @type {unknown} */ v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Names of the body fields that take a file path. @param {Command} cmd */
export const fileFields = (cmd) => new Set(cmd.params.filter((p) => p.in === 'body' && isFile(p.schema)).map((p) => p.name));

/** @param {Command} cmd @param {string} message */
function usageError(cmd, message) {
  const example = renderExamples(cmd)[0];
  return new CliError(`${message}\n\nUsage: ${usageLine(cmd)}${example ? `\nExample: ${example.replace(/^# .*\n\s*/, '')}` : ''}\nMore: ${PROG} ${cmd.group} ${cmd.action} --help`, EXIT.USAGE);
}

// ---------- help ----------

/** First sentence or line, for one-line listings. */
export function summary(text = '', max = 90) {
  const first = text.trim().split(/\n|(?<=\.)\s/)[0] ?? '';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** @param {Command} cmd */
function usageLine(cmd) {
  const required = cmd.params.filter((p) => p.required).map((p) => `${flagOf(p.name)} <${typeLabel(p.schema)}>`);
  if (cmd.params.some((p) => !p.required)) required.push('[options]');
  return [PROG, cmd.group, cmd.action, ...required].join(' ');
}

const shellQuote = (/** @type {string} */ s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** @param {Command} cmd */
function renderExamples(cmd) {
  return cmd.examples.map(({ title, args }) => {
    const flags = Object.entries(args).flatMap(([k, v]) => {
      if (v === true) return [flagOf(k)];
      if (v === false) return [`--no-${k.replaceAll('_', '-')}`];
      if (Array.isArray(v) && v.every((x) => typeof x !== 'object')) return v.flatMap((x) => [flagOf(k), shellQuote(String(x))]);
      return [flagOf(k), shellQuote(typeof v === 'object' ? JSON.stringify(v) : String(v))];
    });
    return `${title ? `# ${title}\n  ` : ''}${[PROG, cmd.group, cmd.action, ...flags].join(' ')}`;
  });
}

const MAX_ACTIONS_LISTED = 8;

/** @param {Tree} tree @param {string} status */
export function rootHelp(tree, status) {
  const width = Math.max(...[...tree.keys()].map((g) => g.length)) + 2;
  const groups = [...tree].map(([group, actions]) => {
    const names = [...actions.keys()];
    const more = names.length > MAX_ACTIONS_LISTED ? `, … +${names.length - MAX_ACTIONS_LISTED}` : '';
    return `  ${group.padEnd(width)}${names.slice(0, MAX_ACTIONS_LISTED).join(', ')}${more}`;
  });
  return [
    `${PROG} – the Leadspicker API on the command line. ${status}`,
    '',
    `Usage: ${PROG} <group> <action> [--flags]`,
    '',
    'Groups and their actions:',
    ...groups,
    '',
    'Account and raw access:',
    `  ${'login'.padEnd(width)}log in through the browser (--no-browser to paste the redirect URL)`,
    `  ${'logout'.padEnd(width)}log out and revoke the session`,
    `  ${'whoami'.padEnd(width)}show the logged-in user`,
    `  ${'api'.padEnd(width)}raw request: ${PROG} api GET /lists`,
    '',
    `Next: ${PROG} <group> --help lists a group's actions; ${PROG} <group> <action> --help shows flags and examples.`,
  ].join('\n');
}

/** @param {string} group @param {Map<string, Command>} actions */
export function groupHelp(group, actions) {
  const width = Math.max(...[...actions.keys()].map((a) => a.length)) + 2;
  const examples = [...actions.values()].flatMap(renderExamples).slice(0, 3);
  return [
    `Usage: ${PROG} ${group} <action> [--flags]`,
    '',
    'Actions:',
    ...[...actions].map(([action, cmd]) => `  ${action.padEnd(width)}${summary(cmd.op.summary ?? cmd.op.description)}`),
    ...(examples.length ? ['', 'Examples:', ...examples.map((e) => `  ${e}`)] : []),
    '',
    `Next: ${PROG} ${group} <action> --help shows flags and examples.`,
  ].join('\n');
}

/** @param {Command} cmd @param {Tree} tree */
export function actionHelp(cmd, tree) {
  const flags = cmd.params.map((p) => {
    const s = baseType(p.schema);
    const notes = [p.required ? 'required' : null, s.default != null && s.default !== '' ? `default ${JSON.stringify(s.default)}` : null].filter(Boolean);
    const desc = (p.description || s.title || '').trim();
    return `  ${flagOf(p.name)} <${typeLabel(p.schema)}>${notes.length ? ` (${notes.join(', ')})` : ''}${desc ? `\n      ${desc.replaceAll('\n', '\n      ')}` : ''}`;
  });
  const examples = renderExamples(cmd);
  const description = (cmd.op.description ?? '').replace(/(Example payload:)?\s*```json[\s\S]*?```/g, '').trim();
  const related = [...(tree.get(cmd.group)?.keys() ?? [])].filter((a) => a !== cmd.action).slice(0, 10);
  return [
    `Usage: ${usageLine(cmd)}`,
    '',
    cmd.op.summary ?? '',
    ...(description ? ['', description] : []),
    ...(cmd.method === 'DELETE' ? ['', 'Deletes data: needs --yes when not run interactively.'] : []),
    '',
    'Flags:',
    ...(flags.length ? flags : ['  (none)']),
    ...(cmd.body?.mediaType === 'application/json' ? [`  --input <file.json|->\n      request body as JSON (flags are merged into it)`] : []),
    ...(examples.length ? ['', 'Examples:', ...examples.map((e) => `  ${e}`)] : []),
    ...(related.length ? ['', `Related: ${related.map((a) => `${cmd.group} ${a}`).join(', ')}`] : []),
    '',
    `API: ${cmd.method} ${cmd.path}`,
  ].join('\n');
}

/** " Did you mean …?" for the closest names, or nothing. @param {string} input @param {string[]} names */
export function suggest(input, names) {
  const scored = names
    .map((name) => ({ name, d: name.startsWith(input) || input.startsWith(name) ? 0 : distance(input, name) }))
    .filter(({ d, name }) => d <= Math.max(2, Math.floor(name.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
  return scored.length ? ` Did you mean ${scored.map((s) => s.name).join(', ')}?` : '';
}

/** Levenshtein distance. @param {string} a @param {string} b */
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}
