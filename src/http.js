// @ts-check
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const EXIT = { ERROR: 1, USAGE: 2, AUTH: 3 };

export class CliError extends Error {
  /** @param {string} message @param {number} [exitCode] */
  constructor(message, exitCode = EXIT.ERROR) {
    super(message);
    this.exitCode = exitCode;
  }
}

export const notLoggedIn = (why = 'Not logged in.') => new CliError(`${why} Run: leadspicker login`, EXIT.AUTH);

/**
 * fetch with our User-Agent; a 429 is retried once after Retry-After.
 * @param {string} url @param {RequestInit & {headers?: Record<string, string>}} [init]
 */
export async function request(url, init = {}) {
  const headers = { 'user-agent': `leadspicker-cli/${VERSION}`, ...init.headers };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, headers });
    if (res.status !== 429 || attempt > 0) return res;
    const wait = Number(res.headers.get('retry-after')) || 5;
    await sleep(Math.min(wait, 60) * 1000);
  }
}

/** @param {string} url @param {Record<string, string>} form */
export async function postForm(url, form) {
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}
