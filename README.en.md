# PolyMock

English | [简体中文](./README.md)

> A local HTTP mock server: group services on independent ports or path prefixes, register routes at runtime, match requests by conditions, and switch response scenarios on the fly — built for frontend local development and integration testing.

## Introduction

Backend APIs under active development often live on an intranet, forcing developers to switch networks back and forth between local work and live integration. PolyMock simulates those HTTP APIs locally: point your app at PolyMock during development, then switch the base URL back to the real backend when it is time to integrate — no code changes in between.

It is not a static fixture tool but a **local server whose routes are managed at runtime**:

- Register, edit, enable/disable routes at any time via the web console or the admin API — no restarts
- Define multiple response scenarios (variants) per route, routed automatically by request conditions or switched globally with one click
- Unmatched requests can pass through a proxy to the real backend, so mocks and live APIs blend seamlessly

Tech stack: Node.js 18+ / TypeScript / Express 5 (backend), Vue 3 + Vite (web console), Vitest (tests). Package manager: pnpm.

## Quick Start

```bash
pnpm install
pnpm build        # tsc compiles the backend to dist/ + vite builds the frontend to public/
pnpm start        # then open http://localhost:33233
```

> `public/` contains frontend build output and is not committed. **Run `pnpm build` after cloning**, otherwise the web UI will not be served.

Once started:

- Web console: <http://localhost:33233>
- The default service `default` listens on the main port (`33233` out of the box; **to change it, edit the `port` field of the `default` service in `polymock.config.json` and restart — no source changes needed**) and ships with a default route `GET /api/hello`
- Every change is persisted to `polymock.config.json` automatically and restored on restart

### Development mode

```bash
pnpm dev          # backend with hot reload (tsx watch)
pnpm dev:web      # frontend Vite dev server (HMR); /__polymock proxy follows the main port automatically
```

In development mode the web UI is served by Vite (default <http://localhost:5173>); mock requests themselves still go to the main port or to each service group's port.

### Your first route

```bash
# Register a route with request conditions and response variants
curl -X POST http://localhost:33233/__polymock/routes \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Order list",
    "method": "GET",
    "path": "/api/orders",
    "response": { "status": 200, "body": { "role": "default" } },
    "variants": [
      { "name": "admin view", "match": { "headers": [{ "key": "X-Role", "value": "admin" }] },
        "response": { "status": 200, "body": { "role": "admin" } } }
    ]
  }'

curl http://localhost:33233/api/orders                                    # {"role":"default"}
curl -H "X-Role: admin" http://localhost:33233/api/orders                 # {"role":"admin"}
```

### Docker

The image ships with path mode enabled (`POLYMOCK_MODE=path`): every service is dispatched from the main port under a `/{basePath}` prefix, so a single port needs exposing. Configuration persists to the `/data` volume and survives restarts.

```bash
docker build -t polymock .
docker run -d --name polymock -p 33233:33233 -v polymock-data:/data polymock
```

Open <http://localhost:33233> afterwards. Creating a service group requires no port; routes are served at `http://localhost:33233/{basePath}{routePath}` (see "Run modes" below).

## Run modes

The `POLYMOCK_MODE` environment variable decides how service groups are hosted; the default is `port`:

| Mode | Description |
| --- | --- |
| `port` (default) | Each service group listens on its own port; the default service occupies the main port |
| `path` | Every service is dispatched from the main port under a `/{basePath}` prefix; only the main port needs exposing — ideal for containers |

Differences in path mode:

- Service groups are created without ports and distinguished by their `basePath` prefix; when omitted it is derived from the service name (lowercase letters/digits/hyphens, with `-2`, `-3`… appended on collision) and can be edited any time in the console's service panel
- A route's real URL is `http://<host>/{basePath}{routePath}` — e.g. a `GET /api/orders` route in a service whose basePath is `order` is served at `/order/api/orders`; the default service stays at the main port root with no prefix
- A `basePath` cannot use the reserved prefixes (`__polymock`, `assets`) and must not clash with another service's basePath or the first segment of any default-service route — conflicts are rejected with 409
- Services in older config files missing a `basePath` are migrated automatically on startup; the current mode is available via `GET /__polymock/meta`, and the web console adapts its forms and URL building accordingly

## Features

### Route management

- **Service groups**: besides the default service on the main port, create any number of service groups — each listens on its own port in port mode, or is dispatched from the main port under a `/{basePath}` prefix in path mode (see "Run modes")
- **Web console**: drawer-style form for creating/editing routes; conditions are edited in Postman-style tables (the Body tab converts between table rows and JSON in both directions)
- **Enable/disable routes**: a disabled route is treated as unregistered (and falls through to the proxy when configured)
- **Delete confirmation**: deleting a service or a route always asks for confirmation

### Request matching

- **Path matching**: exact paths plus `:param` segments (e.g. `/api/users/:id`); shape conflicts (including clashing parameter segments) are rejected with 409 at registration time
- **Condition dimensions**: three groups — query parameters, request headers (case-insensitive), and JSON body dot paths (e.g. `user.id`)
- **Comparison types**: `string` (default, stringified comparison) / `number` / `boolean` / `json` (deep equality) / `array` (containment — the actual array must contain every element of the expected JSON array, order-insensitive); an empty expected value means "the key just needs to exist"
- **Required/optional**: conditions are required by default; with `required: false` a missing key passes (the value is only compared when present)
- **requireMatch gate**: when enabled, every request must satisfy the route's `request` conditions or it is rejected with 400 and a reason (takes precedence over any variant)
- **Route-level auth**: configure `auth` to simulate backend authentication — requests without valid credentials are rejected with 401; supports `apikey` (secret in a custom header, default `X-API-Key`, header name configurable) and `bearer` (`Authorization: Bearer <token>`, with `WWW-Authenticate: Bearer` on 401); 401 takes precedence over the requireMatch gate and applies to CRUD routes too

### Response capabilities

- **Response variants (scenarios)**: attach multiple named variants to a route; they are matched in array order and the first one whose conditions all pass wins — otherwise the default response is used
- **Sequence responses**: cycle through a list of responses in hit order (e.g. "ok → ok → error"), taking precedence over the scene set, variants, and the default response
- **Global scene set**: once `activeVariant` is set, every route that has a variant with that name is forced onto it (its `match` conditions are bypassed) — one click switches the whole server
- **Dynamic response templates**: inside string values of the response body, use `{{query.x}}`, `{{header.x}}`, `{{body.x}}` (dot path), `{{params.x}}` (path parameters), `{{$id}}` (per-route auto increment), `{{$now}}` (ISO timestamp), `{{$int(a,b)}}` (random integer, inclusive), plus built-in fake data: `{{$name}}` `{{$ename}}` `{{$email}}` `{{$phone}}` `{{$city}}` `{{$word}}` `{{$bool}}`. Unresolvable placeholders are left as-is
- **Custom response headers**: the default response, every variant, and each sequence step can attach custom headers; values support template placeholders (e.g. `Location: /api/users/{{params.id}}`, `X-Request-Id: {{$id}}`); repeated names are sent as multi-value headers (e.g. multiple Set-Cookie); applied after the `contentType` field — a same-named Content-Type header overrides it; managed headers such as `content-length` / `transfer-encoding` are rejected at registration (400)
- **Delay / jitter / fault injection**: `delayMs` (0-60000 fixed delay) + `jitterMs` (random jitter cap), and `failureRate` (0-100%) to return 500 with some probability
- **Formatting and instant validation**: one-click body formatting, on-blur JSON validation with inline error highlight, and a second server-side validation on submit

Response resolution order: route-level auth (401) → `requireMatch` gate → sequence response → global scene set → conditional variants → default response.

### Stateful CRUD

Routes with `crud` enabled respond with resource semantics (in-memory only, reset on restart):

- **Collection routes** (no parameter segment): `GET` returns all resources, `POST` creates one (auto-generating an `rec-N` id when absent)
- **Item routes** (path contains an `:id` segment): `GET` fetches one (404 when missing), `PUT`/`PATCH` shallow-merges (keeping the original id), `DELETE` removes
- Only GET/POST/PUT/PATCH/DELETE are supported; other methods return 405

### Debugging

- **Request log**: a 500-entry ring buffer recording method/path/query/body preview/status/duration, annotated with the matched route and variant (or the proxy pass-through and failure reason)
- **Live updates**: new entries are pushed over SSE (`/__polymock/events`); when the connection is unavailable the panel automatically falls back to 2-second polling
- **Filter and replay**: filter by status class (2xx/4xx/5xx), service, or path keyword; GET entries can be replayed with one click, and any entry can be copied as curl
- **Save as route**: a proxied response body can be saved as a mock route in one click — capture once, mock forever

### Proxy pass-through

- **Service-level `proxyTarget`**: configure a real backend on a service group and unmatched requests are forwarded to it (with `host` / `content-length` stripped)
- Upstream failures and non-whitelisted targets return 502; the upstream body (first 5000 characters) is recorded in the request log for "save as route"

### Import / export

- **OpenAPI 3 JSON import**: paste a document in the console; get/post/put/patch/delete operations under `paths` are imported with `$ref` resolution (JSON Pointer, depth limit 10), schema sampling for example responses (example/default first, first enum value, date/date-time as ISO strings, etc.), and `{id}` path segments converted to `:id`. Capped at 100 routes by default (truncation flagged); failures/skips are listed in the report
- **Snippet copying**: each route card can copy the mock URL, a curl command, a fetch snippet, and a Java entity class derived from the response JSON (Lombok `@Data` style, nested objects as static inner classes, arrays typed from the first element as `List<T>`)

### Security (optional)

- **Admin token**: when `POLYMOCK_ADMIN_TOKEN` is set, every `/__polymock` endpoint requires the `x-polymock-token` header (or `?token=` for SSE), otherwise 401
- **Proxy allowlist**: when `POLYMOCK_PROXY_ALLOW` is set (comma-separated host list), a proxy target's hostname must be on the list — enforced both when setting the target and before each forward

## Web Console

Open <http://localhost:33233> in a browser and switch between three views in the sidebar (your choice is remembered):

| View | Description |
| --- | --- |
| **Routes** | Service groups (create/delete, port, basePath, running status) and route cards (method color, condition summary, variant list); a drawer form edits conditions, variants, sequence responses, delay/jitter/fault injection, and the CRUD switch; the sidebar switches the global scene set with one click; includes an OpenAPI import drawer |
| **Embed test** | Load any page URL into a resizable iframe container (drag the right/bottom/bottom-right edges, fill the stage, open in a new tab) to verify your page against the mocks without leaving the console |
| **Request log** | Log list with filters (status/service/path keyword), a live (SSE) / polling badge, and actions to replay, copy curl, clear, or save a proxied entry as a route |

## Admin API

All admin endpoints live under `/__polymock` on the main port and speak JSON. Success returns `{ "ok": true, ... }`; failure returns `{ "ok": false, "error": "reason" }`. Status code semantics: `400` invalid input or unmet conditions, `401` missing admin token, `404` unknown service/route (same for mock dispatch), `409` conflict (port/service name/route shape).

| Method | Path | Description |
| --- | --- | --- |
| GET | `/__polymock/meta` | Run-mode metadata: `{ mode, mainPort }` |
| GET | `/__polymock/services` | List service groups (with `isDefault` / `running` / `basePath` / route count) |
| POST | `/__polymock/services` | Create a service group; port mode body `{ name, port }`, path mode body `{ name, basePath? }` (auto-generated when omitted) |
| DELETE | `/__polymock/services/:id` | Delete a service group (the default service cannot be deleted) |
| PUT | `/__polymock/services/:id/basePath` | Update a service's basePath prefix (path mode), body `{ basePath }` |
| PUT | `/__polymock/services/:id/proxy` | Set the proxy target, body `{ target }` (`null` or empty string clears it) |
| GET | `/__polymock/routes` | List routes; optional `?serviceId=` filter |
| POST | `/__polymock/routes` | Register a route (requires `name` / `method` / `path`; path must start with `/`) |
| PUT | `/__polymock/routes/:id` | Update a route; supports patch semantics — send only the fields to change |
| DELETE | `/__polymock/routes` | Delete by `?method=&path=&serviceId=` |
| GET | `/__polymock/requests` | Request log; optional `?serviceId=` and `?limit=` (default 100, max 500), newest first |
| DELETE | `/__polymock/requests` | Clear the request log |
| GET | `/__polymock/settings` | Read global settings (currently `activeVariant`) |
| PUT | `/__polymock/settings` | Update global settings, body `{ activeVariant }` (empty string clears it) |
| GET | `/__polymock/events` | SSE stream of request logs (`event: log`, data is the entry JSON) |

> When `POLYMOCK_ADMIN_TOKEN` is set, all of the above require the `x-polymock-token` header or a `?token=` query parameter, otherwise 401.

## Configuration File

Configuration is persisted to `polymock.config.json` (path configurable via `POLYMOCK_CONFIG_FILE`) and saved automatically on every registry change (atomic write: temp file + rename). The `port` field of the `default` service is the main port (home of the web UI, admin API, and the default service). The current schema version is `2`:

```json
{
  "version": 2,
  "services": [
    { "id": "default", "name": "Default service", "port": 33233, "createdAt": 1730000000000 },
    { "id": "u-9f2c", "name": "User service", "port": 8101, "createdAt": 1730000001000, "proxyTarget": "http://localhost:3000" }
  ],
  "routes": [
    {
      "id": "r-1a2b",
      "serviceId": "default",
      "protocol": "http",
      "method": "GET",
      "path": "/api/users/:id",
      "name": "User detail",
      "response": { "status": 200, "body": { "id": "{{params.id}}", "name": "{{$name}}" } },
      "request": { "headers": [{ "key": "X-Token", "value": "", "required": false }] },
      "requireMatch": false,
      "variants": [
        { "id": "v-01", "name": "admin view", "match": { "headers": [{ "key": "X-Role", "value": "admin" }] },
          "response": { "status": 200, "body": { "role": "admin" } } }
      ],
      "sequence": [],
      "disabled": false,
      "delayMs": 200,
      "jitterMs": 100,
      "failureRate": 0,
      "crud": false,
      "createdAt": 1730000002000
    }
  ],
  "settings": { "activeVariant": null }
}
```

Key fields:

| Field | Description |
| --- | --- |
| `version` | Schema version, currently `2` |
| `services[]` | Service groups: `id` / `name` / `port` / `createdAt`, optional `proxyTarget`; in path mode non-default services are hosted by their `basePath` prefix instead (`port` unused, set to `0`); **the `default` service's `port` is the main port — edit it and restart to take effect** |
| `routes[].method` / `path` | HTTP method and path; paths support `:param` segments |
| `routes[].response` | Default response: `status` / `contentType?` / `headers?` (custom response headers) / `body` |
| `routes[].request` / `requireMatch` | Expected request conditions and the admission gate |
| `routes[].variants[]` | Response variants: `name` / `match?` (omitted = always matches) / `response` |
| `routes[].sequence[]` | Sequence responses: `{ status, body, headers? }` entries, returned cyclically |
| `routes[].disabled` / `delayMs` / `jitterMs` / `failureRate` / `crud` | Behavior switches and simulation parameters |
| `settings.activeVariant` | Global scene set: when set, same-named variants are forced |

Older configuration files (missing `version` or `version: 1`) are migrated automatically on load — fields stay compatible, no manual action needed.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `POLYMOCK_MODE` | `port` | Run mode: `port` = independent ports per service; `path` = all services dispatched from the main port under `/{basePath}` prefixes (the Docker image defaults to `path`); see "Run modes" |
| `POLYMOCK_PORT` | `default` service `port` in the config file (`33233` out of the box) | Main port (home of the default service, web UI, and admin API); takes precedence over the config file and is written back to it when set explicitly |
| `POLYMOCK_HOST` | unset (listens on all interfaces) | Listen address; a startup warning is printed when bound to a non-loopback address without an admin token |
| `POLYMOCK_CONFIG_FILE` | `polymock.config.json` | Configuration file path |
| `POLYMOCK_ADMIN_TOKEN` | unset (no auth) | Admin token; when set, every `/__polymock` endpoint requires it (an empty string counts as unset) |
| `POLYMOCK_PROXY_ALLOW` | unset (no check) | Proxy target allowlist as a comma-separated host list (e.g. `localhost,127.0.0.1`) |

## Development & Testing

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Backend with hot reload (tsx watch) |
| `pnpm dev:web` | Frontend Vite dev server (HMR; the `/__polymock` proxy follows the main port automatically, same resolution rule as the backend) |
| `pnpm build` | tsc compiles the backend to `dist/` + vite builds the frontend to `public/` |
| `pnpm build:web` | Build the frontend only |
| `pnpm start` | Run `dist/index.js` (requires `pnpm build` first) |
| `pnpm typecheck` | Backend type check (app + tests) |
| `pnpm typecheck:web` | Frontend type check (vue-tsc) |
| `pnpm test` | Run all tests (Vitest) |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm smoke` | End-to-end smoke test against the build output (requires `pnpm build` first) |
| `pnpm test:e2e` | Playwright browser E2E (requires `pnpm build`; starts the server automatically) |

Test coverage by area:

- **Backend** (`src/**/*.test.ts`): unit tests for registry / store / template plus integration tests over real HTTP (`fetch` + ephemeral ports) — Express internals are never mocked; includes security cases for the admin token and proxy allowlist
- **Frontend** (`web/src/*.test.ts`): pure-function unit tests (OpenAPI parsing, snippet generation, condition table conversion, sequence draft parsing, Java entity generation)
- **smoke** (`scripts/smoke.mjs`): spawns `dist/index.js` on a random free port with a temp config file, then asserts the default route, templates and delay, 404 after disable, forced scene set, and the request log — any failure exits non-zero
- **E2E** (`e2e/*.spec.ts`): Playwright drives a real Chromium to cover the console loading, drawer-based register/call/delete, path-param templates, and the request log view (`pnpm test:e2e`)

## CI

The repository uses GitHub Actions (`.github/workflows/ci.yml`): on every push (to `main` and `feat/**` branches) and on all pull requests it runs `pnpm typecheck`, `pnpm typecheck:web`, `pnpm test`, and `pnpm build`. It uses Node 22, reads the pnpm version from the `packageManager` field in `package.json`, and installs with `--frozen-lockfile`.

## License

MIT (see the `license` field in `package.json`)
