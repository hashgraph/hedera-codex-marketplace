---
name: request-payment
description: Send, request, or execute a payment (HBAR or HTS token) from an agent account. Resolves which of the owner's agent accounts this agent may debit via MCP resolve_agent_context, signs an EIP-712 Intent with the agent's ECDSA key through the agent-id skill (key stays in the local keystore), submits via MCP execute_transaction. The server validates agent authorization; never pre-check it locally. Never prints the private key.
---

# request-payment

Execute a payment from one of the owner's agent accounts: collect what the
payment is (recipient, asset, amount), resolve which agent accounts this agent's key
authorizes, pick one, build an `Intent` (next nonce), sign it with the `agent-id`
skill, submit via MCP `execute_transaction`, handle the result. Supports HBAR (`Intent.asset` = zero address) and any HTS token configured
in the chosen agent account's `assets`.

One owner has N agent accounts, each with its own agent key, allowlist and
budget. This skill never names an owner — it names an **agent account**, and the agent account
is only ever one the agent's own key already authorizes.

This skill never touches keys itself. Listing the local public keys and signing are
operations of the **`agent-id` skill**, which also owns key provisioning. It works the
same whichever signer backs `agent-id`.

Always use the `agent-id` **from this skill's own install**: the sibling `agent-id`
directory next to this skill. Invoked as `hedera-agent-accounts:request-payment` (the
plugin), call `hedera-agent-accounts:agent-id`; invoked un-prefixed, call the
un-prefixed `agent-id`. The plugin and the hcli skills can be installed side by side,
and the two signers hold different keys, so never mix them within one payment.

Requires the `agent-id` skill with a working signer, and a connected payment MCP
server exposing `resolve_agent_context` + `build_intent` + `execute_transaction` +
`resolve_address`.

## Inputs

Ask one question per missing field; skip any the user gave.

| Field         | What                                                                                                                                                                     | Default               |
|---------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------|
| `destination` | Recipient. EVM address (`0x…`) or `0.0.x` Hedera id, resolved via `resolve_address` in Step 1; never zero-padded manually.                                                  | ask                   |
| `asset`       | Which asset to send: HBAR or an HTS token. Accept a symbol (`HBAR`, `USDC`) or an asset EVM address; matched against the chosen agent account's `assets` in Step 2. HBAR = zero address. | `HBAR` (zero address) |
| `value`       | Amount in the asset's smallest unit (base-10 string): `human × 10^decimals`, decimals from the chosen asset. HBAR decimals = 8 (tinybars).                                  | ask                   |
| `account`     | **Optional hint** naming which agent account to debit: its nickname (matched case-insensitively) or its id. Only ever narrows the candidates the agent key already authorizes — it can never add one. | none (Step 2 selects) |
| `network`     | `testnet` / `mainnet` / `local-node`.                                                                                                                                      | `testnet`             |

| Network      | Mirror node base                               |
|--------------|------------------------------------------------|
| `local-node` | `http://localhost:5551`                        |
| `testnet`    | `https://testnet.mirrornode.hedera.com`        |
| `mainnet`    | `https://mainnet-public.mirrornode.hedera.com` |

## Step 1: collect the payment, resolve the recipient

Ask for whatever is missing of `destination`, `asset` and `value` **before**
resolving accounts. What the payment is does not depend on which agent account pays it,
and knowing the asset and amount is what lets Step 2 sieve the candidates.

**IMPORTANT: never construct EVM addresses from Hedera account ids.**
A `0.0.x` id cannot be converted to an EVM address by zero-padding or any
arithmetic. Always use `resolve_address`; it hits the Mirror Node and returns the
canonical `0x` address.

Fire both simultaneously in the same turn:

```
resolve_address(accounts = [destination])   # the recipient ONLY
agent-id: Public keys                       # the local public key(s)
```

`agent-id` returning no key aborts: the owner must provision an identity first
(the `agent-id` skill, *Create*).

`resolve_address` is for the recipient alone. The agent account being debited is never
resolved from an address — it comes from the contexts in Step 2, which is the only
thing that proves this agent may debit it.

## Step 2: resolve the agent accounts this key may debit, then choose one

```
resolve_agent_context(agent_pub_keys = [<every public key from agent-id>], state = true)
```

Each returned context is one agent account this agent may debit, carrying
`agentMandateId`, `nickname`, `sourceAccountId`, `assets[]`, `allowlist[]`,
`state.intentNonce` and `state.assetSpend[].spendable` (the live minimum of what is left of
today's amount, the funds the owner made available and the owner's balance).

`unresolved` entries are keys no agent account authorizes. If every key is unresolved,
abort: the owner has not authorized this agent yet (`agent-id`, then add the key to
an agent account in the Client App).

### 2a — narrow, never refuse

The candidates are already only agent accounts this key authorizes, so there is nothing
outside the set to pick by mistake. Narrow them in this order, and **stop at the
first step that leaves exactly one**:

1. The `account` hint, if the user gave one: keep the contexts whose `nickname`
   matches case-insensitively, or whose `agentMandateId` matches. No match →
   ask, listing every candidate; do not silently ignore the hint.
2. Assets: keep the contexts whose `assets[]` carries the chosen asset.
3. Allowlist: keep the contexts whose `allowlist[]` carries the resolved
   `destination`.
4. Spendable: keep the contexts whose `state.assetSpend[]` entry for that asset
   has `spendable >= value`.

Then:

- **Exactly one candidate** → use it without asking. The user already confirmed
  the recipient and the amount, and the set never contained an agent account this agent
  cannot debit.
- **Several** → ask which, **by nickname**, showing each one's `spendable` for the
  chosen asset.
- **None left** → ask anyway, listing every agent account the key authorizes and why
  each fell out ("Flights: no USDC policy", "Groceries: 4 USDC spendable, need
  10"). Do not abort on the sieve's agent account and do not pre-refuse the payment: the
  sieve is a selection heuristic, and the server is the only thing that refuses.

### 2b — recurring and scheduled runs never ask

When the payment is repeated or fired by a schedule (`/loop`, cron, a follow-up of an
earlier run in the same request), the human choice is made **once, on the first run**.
Later runs must not ask which agent account to use:

- Put the chosen agent account's nickname in the schedule's prompt as `account=<nickname>`,
  and apply it as the `account` hint on every later run.
- If that agent account still qualifies after the sieve, use it without asking, even when
  other agent accounts would also qualify.
- If it no longer qualifies (not authorized, no policy for the asset, destination not
  allowlisted, or `spendable < value`), **abort that run** and report why. Do not ask
  and do not switch to another agent account.

Do not promise the user a per-run reconfirmation; this skill does not do one.

Hold the chosen context's `agentMandateId`, its `matchedInput` (the public key that
authorizes it, which `agent-id` *Sign* needs), its `state.intentNonce` as
`currentIntentNonce`, and the matched asset's `address`, `decimals` and `symbol`.

Abort on failure, no retry:

- Transport / no response / tool missing: payment MCP server not connected; tell
  the user to (re)connect (`/mcp`) and re-run. Do not search other servers.

## Step 3: build + sign

Call `build_intent` to get the server-authoritative EIP-712 payload, then sign it
with the `agent-id` skill. The server derives the domain (`chainId`,
`verifyingContract`), the Intent type array **and the paying agent account's `source`**
from its own state — do not construct any of them manually.

```
PAYLOAD = build_intent(
  agent_mandate_id = <chosen context's agentMandateId>,
  destination        = <resolved destination>,
  asset              = <resolved asset address; 0x0000…0000 for HBAR>,
  value              = <value>,
  intent_nonce       = <currentIntentNonce + 1>
)
```

Run `agent-id` *Sign* with `domain = PAYLOAD.domain`, `types = PAYLOAD.types`,
`message = PAYLOAD.message`, `publicKey = <the chosen context's matchedInput>` and
`network`. The signature it returns is `agentSig`. If signing fails, abort and surface
the error verbatim.

## Step 4: submit (MCP)

Call `execute_transaction` with
`{ "intent": <PAYLOAD.message from build_intent>, "agentSig": "<agentSig>" }`.

The Intent names the agent account it debits, so no agent account argument is repeated
here.

Read the outcome:

- `isError` absent or false: success. Structured output is `{ txId, receipt }`.
- `isError === true`: failure. The text content is a formatted error line prefixed
  by `<CODE>:`. Amounts are already in display units, EVM addresses include
  their Hedera account id in parentheses. Read the leading `CODE` token and branch
  on it (Step 5).

## Step 5: handle result

On success (`isError` absent or false): the payment executed on-chain. Structured
output is `{ txId, receipt }` with `receipt.executed === true`. Report per Output
(`txId` + receipt link).

On failure (`isError === true`), the content text is a pre-formatted `"<CODE>: <message>"`.
Surface it verbatim, do not reformat amounts or addresses. Branch on `CODE` for
retry vs abort:

- `NONCE_MISMATCH` (intent nonce stale, per agent account): re-read the context and retry
  Steps 2-3 exactly once with a fresh nonce. A second failure aborts.
  **This is the only retry.**
- `ACCOUNT_DISABLED`: this agent account was stopped. Not retryable on it — but another of
  the owner's accounts may still pay, so re-run `resolve_agent_context` and offer
  the remaining candidates.
- `MASTER_NONCE_MISMATCH`: every account of this owner is stopped. Not retryable at
  all; tell the user only they can re-activate them.
- `OWNER_KEY_NOT_CURRENT`: the owner changed their Hedera account's key, so every
  agent account they signed before is invalid. Not retryable; tell the user they must
  save each agent account again in the Client App.
- All other codes: abort, print the server's error text to the user as-is.

## Output

One short human-readable message, nothing before it.

- Success: `Sent <amount> <symbol> to <destination> from <nickname>.` then
  `Receipt: https://hashscan.io/<network>/transaction/<txId>`
  (amount = `value` / `10^decimals`, `symbol` + `decimals` from the chosen asset;
  HBAR = `value` / 1e8 with symbol `HBAR`; `destination` as the user provided it or
  as resolved; `nickname` names which agent account paid, because the owner has several)
- Abort: print the server's error text line verbatim. It already contains amounts
  in display units and addresses annotated with their Hedera account ids.

## Boundaries

- Work silently: no step announcements, progress, plans, or internal values
  (nonce, account id, public key, signature). Speak mid-loop only to ask for a missing
  input, to ask which agent account, or to abort.
- Never print/export the private key; reference identities by public key or label only.
- Never pre-check policy (per-transaction and daily amounts, allowlist, funds); the server
  enforces all of them. The Step 2 sieve SELECTS between accounts — it never
  refuses a payment, and a sieve that leaves nothing asks rather than aborts.
- Never guess nonces beyond `currentIntentNonce + 1`.
- Never construct an EVM address from a `0.0.x` Hedera account id (e.g. by zero-padding). Always call `resolve_address` and use the returned `0x` value.
- One retry, only on a `NONCE_MISMATCH` (intent nonce) code; every other failure aborts.
- **The source is never inferred, because it is never chosen.** The paying account
  comes from `resolve_agent_context` — agent accounts this agent's key already
  authorizes — and the server derives `Intent.source` from the agent account. Do not read
  an owner address from the local keystore, `agent-id` output or any other local or
  session state, and never pass one to a tool.
- **Exclusive tool list:** only the payment MCP server tools (`get_capabilities`,
  `get_troubleshooting_guide`, `get_agent_mandate`, `build_intent`,
  `execute_transaction`, `resolve_address`, `resolve_agent_context`) and the
  `agent-id` skill **from this skill's own install** (with whatever tools it names) are
  in scope for this flow.
  Explicitly out of scope: `git`, web search, file reads, any other MCP server, any
  other skill.
  If a needed tool is missing from this list, abort and tell the user — do not improvise an
  alternative path.
- If the user asks about current limits, remaining budget, allowlist membership,
  or "why might this be blocked" outside an active payment, do not run scripts or
  comparisons. Call `resolve_agent_context` with `state: true` and answer in natural
  language per account, from each context's `assets`, `allowlist`,
  `state.intentNonce` and `state.assetSpend`. `state.assetSpend[]` carries
  `allowance`, `balance` and `spendable` — answer "how much can I actually send"
  from `spendable`, never from `dailyCap` alone. Name the agent account each answer is
  about: the owner has several, and they do not share a budget.
- If context is lost or a tool seems unavailable, call `get_capabilities` or
  `get_troubleshooting_guide` before searching the filesystem or fabricating endpoints.
