# PolyMock

English | [简体中文](./README.md)

> A local HTTP / WebSocket mock server: group services on independent ports or path prefixes, register routes at runtime, match requests by conditions, switch response scenarios on the fly, and script WS pushes — built for frontend local development and integration testing.

## Introduction

Backend APIs under active development often live on an intranet, forcing developers to switch networks back and forth between local work and live integration. PolyMock simulates those APIs locally: point your app at PolyMock during development, then switch the base URL back to the real backend when it is time to integrate — no code changes in between.

It is not a static fixture tool but a **local server whose routes are managed at runtime**:

- Register, edit, enable/disable HTTP and WS routes at any time via the web console or the admin API — no restarts
- Define multiple response scenarios (variants) per route, routed automatically by request conditions or switched globally with one click
- WS routes support on-connect pushes (onOpen), replies to incoming messages (echo / fixed / sequence), and interval pushes, with a visual debugging console
- Unmatched requests can pass through a proxy to the real backend, so mocks and live APIs blend seamlessly

Tech stack: Node.js 22.13+ / TypeScript / Express 5 (backend), Vue 3 + Vite (web console), Vitest (tests). Package manager: pnpm.

## Quick Start

Install from npm (the package ships the web UI inside, no build step needed on your machine):

```bash
npm i -g @wcsjun/polymock   # global install, then run:
polymock                    # then open http://localhost:33233
```

Or run it once without installing:

```bash
npx @wcsjun/polymock

# specify the config file path (also available via the POLYMOCK_CONFIG_FILE env var, see "Configuration File")
npx @wcsjun/polymock --config ./mock/polymock.config.json
```

Alternatively, run from source (useful for development):

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

Register a WS route (two on-open pushes, echo replies, a 5-second interval push):

```bash
curl -X POST http://localhost:33233/__polymock/routes \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "ws",
    "name": "Order status push",
    "path": "/ws/orders",
    "ws": {
      "onOpen": [
        { "body": { "type": "snapshot", "orderId": "{{query.orderId}}" } },
        { "delayMs": 2000, "body": { "type": "status", "status": "shipped" } }
      ],
      "onMessage": { "mode": "echo" },
      "interval": { "everyMs": 5000, "body": { "type": "tick", "ts": "{{$now}}" } }
    }
  }'

# Connect from any WS client: ws://localhost:33233/ws/orders?orderId=A1001
```

### Docker

The image ships with path mode enabled (`POLYMOCK_MODE=path`): every service is dispatched from the main port under a `/{basePath}` prefix, so a single port needs exposing. Configuration persists to the `/data` volume and survives restarts.

```bash
# Prebuilt images (built automatically by the release pipeline on every release, amd64/arm64):
docker run -d --name polymock -p 33233:33233 -v polymock-data:/data ghcr.io/wcsjun/polymock
# Or Docker Hub: docker run -d --name polymock -p 33233:33233 -v polymock-data:/data jun82315/polymock

# Local build:
docker build -t polymock . && docker run -d --name polymock -p 33233:33233 -v polymock-data:/data polymock
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
- **Web console**: drawer-style form for creating/editing routes, organised as five cards — Basics / Request admission / Response branches / Advanced options / Match preview; conditions are edited in Postman-style tables (the Body tab converts between table rows and JSON in both directions and offers three body-matching strategies)
- **Enable/disable routes**: a disabled route is treated as unregistered (and falls through to the proxy when configured)
- **Delete confirmation**: deleting a service or a route always asks for confirmation

### Request matching

- **Path matching**: exact paths plus `:param` segments (e.g. `/api/users/:id`); shape conflicts (including clashing parameter segments) are rejected with 409 at registration time
- **Condition dimensions**: three groups — query parameters, request headers (case-insensitive), and JSON body dot paths (e.g. `user.id`)
- **Comparison types**: `string` (default, stringified comparison) / `number` / `boolean` / `json` (deep equality) / `array` (containment — the actual array must contain every element of the expected JSON array, order-insensitive); without a `match` operator an empty expected value means "the key just needs to exist" (see the next bullet)
- **Required/optional**: conditions are required by default; with `required: false` a missing key passes (the value is only compared when present) — this also holds under an explicit `match` operator
- **Match operators (`match`, optional)**: `exists` = the key only needs to exist (an empty string counts as present and `value` is ignored) / `equals` = explicit equality (`value: ""` then means "equals the empty string"; the comparison still follows `type`) / `nonEmpty` = the key exists and is neither an empty string nor `null` / `regex` = `value` is a regular expression tested against the stringified actual value (an invalid pattern fails that condition, with "not a valid regex" in the reason). Omitting `match` keeps the historical semantics (`required` decides whether a missing key passes, an empty `value` means "must merely exist"), so existing configs need no migration
- **requireMatch gate (request admission)**: when enabled, every request must satisfy the route's `request` conditions, otherwise it is rejected with the route's `gateStatus` (default `400`; `404` hides the route, `422` is also allowed); `400` / `422` include the mismatch reason, while `404` answers with a body identical to an unregistered route (the route's existence and expected conditions stay hidden; the real reason is still kept in the request log) (takes precedence over any variant/branch, and applies to ordinary and CRUD routes alike; route-level auth still wins with 401)
- **Whole-body matching strategy (`bodyMatch` / `bodyRaw`, optional)**: `subset` (default) matches the `request.body` condition rows as dot-path subsets; `deepEqual` requires the request body to be deeply equal to the JSON parsed from `bodyRaw` (field order and whitespace do not matter, extra fields break the match); `textEqual` requires the raw request text to equal `bodyRaw` character by character (spaces, newlines and field order all matter). Under `deepEqual` / `textEqual` the `request.body` condition rows are ignored. Raw text comes from the body parser for JSON requests and from a separate read for non-JSON requests (the existing parsing/proxy behaviour is unchanged); a missing body or one above 10 MB fails that condition as "raw request body unavailable". `renderRequest` renders the parsed body, so `textEqual` compares against the client's original text
- **Request body template rendering (`renderRequest`)**: template placeholders in request-body strings (the same set as response templates, see "Dynamic response templates") are expanded **before condition matching**, and the expanded values feed the requireMatch / variant matches, the response template's `{{body.*}}`, and the request-log preview. A caller can therefore send `{"scene":"{{query.scene}}"}` and let the request parameters decide which scenario is hit, so one route definition serves many inputs; `{{body.other}}` reads the **original** request body (single pass, no cascading). **On by default** (a body without placeholders renders to the same value, i.e. it is a no-op); pass `false` explicitly to match the body as the client sent it. Placeholders with no resolvable value are kept verbatim, and `{{$id}}` shares the same route-level counter as the response template. It only applies to requests that match a registered route (unmatched requests are proxied upstream with the original request body)
- **Route-level auth**: configure `auth` to simulate backend authentication — requests without valid credentials are rejected with 401; supports `apikey` (secret in a custom header, default `X-API-Key`, header name configurable) and `bearer` (`Authorization: Bearer <token>`, with `WWW-Authenticate: Bearer` on 401); 401 takes precedence over the requireMatch gate and applies to CRUD routes too

### Response capabilities

- **Response variants (scenarios, shown as "response branches" in the console)**: attach multiple named variants to a route; they are matched in array order and the first one whose conditions all pass wins — otherwise the default response is used. The default response is the fallback branch and carries no conditions of its own: conditions that *every* request must satisfy belong in request admission (`requireMatch` / `request`)
- **Sequence responses**: cycle through a list of responses in hit order (e.g. "ok → ok → error"), taking precedence over the scene set, variants, and the default response
- **Global scene set**: once `activeVariant` is set, every route that has a variant with that name is forced onto it (its `match` conditions are bypassed) — one click switches the whole server
- **Dynamic response templates**: inside string values of the response body, use `{{query.x}}`, `{{header.x}}`, `{{body.x}}` (dot path), `{{params.x}}` (path parameters), `{{$id}}` (per-route auto increment), `{{$now}}` (ISO timestamp), `{{$int(a,b)}}` (random integer, inclusive), plus built-in fake data: `{{$name}}` `{{$ename}}` `{{$email}}` `{{$phone}}` `{{$city}}` `{{$word}}` `{{$bool}}`. Unresolvable placeholders are left as-is
- **Custom response headers**: the default response, every variant, and each sequence step can attach custom headers; values support template placeholders (e.g. `Location: /api/users/{{params.id}}`, `X-Request-Id: {{$id}}`); repeated names are sent as multi-value headers (e.g. multiple Set-Cookie); applied after the `contentType` field — a same-named Content-Type header overrides it; managed headers such as `content-length` / `transfer-encoding` are rejected at registration (400)
- **Delay / jitter / fault injection**: `delayMs` (0-60000 fixed delay) + `jitterMs` (random jitter cap), and `failureRate` (0-100%) to return 500 with some probability
- **Non-JSON text responses**: when the effective Content-Type (custom `Content-Type` header takes precedence over the `contentType` field) is non-JSON (e.g. `text/html`, `text/plain`, `application/xml`), the body is stored and sent verbatim as text — no JSON validation — with template placeholders still rendered (values injected as plain text); an unset or JSON Content-Type keeps the strict JSON validation. "Save as route" in the request log picks the mode automatically, so text upstream responses can be captured as mock routes directly
- **Formatting and instant validation**: one-click body formatting, on-blur JSON validation with inline error highlight in JSON mode (skipped when a non-JSON Content-Type is declared), and a second server-side validation on submit

Response resolution order: route-level auth (401) → request admission (`requireMatch`, failures answered with `gateStatus`, default 400) → sequence response → global scene set → conditional variants (response branches) → default response.

### Async callbacks (callback simulation)

- **Closed-loop callbacks**: after an HTTP route (default response / each variant) is hit and the response is sent, PolyMock fires one asynchronous HTTP callback to a configured target URL after the configured delay — the full "I call it, it calls me back" third-party async flow (payment notifications / order state machines / AI job completion) runs purely locally; `127.0.0.1` local handlers are the primary target
- **Snapshot template context**: the callback URL, headers, and payload are rendered from the **original request that triggered the hit** (snapshotted at hit time, same placeholders as response templates) — `{{body.orderNo}}` feeds the order number into the callback payload; callbacks never block the response path (fire-and-forget), and a hung target does not affect Mock latency
- **Callback templates (reusable across services)**: global templates own the envelope — URL / method / headers / delay / jitter / default payload; many routes reference one template, and editing it takes effect everywhere (the update response carries the affected branch count); each branch may override the payload via `bodyOverride` (precedence: variant override > route inheritance > template default). Admin endpoints `/__polymock/callbacks` CRUD: `GET` includes usages and outbound stats, deleting a referenced template fails with 409 listing the referencing branches
- **Outbound safety and loop protection**: outbound calls honor the `POLYMOCK_PROXY_ALLOW` allowlist (unset = no check; violations are logged); fixed 10s timeout, redirects not followed, failures only logged without retry; outbound calls carry `X-PolyMock-Callback-Depth` (when a callback targets PolyMock itself, an inbound depth ≥ 5 skips sending)
- **Outbound observability**: outbound callbacks are written to the request log (`direction: "out"`, with the rendered payload / peer status / failure reason / firing delay / source-request linkage) sharing the ring buffer and SSE stream; sequence / CRUD / WS routes do not support callbacks

### Stateful CRUD

Routes with `crud` enabled respond with resource semantics (in-memory only, reset on restart):

- **Collection routes** (no parameter segment): `GET` returns all resources, `POST` creates one (auto-generating an `rec-N` id when absent)
- **Item routes** (path contains an `:id` segment): `GET` fetches one (404 when missing), `PUT`/`PATCH` shallow-merges (keeping the original id), `DELETE` removes
- Only GET/POST/PUT/PATCH/DELETE are supported; other methods return 405
- **Per-service isolation**: the store key is `serviceId` + the path with parameter segments stripped — collection/item routes of the same shape within one service share one store, while identically shaped paths across services stay isolated
- **Store visibility**: `GET /__polymock/crud` inspects every service's collections with their records, `DELETE /__polymock/crud` (optionally `?serviceId=&collection=`) clears them; the web console exposes both on each CRUD collection group, along with one-click creation of the companion list/create/detail/update/delete routes

### WebSocket routes (protocol = "ws")

On top of HTTP mocking, PolyMock offers **protocol-native** WS mocking over the standard WebSocket upgrade handshake (no client library swap needed):

- **Registration**: send `protocol: "ws"` to the admin API (the method is auto-set to `WS`) with `name` / `path` required; behaviour lives in the `ws` sub-object. `WS /ws/orders` and `GET /ws/orders` can coexist (the method is part of the registry key), and WS cards live in the same service group as HTTP cards, sharing the same port
- **Handshake & admission**: matched and enabled → `101 Switching Protocols`; unknown / disabled path → `404` then close; failed auth (reusing `auth` Bearer / APIKey, credentials read from handshake headers; browsers cannot send custom handshake headers, so `?token=<value>` works as an equivalent credential) → `401` then close. Both failures **never reach** the HTTP mock dispatch and **never** hit the proxy
- **HTTP / WS isolation**: an HTTP request to a path registered as WS (including `:param` shapes) gets an explicit 404 (asking the client to connect over WebSocket) and is **never proxied**, so a configured WS mock cannot silently forward to the real backend; an HTTP route on the same path (e.g. `GET /ws/orders`) can be registered separately and coexists with the WS route
- **onOpen pushes**: an ordered message list (each entry = `delayMs` relative delay + `body`); `loopOnOpen` replays the whole sequence in a loop
- **onMessage replies**: `echo` (reply verbatim) / `fixed` (first of `replies`) / `sequence` (cycle through `replies` per incoming message) / `none`. Content-based conditional matching is intentionally out of scope for v1 (it would be a second matching engine)
- **Interval pushes**: `{ everyMs, body }` (100–60000 ms); timers are destroyed together with the connection on close or route change
- **Message templates**: string bodies are sent verbatim after template rendering (context = `query` + `header` + `params` + `$` helpers, no `body`); other values are JSON-serialised and deep-rendered
- **Change semantics**: editing / disabling / deleting a WS route closes its live connections with close code `1012` (Service Restart) so clients reconnect onto the new script; deleting a service destroys its connections immediately (`stop` has a timeout fallback and never hangs)
- **Logs & snapshots**: only **connection-level** logs are written (`method: "WS"`, `status` 101/401/404, with `ws.connectionId` / frame counters / `closeCode` recorded at close); frames are never persisted (so interval pushes cannot flush the HTTP request log). `GET /__polymock/ws/connections` returns a live connection snapshot, visualised in the console's "WS debug" view

### Debugging

- **Request log**: a 500-entry ring buffer recording method/path/query/body preview/status/duration, annotated with the matched route and variant (or the proxy pass-through and failure reason); outbound callback entries (`direction: "out"`) record the rendered payload / peer status / failure reason / firing delay / source-request linkage
- **Live updates**: new entries are pushed over SSE (`/__polymock/events`); when the connection is unavailable the panel automatically falls back to 2-second polling
- **Filter and replay**: filter by status class (2xx/4xx/5xx), service, or path keyword; GET entries can be replayed with one click, and any entry can be copied as curl
- **Save as route**: a proxied response body can be saved as a mock route in one click — capture once, mock forever; JSON upstreams are stored formatted, text upstreams keep their content type and verbatim body

### Proxy pass-through

- **Service-level `proxyTarget`**: configure a real backend on a service group and unmatched requests are forwarded to it (with `host` / `content-length` stripped)
- Upstream failures and non-whitelisted targets return 502; the upstream body (first 5000 characters) is recorded in the request log for "save as route"

### Import / export

- **OpenAPI 3 JSON import**: paste a document in the console; get/post/put/patch/delete operations under `paths` are imported with `$ref` resolution (JSON Pointer, depth limit 10), schema sampling for example responses (example/default first, first enum value, date/date-time as ISO strings, etc.), and `{id}` path segments converted to `:id`. Capped at 100 routes by default (truncation flagged); failures/skips are listed in the report
- **Snippet copying**: each route card can copy the mock URL, a curl command, a fetch snippet, and a Java entity class derived from the response JSON (Lombok `@Data` style, nested objects as static inner classes, arrays typed from the first element as `List<T>`)

### Security (optional)

- **Admin token**: when `POLYMOCK_ADMIN_TOKEN` is set, every `/__polymock` endpoint requires the `x-polymock-token` header (or `?token=` for SSE), otherwise 401; the web console's sidebar "Admin token" entry sets or clears it (stored only in this browser's localStorage under `polymock:token`), and 401 errors point to that entry
- **Proxy allowlist**: when `POLYMOCK_PROXY_ALLOW` is set (comma-separated host list), a proxy target's hostname must be on the list — enforced both when setting the target and before each forward

## Web Console

Open <http://localhost:33233> in a browser and switch between four views in the sidebar (your choice is remembered):

- **Routes**: service groups and route cards (HTTP and WS in the same group, content areas collapsed by default with truncated previews; CRUD routes grouped by collection); the create/edit drawer is organised as five cards — **Basics / Request admission / Response branches / Advanced options / Match preview** — and the WS drawer as five sections (Basics / Handshake & admission / onOpen / onMessage / interval)
- **WS debug**: visual debugging for WS routes — connection bar, live connection list, send box (JSON validation), frame timeline (frames stay in the current page)
- **Embed test**: load any page into a resizable iframe to verify it against the mocks without leaving the console
- **Request log**: log list with filters, live (SSE) / polling, replay, copy curl, clear, and "save as route" for proxied entries

For the full per-view walkthrough (card interactions, the five drawer sections, match-preview semantics, etc.), see [docs/ui-guide.md](docs/ui-guide.md) (Chinese).

## Admin API

All admin endpoints live under `/__polymock` on the main port and speak JSON. Success returns `{ "ok": true, ... }`; failure returns `{ "ok": false, "error": "reason" }`. Status code semantics: `400` invalid input or unmet conditions, `401` missing admin token, `404` unknown service/route (same for mock dispatch), `409` conflict (port/service name/route shape).

| Method | Path | Description |
| --- | --- | --- |
| GET | `/__polymock/meta` | Run-mode metadata: `{ mode, mainPort, stateVersion }` (`stateVersion` is a config-state counter incremented on every registry change, in-memory only and reset on restart; the web console uses it to skip re-fetching routes when nothing changed) |
| GET | `/__polymock/services` | List service groups (with `isDefault` / `running` / `basePath` / route count) |
| POST | `/__polymock/services` | Create a service group; port mode body `{ name, port }`, path mode body `{ name, basePath? }` (auto-generated when omitted) |
| DELETE | `/__polymock/services/:id` | Delete a service group (the default service cannot be deleted) |
| PUT | `/__polymock/services/:id/basePath` | Update a service's basePath prefix (path mode), body `{ basePath }` |
| PUT | `/__polymock/services/:id/proxy` | Set the proxy target, body `{ target }` (`null` or empty string clears it) |
| GET | `/__polymock/routes` | List routes; optional `?serviceId=` filter (includes WS routes, distinguished by `protocol`) |
| POST | `/__polymock/routes` | Register a route (requires `name` / `method` / `path`; path must start with `/`); with `protocol: "ws"` registers a WS route (method auto-set to `WS`, behaviour in the `ws` sub-object, HTTP-specific fields rejected with 400) |
| PUT | `/__polymock/routes/:id` | Update a route; supports patch semantics — send only the fields to change (WS routes accept `ws` updates; send `null` to clear; `protocol` cannot change) |
| DELETE | `/__polymock/routes` | Delete by `?method=&path=&serviceId=` (WS routes use `method=WS`) |
| GET | `/__polymock/requests` | Request log; optional `?serviceId=` and `?limit=` (default 100, max 500), newest first |
| DELETE | `/__polymock/requests` | Clear the request log |
| GET | `/__polymock/settings` | Read global settings (currently `activeVariant`) |
| PUT | `/__polymock/settings` | Update global settings, body `{ activeVariant }` (empty string clears it) |
| GET | `/__polymock/crud` | Inspect stateful CRUD collection stores: `{ collections: [{ serviceId, collection, count, records }] }` (in-memory, reset on restart) |
| DELETE | `/__polymock/crud` | Clear CRUD collection stores; optional `?serviceId=&collection=` filters (individually or combined), returns the number of cleared records as `cleared` |
| GET | `/__polymock/ws/connections` | Snapshot of live WS connections (read-only): `{ connections: [{ id, serviceId, routeId, path, remoteAddress, connectedAt, framesIn, framesOut }] }` |
| GET | `/__polymock/callbacks` | Callback templates (with usages and stats): `{ callbacks: [{ ...template, usage: [{ routeId, serviceId, method, path, branch }], stats: { ok, fail, lastFiredAt } }] }` (stats aggregated from the request-log ring buffer, not persisted separately) |
| POST | `/__polymock/callbacks` | Create a callback template (globally unique `name`, 409 on conflict): `{ name, url, method?, headers?, contentType?, body?, delayMs?, jitterMs? }` |
| PUT | `/__polymock/callbacks/:id` | Update a callback template; the response carries `affected` (referencing branch count, for edit warnings) |
| DELETE | `/__polymock/callbacks/:id` | Delete a callback template; 409 with `usage` when still referenced |
| GET | `/__polymock/events` | SSE stream of request logs (`event: log`, data is the entry JSON) |

> When `POLYMOCK_ADMIN_TOKEN` is set, all of the above require the `x-polymock-token` header or a `?token=` query parameter, otherwise 401.

> Admission-field validation when registering or updating a route: a non-enum `match` on a condition row or a non-enum `request.bodyMatch` returns 400; a `gateStatus` other than `400` / `404` / `422` returns 400; `bodyRaw` must be non-empty when `bodyMatch` is `deepEqual` / `textEqual` (and valid JSON for `deepEqual`), otherwise 400; under `bodyMatch: subset` a `bodyRaw` is ignored and never persisted. `PUT /__polymock/routes/:id` accepts `gateStatus` as a standalone patch field (sending `400` restores the default), and the 400 raised for an empty patch lists `gateStatus` among the updatable fields.

## Configuration File

Configuration is persisted to `polymock.config.json` and saved automatically on every registry change (atomic write: temp file + rename). The config file path is resolved with the following precedence:

1. `--config <path>` CLI argument (also supports `--config=<path>`)
2. `POLYMOCK_CONFIG_FILE` environment variable (the Docker image pins it to the `/data` volume this way)
3. An existing `polymock.config.json` in the current working directory (reused, keeping project-local configs compatible)
4. `~/.config/polymock/polymock.config.json` (fallback created on demand, avoiding polluting the working directory when run bare from the home directory)

> Explicit path tolerance: a path pointing to an existing directory (or ending with `\` / `/`) automatically uses `polymock.config.json` inside it; a file path must end with `.json`, otherwise startup exits with an error.

The `port` field of the `default` service is the main port (home of the web UI, admin API, and the default service). The current schema version is `2`:

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
      "request": {
        "headers": [{ "key": "X-Token", "value": "", "match": "exists", "required": false }],
        "query": [{ "key": "id", "value": "^\\d+$", "match": "regex" }]
      },
      "requireMatch": true,
      "gateStatus": 422,
      "variants": [
        { "id": "v-01", "name": "admin view", "match": { "headers": [{ "key": "X-Role", "value": "admin", "match": "equals" }] },
          "response": { "status": 200, "body": { "role": "admin" } } },
        { "id": "v-02", "name": "payment callback", "match": { "bodyMatch": "deepEqual", "bodyRaw": "{\"status\":\"PAID\"}" },
          "response": { "status": 200, "body": { "received": true } } }
      ],
      "sequence": [],
      "disabled": false,
      "delayMs": 200,
      "jitterMs": 100,
      "failureRate": 0,
      "crud": false,
      "renderRequest": true,
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
| `routes[].method` / `path` | HTTP method and path (WS routes fix the method to `WS`); paths support `:param` segments |
| `routes[].protocol` | Protocol: `http` (default) = HTTP mock; `ws` = WebSocket mock (behaviour in the `ws` field; HTTP fields like `response` are never stored) |
| `routes[].ws` | WS behaviour: `onOpen[]` (ordered `{ delayMs?, body }` pushes), `loopOnOpen` (replay the sequence), `onMessage` (`{ mode: echo/fixed/sequence/none, replies? }` reply policy), `interval` (`{ everyMs, body }` interval push, 100–60000 ms) |
| `routes[].response` | Default response: `status` / `contentType?` / `headers?` (custom response headers) / `body`; the body is strictly validated in JSON mode and stored verbatim as text when the effective Content-Type is non-JSON; optional `callback` (async callback, see above) |
| `routes[].request` / `requireMatch` / `gateStatus` | Request admission: expected request conditions, the admission switch, and the failure status (`gateStatus` defaults to `400`; `404` hides the route, `422` is also allowed). Condition rows accept a `match` operator (`exists` / `equals` / `nonEmpty` / `regex`; omitted keeps the historical semantics); the body can be matched as a whole via `bodyMatch` (`subset` default / `deepEqual` / `textEqual`) plus `bodyRaw` (the expected full JSON for `deepEqual`, the expected verbatim text for `textEqual`; ignored under `subset`) |
| `routes[].variants[]` | Response variants ("response branches" in the console): `name` / `match?` (omitted = always matches; the condition shape is the same as `request`) / `response` |
| `routes[].sequence[]` | Sequence responses: `{ status, body, headers? }` entries, returned cyclically |
| `routes[].disabled` / `delayMs` / `jitterMs` / `failureRate` / `crud` / `renderRequest` | Behavior switches and simulation parameters (`renderRequest` = render request-body templates; **on by default**, disabled only by an explicit `false`) |
| `settings.activeVariant` | Global scene set: when set, same-named variants are forced |
| `callbacks[]` | Global callback templates (reusable across services): `{ id, name, url, method?, headers?, contentType?, body?, delayMs?, jitterMs?, createdAt }`; routes reference them from `response.callback` via `{ template: <id>, bodyOverride? }` (the envelope is owned by the template, only the payload can be overridden) or inline full config (`{ url, method?, headers?, contentType?, body?, delayMs?, jitterMs? }`); sequence / CRUD / WS routes do not support callbacks. Purely additive field, no migration needed |

Older configuration files (missing `version` or `version: 1`) are migrated automatically on load — fields stay compatible, no manual action needed. Every field added for request admission (the `match` operator on condition rows, the route's `gateStatus`, and `bodyMatch` / `bodyRaw` on the request group) is optional, so existing configs need no migration and `version` stays `2`.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `POLYMOCK_MODE` | `port` | Run mode: `port` = independent ports per service; `path` = all services dispatched from the main port under `/{basePath}` prefixes (the Docker image defaults to `path`); see "Run modes" |
| `POLYMOCK_PORT` | `default` service `port` in the config file (`33233` out of the box) | Main port (home of the default service, web UI, and admin API); takes precedence over the config file and is written back to it when set explicitly |
| `POLYMOCK_HOST` | unset (listens on all interfaces) | Listen address; a startup warning is printed when bound to a non-loopback address without an admin token |
| `POLYMOCK_CONFIG_FILE` | unset (see the resolution order under "Configuration File") | Configuration file path; lower precedence than the `--config` CLI argument, higher than working-directory auto-detection |
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
- **E2E** (`e2e/*.spec.ts`): Playwright drives a real Chromium to cover the console loading, drawer-based register/call/delete, path-param templates, the request log view, and WS route creation plus debug-console connect/echo/disabled-handshake (`pnpm test:e2e`)

## CI

The repository uses GitHub Actions (`.github/workflows/ci.yml`): on every push (to `main` and `feat/**` branches) and on all pull requests it runs two jobs — `CI` (`pnpm typecheck`, `pnpm typecheck:web`, `pnpm test`, `pnpm build`) and `E2E` (installs the Playwright Chromium browser, builds, and runs `pnpm test:e2e`). It uses Node 22, reads the pnpm version from the `packageManager` field in `package.json`, and installs with `--frozen-lockfile`.

Releases run on a dedicated pipeline (`.github/workflows/release.yml`): pushing a `v*` tag automatically runs "tag/version consistency check → typecheck/test/build gate → npm publish (`@wcsjun/polymock`, with provenance) → multi-arch Docker image push (GHCR + Docker Hub, with `latest` and major.minor tags) → GitHub Release creation (notes extracted from `CHANGELOG.md`)". Before releasing, configure the repository secrets `NPM_TOKEN` (a Granular Access Token with **Bypass 2FA** enabled — classic/automation tokens are no longer issued), `DOCKERHUB_USERNAME`, and `DOCKERHUB_TOKEN`.

## Roadmap

- **WS proxy pass-through and record/replay**: capture real backend WebSocket traffic and replay it (v1 WS mocking already covers push scripts / replies / interval pushes)
- **WS content-based conditional matching**: would introduce a second matching engine; pending design review

## License

MIT (see [LICENSE](LICENSE))
