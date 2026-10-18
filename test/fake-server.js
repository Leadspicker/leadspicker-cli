// A fake Leadspicker: OAuth (PKCE, rotating refresh tokens), an OpenAPI document and the REST routes it describes.
import crypto from 'node:crypto';
import http from 'node:http';

const P = '/app/sb/api';
const id = (name) => ({ in: 'path', name, required: true, schema: { type: 'integer', title: name } });

export const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Fake', version: '1' },
  paths: {
    [`${P}/lists`]: {
      get: { tags: ['List'], summary: 'Get Lists', parameters: [{ in: 'query', name: 'page', schema: { type: 'integer', default: 1 } }] },
      post: {
        tags: ['List'],
        summary: 'Create a List',
        description: 'Create a list.\n\nExample payload:\n```json\n{\n  "name": "DACH founders",\n  "timezone": "Europe/Prague"\n}\n```',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ListIn' } } } },
      },
    },
    [`${P}/lists/{project_id}`]: {
      get: { tags: ['List'], summary: 'Get List detail', parameters: [id('project_id')] },
      delete: { tags: ['List'], summary: 'Delete List', parameters: [id('project_id')] },
    },
    [`${P}/lists/{project_id}/people`]: {
      get: {
        tags: ['List'],
        summary: 'Get people. Paginated.',
        parameters: [
          id('project_id'),
          { in: 'query', name: 'tags', schema: { type: 'array', items: { type: 'string' } } },
          { in: 'query', name: 'order_by', schema: { type: 'string', enum: ['created', '-created'] } },
          { in: 'query', name: 'include_deleted', schema: { anyOf: [{ type: 'boolean' }, { type: 'null' }] } },
        ],
      },
    },
    [`${P}/lists/{project_id}/import`]: {
      post: {
        tags: ['List'],
        summary: 'Import contacts from a file',
        parameters: [id('project_id')],
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, delimiter: { type: 'string' } } },
            },
          },
        },
      },
    },
    [`${P}/lists/{project_id}/export-data`]: { get: { tags: ['List'], summary: 'Export Persons', parameters: [id('project_id')] } },
    [`${P}/projects`]: { get: { tags: ['Project'], summary: 'Old list', deprecated: true } },
    [`${P}/auth/me`]: { get: { tags: ['Auth'], summary: 'Get current user info' } },
  },
  components: {
    schemas: {
      ListIn: {
        type: 'object',
        required: ['name', 'timezone'],
        properties: { name: { type: 'string', maxLength: 350 }, timezone: { type: 'string' }, labels: { type: 'array', items: { type: 'integer' } } },
      },
    },
  },
};

export async function startFakeServer() {
  const state = { refreshCalls: 0, specFetches: 0, revoked: [], requests: [], access: new Set(), refresh: new Set(), codes: new Map(), counter: 0 };
  const issue = () => {
    const n = ++state.counter;
    state.access.add(`at-${n}`);
    state.refresh.add(`rt-${n}`);
    return { access_token: `at-${n}`, refresh_token: `rt-${n}`, token_type: 'Bearer', expires_in: 3600 };
  };
  const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = raw.toString('utf8');

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, revocation_endpoint: `${base}/revoke` });
    }
    if (url.pathname === '/authorize') {
      // Auto-consent: redirect straight back with a code bound to the PKCE challenge.
      const code = `code-${crypto.randomUUID()}`;
      state.codes.set(code, url.searchParams.get('code_challenge'));
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.search = new URLSearchParams({ code, state: url.searchParams.get('state') }).toString();
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        const challenge = state.codes.get(form.get('code'));
        const actual = crypto.createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (!challenge || challenge !== actual) return json(res, 400, { error: 'invalid_grant' });
        state.codes.delete(form.get('code'));
        return json(res, 200, issue());
      }
      state.refreshCalls++;
      // Rotation: a refresh token works exactly once.
      if (!state.refresh.delete(form.get('refresh_token'))) return json(res, 400, { error: 'invalid_grant' });
      return json(res, 200, issue());
    }
    if (url.pathname === '/revoke') {
      const token = new URLSearchParams(body).get('token');
      state.revoked.push(token);
      state.access.delete(token);
      state.refresh.delete(token);
      return res.writeHead(200).end();
    }
    if (url.pathname === `${P}/openapi.json`) {
      state.specFetches++;
      return json(res, 200, SPEC);
    }

    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!state.access.has(bearer)) return json(res, 401, { detail: 'Unauthorized' });
    const record = { method: req.method, path: url.pathname, query: url.search, contentType: req.headers['content-type'] ?? '', body };
    state.requests.push(record);

    if (url.pathname === `${P}/auth/me`) return json(res, 200, { email: 'test@example.com' });
    if (url.pathname === `${P}/lists/404`) return json(res, 404, { detail: 'List not found.' });
    if (url.pathname.endsWith('/export-data')) return res.writeHead(200, { 'content-type': 'text/csv' }).end('name,email\nAda,ada@example.com\n');
    if (req.method === 'DELETE') return res.writeHead(204).end();
    return json(res, 200, record);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, state, issue, close: () => new Promise((resolve) => server.close(resolve)) };
}
