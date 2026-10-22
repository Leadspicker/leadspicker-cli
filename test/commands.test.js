import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTree, operationName } from '../src/commands.js';

const P = '/app/sb/api';
const op = (tag, extra = {}) => ({ tags: [tag], ...extra });
const names = (spec) => [...buildTree(spec)].flatMap(([g, a]) => [...a].map(([k, c]) => `${g} ${k} = ${c.method} ${c.path.slice(P.length)}`)).sort();

const SPEC = {
  paths: {
    [`${P}/lists`]: { get: op('List'), post: op('List') },
    [`${P}/lists/{id}`]: { get: op('List'), patch: op('List'), delete: op('List') },
    [`${P}/sequences/{project_id}/sequence`]: { delete: op('Email Sequence') },
    [`${P}/sequence/{sequence_id}`]: { delete: op('Email Sequence') },
    [`${P}/email-accounts`]: { patch: op('Outreach Accounts', { operationId: 'apps_salesbooster_apis_email_accounts_email_accounts_bulk_update' }) },
    [`${P}/email-accounts/{id}`]: { patch: op('Outreach Accounts', { operationId: 'apps_salesbooster_apis_email_accounts_email_accounts_update' }) },
    [`${P}/robots/{id}`]: { put: op('Robots'), patch: op('Robots') },
  },
};

test('names come from the tag and path; clashes are resolved without method suffixes where paths differ', () => {
  assert.deepEqual(names(SPEC), [
    'email-sequence delete = DELETE /sequence/{sequence_id}',
    'email-sequence sequence-delete = DELETE /sequences/{project_id}/sequence',
    'list create = POST /lists',
    'list delete = DELETE /lists/{id}',
    'list get = GET /lists/{id}',
    'list list = GET /lists',
    'list update = PATCH /lists/{id}',
    'outreach-accounts email-accounts-bulk-update = PATCH /email-accounts',
    'outreach-accounts email-accounts-update = PATCH /email-accounts/{id}',
    'robots update-patch = PATCH /robots/{id}',
    'robots update-put = PUT /robots/{id}',
  ]);
});

test('names do not depend on the order of the spec', () => {
  const reversed = { paths: Object.fromEntries(Object.entries(SPEC.paths).reverse()) };
  assert.deepEqual(names(reversed), names(SPEC));
});

test('adding an unrelated endpoint renames nothing', () => {
  const more = { paths: { ...SPEC.paths, [`${P}/lists/{id}/clone`]: { post: op('List') }, [`${P}/webhooks`]: { get: op('List') } } };
  const before = new Set(names(SPEC));
  for (const name of names(SPEC)) assert.ok(new Set(names(more)).has(name), name);
  assert.equal(before.size, names(SPEC).length);
});

test('a multi-word tag drops its whole plural; a tag no path repeats drops its most frequent root', () => {
  const spec = {
    paths: {
      [`${P}/api-keys`]: { get: op('API Key'), post: op('API Key') },
      [`${P}/api-keys/{id}`]: { delete: op('API Key') },
      [`${P}/tricorder/companies/search`]: { post: op('Company intelligence') },
      [`${P}/tricorder/company/{id}`]: { get: op('Company intelligence') },
      [`${P}/workflows/{id}`]: { get: op('Integrations'), delete: op('Integrations') },
      [`${P}/workflow-types`]: { get: op('Integrations') },
      [`${P}/b-accounts/{id}`]: { get: op('Outreach Accounts') },
      [`${P}/a-accounts/{id}`]: { get: op('Outreach Accounts') },
    },
  };
  assert.deepEqual(names(spec), [
    'api-key create = POST /api-keys',
    'api-key delete = DELETE /api-keys/{id}',
    'api-key list = GET /api-keys',
    'company-intelligence companies-search = POST /tricorder/companies/search',
    'company-intelligence company-get = GET /tricorder/company/{id}',
    'integrations delete = DELETE /workflows/{id}',
    'integrations get = GET /workflows/{id}',
    'integrations workflow-types = GET /workflow-types',
    'outreach-accounts b-accounts-get = GET /b-accounts/{id}',
    'outreach-accounts get = GET /a-accounts/{id}',
  ]);
});

test('operationName drops the python module prefix', () => {
  assert.equal(operationName('apps_salesbooster_apis_email_accounts_email_accounts_update'), 'email-accounts-update');
  assert.equal(operationName('apps_salesbooster_api_get_lists'), 'get-lists');
  assert.equal(operationName('list_enrich_project_person'), 'list-enrich-project-person');
});
