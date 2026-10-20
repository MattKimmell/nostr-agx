# @nostr-agx/n8n-nodes-agx-gateway

n8n community nodes for **NIP-AGX**, agent-to-agent task exchange over Nostr, through an
[`agx gateway`](../cli#behind-an-http-api-agx-gateway). With them an n8n workflow can:

- **request a task** from another organization's agent and use its result;
- **send it a message**, or read its **Agent Card** before deciding whether to;
- **be an agent**: answer other agents' tasks with a workflow, and react to their messages.

The gateway is the agent. It holds the Nostr secret key, talks to relays, encrypts and decrypts,
and enforces who may reach which workflow. These nodes only make HTTPS calls to it and receive its
signed webhooks. That is the difference from
[`@nostr-agx/n8n-nodes-agx`](../n8n-nodes-agx), which runs the protocol inside n8n:

| | `n8n-nodes-agx-gateway` (this package) | `n8n-nodes-agx` |
| --- | --- | --- |
| Where the agent runs | `agx gateway`, which you run | inside n8n |
| What n8n stores | the gateway's URL and an API key you can revoke | the agent's secret key |
| Runtime dependencies | none: `n8n-workflow` and Node's `crypto` | the AGX protocol libraries, bundled |
| n8n Cloud | built to n8n's requirements for verified nodes | self-hosted n8n only |
| Inbound tasks | pushed by the gateway to a webhook | polled from relays by the trigger |

| Node | Use it to |
| --- | --- |
| **AGX Gateway** | Request a task, send a message, read an agent's card, or show the gateway agent's own identity. Usable as an AI Agent tool. |
| **AGX Gateway Trigger** | Start a workflow when an allowed agent sends the gateway's agent a task request, a message or a delivery receipt. For a task, what the workflow outputs is sent back as the result. |

```
 n8n ──HTTPS + API key──▶ agx gateway ──NIP-44/NIP-59 over relays──▶ other agents
 n8n ◀──signed webhook─── agx gateway ◀────────────────────────────── other agents
```

Looking for agents to talk to? [Elladex](https://www.ellavox.ai/elladex) is a public NIP-AGX agent
directory run by Ellavox AI.

## Run the gateway

On a machine you control, with the [`agx` CLI](../cli):

```sh
agx identity new                                   # the agent's key; stays on this machine
agx config set relays wss://relay.example.com      # the relays it reads and publishes to
agx gateway key new --label n8n                    # an API key for n8n; shown once
agx gateway                                        # http://127.0.0.1:8787
```

The gateway listens on `127.0.0.1` by default. For n8n Cloud, or any n8n on another machine,
publish it at an `https://` URL through a reverse proxy or a tunnel, for instance with Caddy:

```
agx.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

The gateway must also be able to reach n8n's webhook URLs, which on n8n Cloud it can. More on the
gateway — keys, subscriptions, what it keeps on disk — is in the
[CLI's README](../cli#behind-an-http-api-agx-gateway).

## Install

On **self-hosted n8n**: **Settings → Community Nodes → Install**, and enter
`@nostr-agx/n8n-nodes-agx-gateway`. Or, in n8n's user folder (`~/.n8n` by default), then restart
n8n:

```sh
mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes
npm install @nostr-agx/n8n-nodes-agx-gateway
```

On **n8n Cloud**, only community nodes n8n has verified can be installed, from the nodes panel.
This package is built to n8n's verification requirements — no runtime dependencies, n8n's
community-package scanner passes, published with npm provenance — so it can be submitted for
verification; until n8n verifies it, it installs on self-hosted n8n only.

## Credentials

Both nodes use an **AGX Gateway API** credential:

| Field | |
| --- | --- |
| Gateway URL | Where `agx gateway` is published, such as `https://agx.example.com`. |
| API Key | A key from `agx gateway key new`, run where the gateway runs: `agxg_…`. |

**Test** in the credential dialog calls the gateway with the key. A key can be revoked with
`agx gateway key revoke <id>` without changing the agent's identity; a running gateway refuses it
at once.

An agent is addressed by its public key: **AGX Gateway → Agent → Get Own Identity** shows the
gateway agent's `npub`, to give to the agents you work with.

## AGX Gateway

### Task → Request

Asks an agent to run one of its capabilities and waits for the result.

| Parameter | |
| --- | --- |
| Agent | The other agent's `npub1…` or hex public key. |
| Capability | The capability to run, such as `invoice.review`. |
| Payload | JSON the agent's handler receives. |
| Timeout (Seconds) | How long to wait for the result, from 1 second to an hour. Default 30. |
| Check Agent Card First | Read the agent's card first, and fail at once if it does not advertise the capability. |

Output: `{ peer, capability, status: "completed", output }`, where `output` is whatever the agent
returned. All items are requested at once, so ten items cost one wait, not ten.

If the agent reports a failure, the node fails with its message. That message is `handler failed`
unless the other side chose to share more: AGX keeps an agent's internal errors on its own side.

**A timeout usually means you are not allowed.** AGX authorization is deny-by-default, and a denied
request gets no reply at all — an error reply would confirm to a stranger that the agent exists and
what it can do. So first check that the agent has allowed the gateway agent's public key, then that
it is running, serves the capability, and shares a relay with the gateway.

### Message → Send

Sends an end-to-end encrypted message. Options: **Subject**, **Conversation ID** (the `contextId`
of the message being answered; empty starts a new conversation) and the automated-reply limits
below.

Output: `{ to, eventId, contextId, autoDepth, relaysAccepted, relaysTotal, deliveredToPeer, rejected }`.
`deliveredToPeer` is `true` when a relay the recipient advertises accepted the message, and `null`
when the recipient advertises none, so it is unknown.

#### Automated replies and loop protection

Two agents that answer each other automatically can loop forever, and every message in the loop is
valid. NIP-AGX bounds this with `autoDepth`, the number of consecutive automated replies behind a
message. When a workflow replies on its own to a message from the AGX Gateway Trigger, set
**Automated Reply Depth** to the trigger's `replyAutoDepth` field (the inbound depth plus one).
Leave it at 0 for a message a person wrote or approved: that starts the count over.

The gateway refuses an automated reply (depth above 0) before it is published when its depth is
over **Max Automated Reply Depth** (8), when its conversation already had **Max Automated Replies
per Conversation** (20), or when the agent already had **Max Automated Replies per Agent per Hour**
(60). If you set Automated Reply Depth to an expression, the node fails rather than sending when
the expression comes out empty.

The protection is opt-in — a Trigger → Send workflow that leaves the depth at 0 declares every
reply human — and its counts live in the gateway's memory. They cover every workflow that sends
through the gateway, and start over when it restarts. The depth ceiling holds everywhere, because
the depth travels with the message.

### Agent → Get Card

Reads the Agent Card an agent publishes: `{ npub, pubkey, found, org, capabilities, nip05,
nip05Verified, relays }`. Set **Capability to Check** to add `supportsCapability`, which honors
wildcards (`invoice.*`). **Verify NIP-05** (on by default) checks the claimed domain identity
against that domain: `nip05Verified` is `true` when the domain maps the name to this agent's key,
`false` when it maps it to another key or the claim is malformed, and `null` when there is no
claim, verification is off, or the domain could not confirm it. A card says who holds the key and
what the agent claims to do; it does not vouch for the quality of its work.

### Agent → Get Own Identity

Returns the gateway agent's `npub`, hex `pubkey`, relays, organization and NIP-05 address, and the
gateway's version.

### As an AI Agent tool

The AGX Gateway node is marked usable as a tool, so an n8n AI Agent can request tasks from other
agents. On self-hosted n8n, a community node needs `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`.

## AGX Gateway Trigger

Makes the workflow answer for the gateway's agent. Choose the **Events** to listen for:

| Event | Starts the workflow when | Output fields |
| --- | --- | --- |
| Task Request | an allowed agent asks the gateway's agent to run a capability listed under **Capabilities**, by exact name (`invoice.review`, not `invoice.*`) | `event: "task"`, `taskId`, `capability`, `payload`, `from`, `fromPubkey`, `contextId`, `sentAt` |
| Message | an allowed agent sends a plain message | `event: "message"`, `from`, `fromPubkey`, `allowed`, `text`, `subject`, `contextId`, `messageId`, `eventId`, `contentType`, `autoDepth`, `replyAutoDepth`, `sentAt` |
| Delivery Receipt | an allowed agent confirms it received a message the gateway's agent sent | `event: "receipt"`, `from`, `fromPubkey`, `allowed`, `status`, `refEventId`, `contextId`, `eventId`, `sentAt` |

`from` is the sender's `npub`, ready to use as the **Agent** of an AGX Gateway node that answers
it.

Turning the workflow on subscribes the trigger's webhook on the gateway, with the node's settings;
turning it off removes the subscription, and saving changed settings replaces it.

### Who may reach the workflow

List the agents under **Allowed Agents** (`npub1…` or hex, separated by commas or new lines). The
gateway enforces the list: nobody else can run the workflow's capabilities, their requests get no
reply — not even a delivery receipt — and nothing of theirs reaches n8n. A trigger nobody could
reach is refused when the workflow is turned on.

**Accept All Agents** opens the capabilities to anyone who can reach the agent. Turn it on only
for something meant to be public. **Include Messages and Receipts From Unlisted Agents** lets
anyone's messages and receipts start the workflow, marked `allowed: false`, without opening the
capabilities.

### The task result

The task result is what the workflow's last node outputs, as with the Webhook node's "When Last
Node Finishes": the JSON of its **First Item** (default) or of **All Items** as an array. Binary
data is not sent.

- **Failure.** If the execution fails, the requester gets `handler failed`. n8n answers a failed
  execution's webhook without its error, so the error stays in n8n's execution log.
- **Result Timeout (Seconds)** (120): a workflow still running then fails the task with "the
  workflow did not finish in time". Keep it below the requesters' own timeouts where you can — the
  AGX nodes and the CLI wait 30 seconds by default.
- **One task at a time.** The gateway answers tasks in order, so a slow workflow holds up the next
  one, and new messages wait behind it too. A message or receipt does not wait for its own
  workflow to finish, and its delivery is retried three times, over about 40 seconds, when n8n
  cannot be reached.
- **Ignore Tasks Older Than (Minutes)** (10): a request sent longer ago than this is ignored, with
  no reply; its requester has almost certainly stopped waiting.
- **Advertise Agent Card**: the gateway lists the capabilities on its agent's public card, for
  agents that look them up.

### Signed deliveries

Every delivery is signed with a secret the gateway made for this subscription, which the trigger
keeps in the workflow's static data. A request to the webhook URL that the gateway did not sign,
that was changed on the way, or that was signed more than five minutes earlier is answered `401`
and starts nothing.

### Test runs and restarts

**Listen for test event** subscribes n8n's test URL for as long as n8n listens. While it does, the
gateway hands a matching task to the test run, and to the active workflow once the test run has
ended; a message or receipt goes to both. The gateway keeps its subscriptions on disk and its place in the inbox, so a restart of
either n8n or the gateway neither loses the subscription nor runs a task twice.

## Try it with the `agx` CLI

A local relay and a CLI agent on the other side are enough to see both nodes work, with n8n and the
gateway on the same machine:

```sh
agx relay                                                 # terminal 1: ws://127.0.0.1:7447
agx identity new                                          # terminal 2: the gateway's agent
agx config set relays ws://127.0.0.1:7447
agx gateway key new --label n8n
agx gateway
agx identity new --profile requester                      # terminal 3: another agent
agx config set relays ws://127.0.0.1:7447 --profile requester
```

Create an AGX Gateway API credential in n8n with URL `http://127.0.0.1:8787` and the key.

**n8n asks a CLI agent.** Run `agx serve --profile requester --allow <gateway npub>`. In n8n, an
AGX Gateway node with Task → Request, Agent = the requester's `npub`, Capability `invoice.review`,
Payload `{"amount": 4200}` returns `{ "approved": true, … }` from the CLI's demonstration handler.

**A CLI agent asks n8n.** Stop that `serve`. Make a workflow: AGX Gateway Trigger (Task Request,
Capabilities `invoice.review`, Allowed Agents = the requester's `npub`) → Edit Fields setting
`approved` to `{{ $json.payload.amount < 10000 }}`. Activate it (or click **Listen for test
event**), then:

```sh
agx request <gateway npub> invoice.review --payload '{"amount":4200}' --profile requester
```

The CLI prints the workflow's output. Ask from another profile that is not allowed, and the
request times out with no reply.

## Development

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @nostr-agx/n8n-nodes-agx-gateway build
pnpm --filter @nostr-agx/n8n-nodes-agx-gateway test
```

The build is plain `tsc` to CommonJS plus the icons and codex files; nothing is bundled. The tests
run both nodes against a real `agx gateway`, from the CLI's source, on the CLI's in-process relay,
with real AGX agents on the other side and n8n's execute, hook and webhook contexts stubbed. To
load the nodes into a local n8n without publishing, copy `dist/` into `~/.n8n/custom/` and restart
n8n.

## License

MIT. The NIP-AGX specification is CC BY 4.0.
