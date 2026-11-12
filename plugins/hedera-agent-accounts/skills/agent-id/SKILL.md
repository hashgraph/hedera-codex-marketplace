---
name: agent-id
description: Manage this AI agent's identity and sign with it, using the local agent-credential-mcp server. Use when the user wants to create, show, rename or remove the agent's id/key, or to get the Agent ID to paste into the Client App. Also the signing step request-payment and x402-payment call to list the local public keys and sign EIP-712 payloads. Never prints the private key.
---

# agent-id

The agent's identity: an **ECDSA (secp256k1)** keypair held by the local
**`agent-credential-mcp`** server, bundled in the `hedera-agent-accounts` plugin
(Claude Code, Claude Desktop, Devin CLI, Codex - Devin CLI runs it the same way as
Claude Code). No CLI install, no on-chain account; the private key stays encrypted on this machine.

The identity **is** the compressed secp256k1 public key. `agent-credential-mcp` calls
it a DID (`did`), but there is no scheme prefix, nothing to fund and nothing to
resolve externally. Up to **30** identities can exist at once, one per agent the user
wants to tell apart. With more than one, every call that acts on a single identity
(sign, rename, remove, check storage) must pass its `did`; the tools refuse to guess.

To learn what an agent can and cannot do once configured, the payment MCP server
exposes `get_capabilities`.

Operations. **Create** is what a user asks for by default; **Public keys** and **Sign**
are what `request-payment` and `x402-payment` call.

## Create

### Step 1: intro + name (one question, then no more)

Print this message and ask for the name:

> An AI agent needs its own keypair to sign payments: the public key authorizes
> it in an agent account, the private key signs each payment. I'll create it
> with the local `agent-credential-mcp` server, which stores the key encrypted
> at rest on this machine - no CLI install, no on-chain account.
>
> What should I call this agent? A name you will recognise later, like
> `AliceBookingAgent` or `GroceriesBot`.

The name is what the user sees; one owner can have several agent accounts, each
with its own agent, so an unnamed identity is one the user cannot tell apart
later. Hold it as `<Name>`.

### Step 2: check the existing identities

Call `list-agent-keys` (no arguments).

- **Empty list** - proceed straight to Step 3.
- **An identity already has `<Name>` as its label** (matched case-insensitively) -
  **stop and ask** before generating anything. Print its `did`, then ask:

  > An agent called `<Name>` already exists. Use that one, or create a second agent
  > with a different name?

  **Use it** - print its `did` as in *Output* and stop. **A second agent** - ask for a
  different name, then continue to Step 3.
- **30 identities exist** - the limit is reached and `create-agent-did` will refuse.
  List them (`label` and `did`) and offer to remove one (*Remove*, which asks for its
  own confirmation). Continue to Step 3 only after one was removed.
- **Otherwise** - other agents exist under other names. Create the new one next to
  them without asking; Step 3.

### Step 3: create

The `label` is the name from Step 1, stored verbatim. It exists to tell the user which
agent this is later; it does not affect signing or authorization.

Call `create-agent-did({ label: <Name> })`. The response is the new record:
`{ did, label, keyManager, createdAt, keyStorage }` (plus a `notice` when the
encryption key had to go in a file). `did` is the real compressed
ECDSA public key (`02`/`03` + 64 hex, `0x`-prefixed) - no padding, no derivation.
That is the `agentPubKey`. The derived EVM address is never returned; do not compute it.

Since Step 2 already checked, this call should succeed. If it still fails with a
"maximum of 30 agent identities" error (e.g. another process created one meanwhile),
surface that error message verbatim - do not retry or work around it.

If it fails because the OS keystore refused or did not answer (the user denied
the Keychain / keyring prompt, or never answered it), relay the message in plain
language and stop. Nothing was created. Offer to try again once they allow
access, or, if they prefer to skip the OS keystore, to set
`AGENT_CREDENTIAL_KEY_STORE=file` (they set it themselves; you cannot). Do not
retry in a loop and do not run shell or keychain commands.

### Output (markdown only, never the private key)

**Always show the id after creating one.** The whole point of this operation is
handing the user the public key to paste elsewhere - never end the turn after a
successful `create-agent-did` call without printing it, e.g.
`0x03e06ebc2748bbd46e50a92b20a30b51d853eb612eb248e0b4b85fb6f2c135e9af`.

Start your reply with the `Created **<Name>**` line, nothing before it, no progress
narration. Output exactly this, then stop (do not register the config or submit
on-chain):

```markdown
Created **<Name>** - the keypair this AI agent uses to sign payment requests to
the Hedera Agentic Payment service. Generated via the local
`agent-credential-mcp` server (label `<label>`). The private key stays encrypted
on this machine, never printed; its encryption key is kept in `<keyStorage>`.
Here is the Agent ID you'll register.

**Agent ID** - paste this into the Client App:

`<did>`

### Next step - authorize the agent on an agent account

Open the Client App at **https://agent-accounts.haw.blockydevs.dev**. Either create a new agent account
(**New agent account**, name it after the job - "Flights", "Groceries") or open an
existing one you want this agent to spend from. Paste the value above into the
**Agent ID** field (raw or DER-encoded ECDSA is accepted), then:

- **add funds** from your own wallet - the funds stay in your
  account; you approve how much the agent account may spend on your behalf, and
- **set the agent account's spending limits** - the approved recipients plus the
  per-transaction and per-day limits it must stay within.

That's what authorizes the agent to send payments from that agent account; no separate
Hedera account is created for it. The same key may be authorized on several
agent accounts, each with its own budget - `request-payment` asks which to use
when more than one qualifies.

Inspect the identity any time by asking me to show the agent id. To check where the
key is protected, ask me.

### Optional - enable web browsing

Want your agent to browse the web to find and buy things for you? Run
the `enable-web-browsing` skill to set up browser automation on a CLI agent (Playwright MCP
or Browser Use MCP). Claude Desktop and ChatGPT / Codex desktop already have browsing built in. Once set up, the agent can
navigate to an item, reach the invoice, and then hand off to the `request-payment` skill
to pay with Hedera HBAR or USDC.
```

## Show

Call `list-agent-keys` and print each record's `did` (the public key) and `label`.
Never print the `address`: it is a derived EVM address that the Client App does not
use, and showing it invites pasting the wrong value. An empty list means no identity
exists yet; offer *Create*.

## Rename

Call `list-agent-keys`. With one identity, call `rename-agent-key({ newLabel: <Name> })`.
With several, ask which one to rename (by `label`, showing each `did`) unless the user
already named it, then call `rename-agent-key({ did: <did>, newLabel: <Name> })`. The
label is cosmetic; the public key does not change.

## Remove

**You can delete the agent ID yourself** with the `remove-agent-key` tool. Never say
you cannot delete it, that deletion is unsupported, or that the user must run it. Use
this flow whenever the user asks to delete, remove or reset the agent ID, during
*Create* or on its own:

1. Call `list-agent-keys`. If empty, say there is nothing to delete and stop. If
   several exist and the user did not say which, ask which one (by `label`, showing
   each `did`).
2. **Ask for confirmation**, naming the `label` and `did`: deletion is permanent, the
   private key cannot be recovered, and any agent account authorizing that key stops
   working for this agent until a new key is registered.
3. **Once the user confirms, call `remove-agent-key({ did: <did> })`** with the
   confirmed identity's `did`. Do not ask again and do not hand the step back to the user.
4. Report the tool's result. If the user wanted a replacement, continue to *Create*
   Step 3; otherwise stop.

If `remove-agent-key` fails because the OS keystore could not delete the
encryption key (a timeout, an unanswered prompt, a locked keyring), nothing was
removed: tell the user, and offer to retry once they have answered the prompt.
Only if retrying keeps failing, and the user agrees to leave the encryption key
behind in their OS keystore, call `remove-agent-key` again with `force: true`.
It removes the identity anyway and says which keystore item is left, so relay
that to the user, who can delete it by hand. Never use `force` on the first try.

Never remove a key without that confirmation, or as a side effect of another operation.

## Where is my key stored?

When the user asks where the agent key is kept, how safe it is, or whether the Keychain /
keystore setup worked, call `check-key-storage` (no arguments while at most one identity
exists; with several, once per `did` from `list-agent-keys`, or only for the one the user asked
about) and tell them its `summary` in plain language. It actually tests the stored key, so
rely on it rather than on `keyManager` from `list-agent-keys`. If it says the key is in a file rather than the OS keystore, say so plainly and
relay any suggestion it makes. Do not run shell or keychain commands for this.

## Public keys (called by other skills)

Call `list-agent-keys`. Return every record's `did` (`[<did>, …]`) for
`resolve_agent_context(agent_pub_keys=…)`; the context's `matchedInput` then says which
one to sign with.
An empty list means abort: tell the user no agent identity exists and offer *Create*.

## Sign (called by other skills)

Input: `domain`, `types`, `message` (from `build_intent` or `build_x402_payment`,
unmodified) and `publicKey` (the chosen context's `matchedInput`).

Call `sign-eip712-payload({ did: <publicKey>, domain, types, message })`. On success
the response text is JSON `{ did, signature }`; return `signature`. On
failure the response is `isError: true` with a text error starting `Error:` - abort
and surface it verbatim. Never edit the payload to make signing succeed.

## Boundaries

- **`agent-credential-mcp` tools only** (`create-agent-did`, `list-agent-keys`,
  `check-key-storage`, `rename-agent-key`, `remove-agent-key`, `sign-eip712-payload`). No Bash, no `hcli`,
  no other MCP calls, no web fetch, no file reads, no `git`. If a needed tool is
  unavailable, abort and tell the user rather than improvising.
- Never print or export the private key; output the public key (`did`) only.
- Never print or pass the derived `address` anywhere: identities are referenced by
  their public key.
