# Leadspicker CLI

The [Leadspicker](https://www.leadspicker.com/) API on the command line. Every endpoint is a command, generated
from the API's OpenAPI description, so new endpoints show up without a CLI update.

```bash
npx @leadspicker/cli login
npx @leadspicker/cli list create --name "DACH founders" --timezone Europe/Prague
```

Or install it: `npm install -g @leadspicker/cli`, then run `leadspicker`. Requires Node.js 22 or newer and has
no dependencies.

## Log in

```bash
leadspicker login                 # opens the browser; approve access and you're done
leadspicker login --no-browser    # SSH / headless: open the printed URL anywhere, paste back the redirect URL
leadspicker whoami
leadspicker logout                # revokes the session
```

Login uses OAuth (the same consent screen as Leadspicker's AI connectors) and works on every plan. The session is
stored in `~/.config/leadspicker/config.json` (mode 0600) and refreshed automatically.

## Find your way around

Help is layered. Each level shows only what is needed and points one level deeper:

```bash
leadspicker --help                 # groups and their actions
leadspicker list --help            # one group's actions, with examples
leadspicker list create --help     # flags, types, defaults and examples for one action
```

Typos get suggestions, and a wrong or missing flag prints the usage line with an example.

## Commands

`leadspicker <group> <action> [--flags]`. Groups are the API's sections, and actions are its endpoints.

- **Flags** map to the endpoint's path, query and body parameters: `--project-id 5`, `--tags a --tags b` for
  lists, `--flag` / `--no-flag` for booleans, and JSON for objects.
- **`--input file.json`** (or `-` for stdin) sends a JSON body. Flags are merged into it.
- **File fields** (imports) take a path: `--file contacts.csv`.
- **`--yes`** confirms a DELETE when the command isn't run interactively.
- **`leadspicker api <METHOD> <path> [--input body.json] [--yes]`** sends a raw request to any API path, e.g.
  `leadspicker api GET /lists`. A raw DELETE needs `--yes` too.

**Command names follow the API.** They are derived from it each time, so a server release that renames, moves
or retags an endpoint can change a command's name. Scripts that must not break can pin the endpoint with
`leadspicker api` instead; `<group> <action> --help` shows each command's `METHOD /path`.

JSON responses are printed as JSON: pretty in a terminal, compact when piped. Anything else, such as CSV exports,
is written as-is, so `> export.csv` works.

## For scripts and AI agents

- Results go to stdout and errors to stderr.
- Exit codes: `0` ok, `1` API error, `2` usage error, `3` not logged in.
- Nothing prompts when stdin isn't a terminal.
- Point an agent at the CLI with: *"Use `npx @leadspicker/cli` for Leadspicker; start with `--help`."*

## Environment

| Variable | Default | |
|---|---|---|
| `LEADSPICKER_URL` | `https://app.leadspicker.com` | the server to log in to |
| `XDG_CONFIG_HOME` | `~/.config` | where the login is stored |
| `XDG_CACHE_HOME` | `~/.cache` | where the API description is cached (1 h) |

## Development

```bash
npm test     # node:test, against a fake OAuth + API server
node bin/leadspicker.js --help
```

Plain JavaScript (ESM, JSDoc types) with no build step and no dependencies.

Commands are built from the OpenAPI document as follows:
- Tags become groups.
- The path and method become the action: `GET /lists/{id}` → `get`, `POST /lists/{id}/clone` → `clone`. A first
  path segment that just repeats the tag (`lists` for List, `api-keys` for API Key) is dropped; for a tag no path
  repeats, its most frequent first segment is dropped instead (`tricorder` for Company intelligence).
- A name depends only on the operation's own tag, path and method (and, for that fallback, on which first segment
  its tag uses most), never on the order of the document. When
  names clash, every clashing operation is renamed the same way: to its full path words, then (same path) a
  method suffix, then its operationId.
- The server can override these with the operation extensions `x-cli-group`, `x-cli-action` and
  `x-cli-examples`. Without `x-cli-examples`, the ```json payloads in operation descriptions are used as
  examples.
- Deprecated operations are hidden.

## Releasing

Releases are published by hand from a maintainer's machine (npm asks for a browser 2FA approval):

```bash
npm version 0.2.0 -m "%s"    # bumps package.json, commits and tags v0.2.0
git push origin main --follow-tags
npm test && npm publish --access public              # stable releases (moves `latest`)
npm test && npm publish --access public --tag beta   # pre-releases such as 0.2.0-beta.1
```

Pre-releases must go out with `--tag beta`, or they become `latest`.
