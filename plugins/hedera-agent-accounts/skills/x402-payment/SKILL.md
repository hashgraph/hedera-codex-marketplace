---
name: x402-payment
description: Pay an HTTP 402 Payment Required response from an agent account and get the resource. Reads the 402's payment requirements, builds the payment via MCP build_x402_payment, signs the EIP-712 Intent with the agent's ECDSA key through the agent-id skill (key stays in the local keystore), then hands the signed Intent to a bundled script that finalizes the payment and retries the request itself, so the PAYMENT-SIGNATURE header never has to pass through the conversation. The facilitator pays the gas. Never prints the private key.
---

# x402-payment

Resolve an HTTP **402 Payment Required** by paying from the owner's agent account:
read the quote, resolve the local signing identity, build the payment over MCP, sign
the `Intent` with the `agent-id` skill, hand it to a bundled script that
finalizes the payment and retries the request itself, interpret the outcome.

You never ABI-encode anything and never touch a Hedera SDK. The payment server does
both halves of the encoding; your only job is the signature, which is the one step
only you can do.

This skill never touches keys itself. Listing the local public keys and signing are
operations of the **`agent-id` skill**, which also owns key provisioning. It works the
same whichever signer backs `agent-id`.

Always use the `agent-id` **from this skill's own install**: the sibling `agent-id`
directory next to this skill. Invoked as `hedera-agent-accounts:x402-payment` (the
plugin), call `hedera-agent-accounts:agent-id`; invoked un-prefixed, call the
un-prefixed `agent-id`. The plugin and the hcli skills can be installed side by side,
and the two signers hold different keys, so never mix them within one payment.

Requires the `agent-id` skill with a working signer, Node.js (for the bundled retry
script), and a connected payment MCP server exposing `build_x402_payment`,
`get_agent_mandate`, `resolve_address` and `resolve_agent_context`. Finalizing the
payment is not an MCP tool: the bundled script does it with the payment server
directly.

For a payment you initiate yourself rather than one a 402 demands, use
`request-payment` instead.

## Inputs

Ask one question per missing field; skip any the user gave.

| Field               | What                                                                                                                                                                                                                                                                                                                                    | Default                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `resource_url`      | The URL that returned 402. Usually already known from the failed request.                                                                                                                                                                                                                                                              | from context                       |
| `account`           | **Optional hint** naming which agent account to debit: its nickname (matched case-insensitively) or its id. Only ever narrows the candidates the agent key already authorizes — it can never add one. | none (Step 1 selects) |
| `network`           | `testnet` / `mainnet` / `local-node`. | `testnet` |

Confirm the amount with the user before paying, unless they have already agreed to
this specific charge. The quote is in the asset's smallest unit; HBAR has 8 decimals
(tinybars), so divide by 1e8 to show it.

## Step 0: recognise the 402

A response is payable by this skill when **all** of these hold:

- HTTP status is `402`.
- The quote has an `accepts` array: x402 v2 publishes it in the base64 JSON
  `PAYMENT-REQUIRED` header, and many servers leave the body empty. Older servers
  put it in the body.
- At least one entry has `scheme: "exact"` and
  `extra.assetTransferMethod === "transferExecutor"`.
- The entry's `network` is `hedera:<network>` for the selected network, for example
  `hedera:testnet` when `network` is `testnet`.

You cannot base64-decode a header by hand reliably. When the 402 you already have shows
`accepts` in its body, read it there. Otherwise, or when you only have the status, probe
with the bundled script (same `SCRIPT` as Step 4), which re-sends the request as given and
decodes `PAYMENT-REQUIRED`, falling back to the body:

```bash
SKILL_DIR="${CLAUDE_SKILL_DIR:-<absolute directory this SKILL.md was loaded from>}"
SCRIPT="$SKILL_DIR/scripts/x402-retry.mjs"
[ -f "$SCRIPT" ] || { echo "x402-retry.mjs not found at $SCRIPT" >&2; exit 1; }
node "$SCRIPT" <<'EOF'
{ "probe": true, "request": { "url": "<resource_url>", "method": "GET" } }
EOF
```

It prints one JSON line: `{"ok":true,"stage":"probe","status":402,"source":"header"|"body","error":...,"accepts":[...]}`.
`ok:false` means the request did not answer with a quote (surface `status` and `body`).
A 3xx `status` is a redirect, which the script never follows: probe again at the https URL in
`headers.location`, and pay that URL.
A 402 means nothing was spent, so probing a non-idempotent request is safe. The same
rules as Step 4 apply to the placeholder and to a missing script.

Pick that entry and call it `REQUIREMENTS`. Pass it around **verbatim**: every field,
unmodified. It is what the merchant, the payment server and the facilitator all agree
the payment is for; changing any field invalidates the payment.

If no entry qualifies, abort: this merchant cannot be paid from an agent account.
Say so plainly and name what it offered instead. Do not fall back to another method.

If several entries qualify, prefer the cheapest, then ask if still ambiguous.

## Step 1: pick the agent account that pays

The 402 already says what the payment is — asset, payee and amount — so the only
thing left to choose is which of the owner's agent accounts pays it.

```
agent-id: Public keys                                             # the local public key(s)
resolve_agent_context(agent_pub_keys = [<every public key from agent-id>], state = true)
```

`agent-id` returning no key aborts: the owner must provision an identity first (the
`agent-id` skill, *Create*).

Each context is one agent account this agent may debit, carrying
`agentMandateId`, `nickname`, `assets[]`, `allowlist[]` and
`state.assetSpend[].spendable`. One key may be authorized on several agent accounts —
that is the feature — so several contexts can come back even though there is usually
one local identity. `unresolved` means no agent account authorizes this key; abort,
the owner has not authorized this agent yet (`agent-id`, then add the key
to an agent account in the Client App).

Narrow them, and **stop at the first step that leaves exactly one**:

1. The `account` hint, if given: nickname (case-insensitive) or id. No match → ask,
   listing every candidate.
2. Assets: the contexts whose `assets[]` carries `REQUIREMENTS.asset`.
3. Allowlist: the contexts whose `allowlist[]` carries the merchant's payee.
4. Spendable: the contexts whose `spendable` for that asset covers the quote.

Then: exactly one → use it without asking; several → ask **by nickname**, showing
each one's `spendable`; none left → ask anyway, listing every candidate and why
each fell out. The sieve selects between agent accounts — it never refuses the payment,
because the server is the only thing that refuses.

Hold the chosen context's `agentMandateId` for Step 2, its `matchedInput` (the public
key that authorizes it, which `agent-id` *Sign* needs for Step 3), and its matched
asset's `symbol` + `decimals` for Output.

## Step 2: build

```
PAYMENT = build_x402_payment(
  agent_mandate_id   = <chosen context's agentMandateId>,
  payment_requirements = <REQUIREMENTS verbatim>
)
```

`PAYMENT` carries `domain`, `types`, `message` and `payer`.

`PAYMENT.message` is the `Intent`. It already carries `intentNonce`, read live from the
chain.

Do not compute, adjust or second-guess any of its fields. Sign what you are given.

You cannot verify this bundle locally and do not need to: if the server were dishonest
the contract would reject the payment on-chain. The worst it can do is waste your nonce.

## Step 3: sign

Run `agent-id` *Sign* with `domain = PAYMENT.domain`, `types = PAYMENT.types`,
`message = PAYMENT.message`, `publicKey = <the chosen context's matchedInput>` and
`network`. The signature it returns is the agent signature. If signing fails, abort
and surface the error verbatim.

Move to Step 4 promptly: `PAYMENT.message` carries `validBefore`, a Unix-seconds
deadline the contract enforces, and it is inside what you just signed. Past it the
payment is refused and you must build a fresh one.

Sign `PAYMENT.message` exactly as returned. Editing `validBefore` to buy more time does
not work: finalize refuses a deadline the server would not have issued, even though the
signature over it is genuine.

## Step 4: run the script

A bundled script finalizes the payment and retries the request itself, in its own
process, so `PAYMENT-SIGNATURE` never exists in this conversation — it is ~4KB of opaque base64 wrapping
an ABI-encoded authorization, and reproducing that by hand is a copy task exactly
where a single displaced character rewrites an offset or a length word, and the
Diamond reverts with no reason data at all. Pipe everything it needs into it over
stdin — it never touches disk. The script is `scripts/x402-retry.mjs` in **this skill's
own directory** — the one holding the `SKILL.md` you were loaded from. The script has
this install's payment server URL baked in, so it must be this install's copy, never
one found elsewhere. `${CLAUDE_SKILL_DIR}` resolves that directory under Claude Code;
other agents don't substitute it, so use the absolute path of the directory you loaded
this `SKILL.md` from (the skill location your harness lists for `x402-payment`):

```bash
SKILL_DIR="${CLAUDE_SKILL_DIR:-<absolute directory this SKILL.md was loaded from>}"
SCRIPT="$SKILL_DIR/scripts/x402-retry.mjs"
[ -f "$SCRIPT" ] || { echo "x402-retry.mjs not found at $SCRIPT" >&2; exit 1; }
node "$SCRIPT" <<'EOF'
{
  "payment_requirements": <REQUIREMENTS verbatim, as JSON>,
  "intent": <PAYMENT.message unmodified, as JSON>,
  "agent_signature": "<signature from Step 3>",
  "request": { "url": "<resource_url>", "method": "GET" }
}
EOF
```

Replace the `<absolute directory …>` placeholder with the real path before running;
never run it literally. If the script is not found there, abort and tell the user the
skill install is incomplete — do not search the filesystem for another copy, and never
run a script from the working directory or from another install.

A quoted heredoc delimiter (`'EOF'`) passes the JSON literally — no `$`-expansion or
backslash processing — so nothing in it can be mangled putting it there. Set
`request.method`, `request.headers` and `request.body` to match the original request
when it wasn't a plain `GET`.

The script asks the payment server to finalize the payment (an endpoint you have no
tool for and must never call yourself) and retries `resource_url` with the resulting
header inside its own process — never printed, never in this conversation.
It prints exactly one JSON line to stdout and exits 0, whatever the outcome. A
non-zero exit means the script itself failed to run (bad input, unreachable server,
an unreadable reply) rather than reporting an outcome — surface its stderr and abort.
That includes an `http://` resource or payment server URL: the script only connects over
https (http on localhost only), so tell the user the merchant must be reached over https.

Read the one line of output:

- `{"ok":true,"status":200,...}`: paid. `body` is the resource. Report it.
  `settlement` is the decoded `PAYMENT-RESPONSE` receipt (`success`, `transaction`,
  `network`); it is absent when the merchant sent none.
- `{"ok":false,"stage":"finalize","code":...,"message":...}`: the payment server
  refused to finalize. Branch on `code` per Step 5. With no `code`, the server could
  not process it: surface `message` verbatim and abort.
- `{"ok":false,"stage":"retry","status":402,"error":...}`: the merchant refused the
  payment. Branch on `error` per Step 5. It comes from the `PAYMENT-REQUIRED` header, or
  else the body. Never report a bare "402 again": always state the `error`. The merchant
  will also return a fresh quote.
- `{"ok":false,"stage":"retry","status":<anything else>,...}`: surface `status` and
  `body`. This is a merchant problem, not a payment problem.

The script sends the header once. If it reports a merchant refusal, do not run it
again for the same Intent: it has already been judged.

## Step 5: interpret the outcome

Failures come from two places and mean different things. Always tell the user which
kind you hit, and whether retrying can help.

### From `build_x402_payment` / the script's finalize stage

Build and finalize both validate policy, config nonce, available funds and whether
another authorization still holds the nonce. Build rejects an unpayable or held quote before
signing; finalize repeats the checks because on-chain state can change while the agent
signs. Finalize also rejects a signed payment whose asset, payee or amount differs from
the quote.

| Code | Retryable | What to do |
|------|-----------|------------|
| `NONCE_MISMATCH` | **Once** | Another payment for this owner landed first. Redo Steps 2-4 once with a fresh build. A second failure aborts: only one payment per owner can be in flight. |
| `INTENT_EXPIRED` | **Once** | The deadline passed while you were signing, or you sent a `validBefore` the server would not issue. Nothing was spent and the nonce is untouched. Redo from Step 0 with a fresh 402 once. |
| `NONCE_HELD` | **After waiting** | A different authorization already holds this nonce and has not lapsed. The message names the moment it frees. Nothing was spent. Wait until then, then redo Steps 2-4 once. Do not re-sign in a loop, and do not retry before that moment: it will be refused again. |
| `MANDATE_NONCE_MISMATCH` | No | The stored config is stale. The owner must update or sync it in the Client App, then start again. |
| `OWNER_KEY_NOT_CURRENT` | No | The owner changed their Hedera account's key, so every config they signed before is invalid. Only the owner can fix it, by saving each agent account again in the Client App. Abort and say so. |
| `NOT_IN_ALLOWLIST` | No | The owner has not allowlisted this merchant. Only the owner can fix it, by signing a new config. Abort and say so. |
| `LIMIT_EXCEEDED` | No | The amount exceeds the per-transaction amount, or the asset has no policy. Abort. |
| `DAILY_CAP_EXCEEDED` | No | The daily amount is used up. Abort. |
| `ALLOWANCE_MISSING` | No | The owner must add funds for this asset. Abort. |
| `INSUFFICIENT_ALLOWANCE` | No | The owner must add more funds. Abort. |
| `RECIPIENT_NOT_ASSOCIATED` | No | The recipient must associate with the HTS token. Abort. |
| `MANDATE_NOT_FOUND` | No | This agent account is not registered. The owner must complete setup first. Abort. |
| `UNAUTHORIZED_AGENT` | No | The wrong key signed. Recheck which public key `agent-id` returned in Step 1 and that it matches the chosen context's `matchedInput`. Abort. |
| `INTENT_SOURCE_MISMATCH` | No | The owner input or returned Intent changed during the flow. Abort and report it as a flow integrity error. |
| `PAYMENT_REQUIREMENTS_MISMATCH` | No | The signed payment does not match the merchant quote. Abort, discard both, and start from a fresh 402 response. |
| `UNSUPPORTED_REQUIREMENTS` | No | The quote is not one an agent account can pay: another network, another transfer method, or an `extra.executors` list that does not admit the Diamond. Abort. |

### From the merchant's 402 on retry

The `error` strings are the merchant's and facilitator's own; there is no closed list.
Anything not in the table is surfaced verbatim, never guessed at.

| `error` | Meaning | What to do |
|---------|---------|------------|
| `simulation_reverted` | The payment would not execute: a spending policy blocked it, the transfer would fail (funds, balance), the nonce is stale, or the signature was rejected. **Nothing was spent and the nonce is intact.** | Rebuild from Step 0 once. If it fails again, abort: likely a per-transaction or daily amount, or not enough funds. Tell the user to check with the owner. |
| `executor_not_allowed` | The merchant does not accept payments through the Diamond. | Abort; this merchant cannot be paid from an agent account. |
| `settlement_payee_credit_mismatch`, `settlement_unexpected_debit`, `settlement_status_not_success`, `settlement_proof_failed` | The transaction mined but the ledger does not show the merchant credited the quoted amount. **The nonce is burned.** | Abort. Do not retry blindly. Report the transaction id so it can be inspected. |
| `missing_settlement_proof` | The facilitator claimed success without proving it. | Abort and report it; the merchant is right not to serve the resource. |
| anything else | Merchant-side refusal. | Surface the message verbatim and abort. |

The distinction that matters most: `simulation_reverted` costs nothing and leaves the
account exactly as it was, whereas any `settlement_*` code means a transaction reached
consensus. Never describe the first as a lost payment.

## Output

One short human-readable message, nothing before it.

- Success: `Paid <amount> <symbol> for <resource_url>.` then the resource content, then
  `Receipt: https://hashscan.io/<network>/transaction/<txId>` when the merchant
  returned a transaction id (`settlement.transaction`, or `settlement.transactionId`
  where a server uses that name). (`amount` = `REQUIREMENTS.amount` / `10^decimals`,
  `symbol` + `decimals` from the asset policy matched in Step 1; HBAR = amount / 1e8
  with symbol `HBAR`.)
- Abort: state which step failed, whether retrying can work, and the server or
  merchant message verbatim.

## Boundaries

- Work silently: no step announcements, progress, plans, or internal values (nonce,
  agent address, identity, signature, authorization). Speak mid-loop only to ask for
  a missing input, to confirm the amount, or to abort.
- Never print or export the private key; reference the local identity by public key only.
- Never modify `REQUIREMENTS` or `PAYMENT.message`. Pass each through byte-for-byte
  into the script's stdin.
- Never construct the `Intent`, the nonce or the authorization yourself. They come from
  `build_x402_payment` and the script's finalize step.
- Never construct an EVM address from a `0.0.x` id. Always use `resolve_address`.
- **The source is never inferred, because it is never chosen.** The paying account
  comes from `resolve_agent_context` — agent accounts this agent's key already authorizes
  — and the server derives `Intent.source` from it. Do not read an owner address
  from the local keystore, `agent-id` output or any other local or session state, and
  never pass one to a tool. The Step 1 sieve selects between agent accounts; it never refuses the payment.
- Never pre-check policy (per-transaction and daily amounts, allowlist, funds). The server and
  the chain enforce all of it; a local guess will be wrong.
- One retry, and only for `NONCE_MISMATCH`, `INTENT_EXPIRED` or `NONCE_HELD`. Every
  other failure aborts. All three leave the nonce unspent, which is why they are the
  only retryable ones; `NONCE_HELD` also requires waiting until the moment it names.
- Re-running the script for the same Intent and signature is safe: finalize returns
  the same header rather than authorizing a second payment.
- Do not pay a 402 the user did not ask you to resolve, and do not pay the same 402
  twice because the first attempt was ambiguous. If you cannot tell whether a payment
  landed, stop and ask.
- **Exclusive tool list:** only the payment MCP server tools (`get_capabilities`,
  `get_troubleshooting_guide`, `get_agent_mandate`, `resolve_address`,
  `resolve_agent_context`, `build_x402_payment`), the `agent-id` skill **from this
  skill's own install** (with whatever tools it names), and the Bash blocks of Step 0
  (probe) and Step 4 alone — resolving `SCRIPT` from this skill's own directory and the
  heredoc piped into it — are in scope. Explicitly out of scope:
  any other use of Bash, `git`, web search, file reads, any other MCP server, any other
  skill. If a needed tool is missing, abort and tell the
  user rather than improvising a path.
- **Never call the finalize endpoint yourself (no `curl`, `fetch` or any other
  request to it), and never put a `PAYMENT-SIGNATURE` value in a command.**
  `x402-retry.mjs` is the only route you may take from a signed Intent to a paid
  request — it exists precisely so that header never has to be reproduced by hand.
  Calling the endpoint directly would put the header in this conversation.
- If context is lost or a tool seems unavailable, call `get_capabilities` or
  `get_troubleshooting_guide` before searching the filesystem or inventing endpoints.
