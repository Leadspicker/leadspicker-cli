// @ts-check
import { PROG } from './commands.js';

// The page the browser lands on after `login`, styled like Leadspicker's OAuth consent page. The logo
// and favicon come from the server the user just logged in to; fonts are the system's, so the page
// makes no third-party requests.

const escape = (/** @type {string} */ s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const ICONS = {
  success:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v6m0 4h.01" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
};

/**
 * @param {{base: string, kind: 'success' | 'error', title: string, text: string, command: string}} page
 *   `text` is HTML: escape anything user-supplied before passing it in.
 */
function render({ base, kind, title, text, command }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)} – Leadspicker</title>
<link rel="shortcut icon" href="${escape(base)}/static/frontend/img/favicon.ico">
<style>
  :root {
    --color-primary: #335CFF;
    --color-background-weakest: #F5F6FD;
    --color-stroke-soft-200: #E1E4EA;
    --color-light: #FFFFFF;
    --color-gray-darker: #525866;
    --color-black-3: #0e121b;
    --color-success: #0bbb9b;
    --color-success-bg: #e7f9f5;
    --color-error: #fb4b6b;
    --color-error-bg: #ffe3e8;
    --lp-color-background: #F0F1F5;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    color: var(--color-black-3);
    font-family: "Poppins", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(180deg, var(--color-background-weakest), var(--lp-color-background));
  }
  .brand { padding: 32px 16px 12px; text-align: center; }
  .brand img { height: 40px; }
  .wrap { padding: 24px 16px 64px; }
  .card {
    max-width: 520px;
    margin: 0 auto;
    padding: 36px 40px;
    text-align: center;
    background: var(--color-light);
    border: 1px solid var(--color-stroke-soft-200);
    border-radius: 18px;
    box-shadow: 0 24px 60px rgba(14, 18, 27, 0.12);
  }
  .icon {
    display: inline-flex;
    width: 56px;
    height: 56px;
    margin-bottom: 20px;
    padding: 14px;
    border-radius: 999px;
  }
  .icon svg { width: 100%; height: 100%; }
  .success .icon { color: var(--color-success); background: var(--color-success-bg); }
  .error .icon { color: var(--color-error); background: var(--color-error-bg); }
  h1 { margin: 0 0 8px; font-size: 24px; letter-spacing: -0.01em; }
  p { margin: 0 0 20px; color: var(--color-gray-darker); font-size: 15px; line-height: 1.6; }
  strong { color: var(--color-black-3); font-weight: 600; }
  .next { margin: 0 0 8px; font-size: 13px; }
  code {
    display: inline-block;
    padding: 10px 18px;
    border: 1px solid var(--color-stroke-soft-200);
    border-radius: 12px;
    background: var(--color-background-weakest);
    color: var(--color-primary);
    font: 500 14px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-all;
  }
  @media (max-width: 560px) { .card { padding: 28px 20px; } }
</style>
</head>
<body>
<div class="brand"><img src="${escape(base)}/static/salesbooster/img/logo_leadspicker_with_name_v2.svg" alt="Leadspicker"></div>
<main class="wrap">
  <section class="card ${kind}">
    <span class="icon">${ICONS[kind]}</span>
    <h1>${escape(title)}</h1>
    <p>${text}</p>
    <p class="next">${kind === 'success' ? 'Back in your terminal, try' : 'To try again, run'}</p>
    <code>${escape(command)}</code>
  </section>
</main>
</body>
</html>`;
}

/** @param {string} base @param {string | null} email */
export const successPage = (base, email) =>
  render({
    base,
    kind: 'success',
    title: "You're logged in",
    text: `The Leadspicker CLI is now connected to ${email ? `<strong>${escape(email)}</strong>` : 'your account'}. You can close this tab.`,
    command: `${PROG} --help`,
  });

/** @param {string} base @param {string} message */
export const errorPage = (base, message) =>
  render({ base, kind: 'error', title: "Login didn't complete", text: escape(message), command: `${PROG} login` });
