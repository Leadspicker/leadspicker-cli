// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError, request } from './http.js';

export const API_PREFIX = '/app/sb/api';
const TTL_MS = 60 * 60_000;

const cacheDir = () => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'leadspicker');

/**
 * The API's OpenAPI document, cached for an hour (it is ~1 MB). The schema is public, so this
 * needs no login. A stale copy is used when the server can't be reached.
 * @param {string} baseUrl @param {{fresh?: boolean}} [opts]
 */
export async function loadSpec(baseUrl, { fresh = false } = {}) {
  const file = path.join(cacheDir(), `openapi-${crypto.createHash('sha256').update(baseUrl).digest('hex').slice(0, 12)}.json`);
  /** @type {{fetched_at: number, spec: any} | null} */
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  if (cached && !fresh && Date.now() - cached.fetched_at < TTL_MS) return { spec: cached.spec, fromCache: true };

  try {
    const res = await request(`${baseUrl}${API_PREFIX}/openapi.json`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new CliError(`Could not load the API description: HTTP ${res.status}`);
    const spec = await res.json();
    fs.mkdirSync(cacheDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ fetched_at: Date.now(), spec }));
    fs.renameSync(tmp, file);
    return { spec, fromCache: false };
  } catch (err) {
    if (cached) return { spec: cached.spec, fromCache: true };
    throw err instanceof CliError ? err : new CliError(`Could not reach ${baseUrl}: ${/** @type {Error} */ (err).message}`);
  }
}
