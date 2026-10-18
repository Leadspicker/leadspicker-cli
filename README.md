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
- **`leadspicker api <METHOD> <path> [--input body.json]`** sends a raw request to any API path, e.g.
  `leadspicker api GET /lists`.

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

Plain JavaScript (ESM, JSDoc types) with no build step and no dependencies. Releases are published to npm from
`v*` tags by `.github/workflows/publish.yml`; `-beta` versions go to the `beta` dist-tag.

Commands are built from the OpenAPI document as follows:
- Tags become groups.
- The path and method become the action: `GET /lists/{id}` → `get`, `POST /lists/{id}/clone` → `clone`.
- The server can override these with the operation extensions `x-cli-group`, `x-cli-action` and
  `x-cli-examples`. Without `x-cli-examples`, the ```json payloads in operation descriptions are used as
  examples.
- Deprecated operations are hidden.
