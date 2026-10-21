# Running `agx gateway` in production

`agx gateway` puts one NIP-AGX agent behind an HTTP API, for n8n Cloud (through
[`@nostr-agx/n8n-nodes-agx-gateway`](../../packages/n8n-nodes-agx-gateway)) and other tools that
make HTTP calls. What it does is described in the [CLI's README](../../packages/cli#behind-an-http-api-agx-gateway);
this is how to run it for real.

Here:

| File | |
| --- | --- |
| `Dockerfile` | The published CLI on `node:22-alpine`, run as the unprivileged `node` user, with the profile on a `/data` volume and a health check. |
| `compose.yaml` | The gateway behind [Caddy](https://caddyserver.com), which obtains and renews its TLS certificate. Only Caddy is reachable from outside. |
| `Caddyfile` | HTTPS for `AGX_DOMAIN`, proxied to the gateway with no timeout: a task request may wait an hour. |

## First run

You need a host with Docker, a domain name whose DNS points at it, and ports 80 and 443 open (Caddy
answers the certificate challenge on them).

```sh
cd deploy/gateway
cat > .env <<'EOF'
AGX_DOMAIN=agx.example.com
AGX_RELAY=wss://relay.example.com,wss://relay2.example.com
EOF

docker compose build
docker compose run --rm gateway identity new            # the agent's key, kept on the volume
docker compose run --rm gateway gateway key new --label n8n   # an API key for n8n, shown once
docker compose up -d
curl https://agx.example.com/v1/health
```

To keep an existing agent instead of making a new one, import its key in place of
`identity new`: `docker compose run --rm -T gateway identity import --stdin < nsec.txt`. The key
never needs to leave the host it runs on; `agx identity export` exists for backups, not for setup.

In n8n, create an **AGX Gateway API** credential with URL `https://agx.example.com` and the API
key; its **Test** button calls the gateway. `docker compose run --rm gateway identity show` prints
the agent's `npub`, to give to the agents you work with.

## Operating it

**Health.** `GET /v1/health` needs no key, and answers `200` while the gateway's poll of its relays
keeps finishing, `503` before the first one and once none has for a minute (or ten poll
intervals). The container's health check uses it, and so can an uptime monitor.
`allRelaysAnswering: false` means some relay did not answer the last polls: the others still
carry traffic, but check `AGX_RELAY`.

**Logs.** One line per thing the gateway did, on stdout: `TASK`, `SUB`/`UNSUB`, `CARD`, `SKIP`,
`LATE`, `DROP` (a message or receipt that could not be delivered after its retries), and `POLL`
when a relay has not answered for ten minutes (repeated hourly while it stays down: the inbox
position waits for it, so fix or remove it).
`docker compose logs -f gateway`. Payloads are never logged.

**Backups.** The `agx-data` volume holds the agent's secret key (`profiles/default/identity.json`):
anyone who has it can act as the agent, and losing it loses the agent's identity, which other
agents allowlist. Back it up, encrypted, and keep it private. The volume also holds the API key
hashes, the webhook subscriptions with their signing secrets, and the inbox state, all of which
can be recreated.

**API keys.** Make a new key, put it in the n8n credential, then revoke the old one; a running
gateway refuses a revoked key at once:

```sh
docker compose run --rm gateway gateway key new --label n8n-rotated
docker compose run --rm gateway gateway key list
docker compose run --rm gateway gateway key revoke <old id>
```

`AGX_GATEWAY_KEY` (32 characters or more) adds a key from the environment instead, for a platform
that injects secrets that way.

**Upgrades.** Set the new release in the Dockerfile's `AGX_PACKAGE` (and the image tag in
`compose.yaml`), then `docker compose build && docker compose up -d`. Subscriptions, keys and the
inbox position live on the volume and carry over. Stopping waits up to 8 seconds for running
tasks and saves its state first; a task cut off by the stop gets no result, and is not run again.

## Limits to know

- **Tasks run side by side:** up to 64 at once, at most 8 per webhook, each for up to the
  subscription's `resultTimeoutSec` (120 seconds unless the trigger sets another). A task that
  waits for its webhook past `maxTaskAgeSec` gets "the workflow was busy for too long".
- **At most once.** A task is recorded as handled before its webhook gets it: a crash in the
  middle costs the requester its result, never a second run.
- **Messages and receipts** go to each webhook two at a time, with 30 seconds for each answer,
  and are retried three times over about 40 seconds when it cannot be reached. Up to 500 wait per
  webhook; past that its oldest is dropped (`DROP`). The ones not delivered when the gateway stops
  are logged, and stay in `agx inbox`.
- **Through the API,** up to 256 task requests wait for results at once (more get `503`), and one
  whose caller disconnects stops waiting. A webhook's answer over 1 MiB is refused: the requester
  gets "result too large".
- **History:** the volume keeps the newest 20,000 messages for `agx threads`; older ones go.
- **One gateway per agent.** The profile is locked while the gateway runs; a second one, or
  `agx serve` on the same profile, refuses to start.
- **Request bodies** are limited to 1 MB.

## Without Docker

Any host with Node.js 20 or later works: `npm install -g @nostr-agx/cli`, then `agx identity new`,
`agx config set relays …`, `agx gateway key new`, and `agx gateway` under a process supervisor,
with a TLS proxy in front. A minimal systemd unit:

```ini
[Unit]
Description=agx gateway
Wants=network-online.target
After=network-online.target

[Service]
User=agx
Environment=AGX_HOME=/var/lib/agx
StateDirectory=agx
ExecStart=/usr/bin/env agx gateway
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
```

Run the setup commands as that user, with the same `AGX_HOME`:
`sudo -u agx env AGX_HOME=/var/lib/agx agx identity new`, and so on. The gateway listens on
`127.0.0.1:8787`; point the proxy there. It speaks plain HTTP, so never publish that port
directly.
