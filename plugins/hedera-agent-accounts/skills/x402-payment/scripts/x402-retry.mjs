#!/usr/bin/env node
// Finalizes an x402 payment and retries the original request, entirely inside this
// process. The PAYMENT-SIGNATURE header this produces (the `header` the payment
// server's `POST /api/x402/finalize` returns) never becomes model output: it is read
// from that HTTP response and used to build the retry request in the same process, and
// is never printed, logged, or included in this script's own output.
//
// Finalize is deliberately not an MCP tool. The agent has no tool for it and the skill
// tells it never to call the endpoint itself, so this script is the one sanctioned
// route from a signed Intent to a paid request. That hides the endpoint from the agent;
// it does not close it: the route is public, and what protects it is the agent's
// signature over the Intent, not who is calling.
//
// Reproducing that header by hand is a copy task over ~4KB of opaque base64 wrapping
// an ABI-encoded authorization. A single displaced character rewrites an offset or a
// length word and the Diamond reverts with no reason data — indistinguishable from a
// policy refusal. This script exists so that never has to happen.
//
// Used by the x402-payment skill (whichever signer backs agent-id — this file is its
// single shared copy, published to ${CLAUDE_SKILL_DIR}/scripts/x402-retry.mjs by every
// channel). See its SKILL.md for the surrounding flow and Boundaries.
//
// Usage: node x402-retry.mjs < request.json
//   request.json (read from stdin, never written to disk): {
//     payment_requirements, intent, agent_signature,
//     request: { url, method?, headers?, body? }
//   }
//   (the first three are the finalize endpoint's request body, passed through
//    unmodified. The Intent names the agent mandate it debits, so no account is
//    repeated here: a second copy of the same fact could only ever disagree with the
//    signed one.)
//
// Probe mode, for reading a 402's quote without paying: node x402-retry.mjs < probe.json
//   probe.json: { "probe": true, "request": { url, method?, headers?, body? } }
// Sends the request as given and decodes the x402 v2 `PAYMENT-REQUIRED` header (base64
// JSON `PaymentRequired`), falling back to the 402 body for servers that still publish
// `accepts[]` there. Needs no payment fields and never calls the payment server.
//
// Prints exactly one JSON line to stdout and exits 0, whatever the outcome:
//   {"ok":true,"status":200,"headers":{...},"body":...,"settlement":{...}}
//   {"ok":false,"stage":"finalize","code":"NONCE_MISMATCH","message":"..."}
//   {"ok":false,"stage":"retry","status":402,"error":"simulation_reverted","headers":{...},"body":{...}}
//   {"ok":true,"stage":"probe","status":402,"source":"header","error":"...","accepts":[...]}
//   {"ok":false,"stage":"probe","status":200,"headers":{...},"body":...}
// A finalize refusal carries `code` only when the server named a domain code.
// `settlement` is the decoded `PAYMENT-RESPONSE` header (`X-PAYMENT-RESPONSE` as the v1
// fallback), present only when it decodes. `error` on a failed retry is the 402's own
// `error`, from the `PAYMENT-REQUIRED` header or else the body — never a bare "402 again".
// Exits non-zero only when the script itself could not run (bad input, an http:// URL,
// unreachable server, a reply it cannot read, a request refused before the payment was
// looked at) — that is the one case with nothing meaningful to report as an outcome.
//
// Every URL must be https; http is accepted for localhost only. Redirects are not followed:
// a 3xx is reported as the outcome, with its `location`, so a redirect can never carry the
// request, or the payment header, to a URL that was not checked.
//
// No imports: only Node globals (fetch, process, Buffer). stdin over a temp file
// means the signed Intent and signature never touch disk, even transiently.

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Substituted at publish time with the payment server's finalize URL, derived from the
// MCP URL each publisher is given (apps/claude-plugin/src/generate.mjs and
// apps/codex-plugin/src/generate.mjs for the plugins, apps/client-app/plugins/skills.ts
// for the hcli/.well-known channel, scripts/setup-agent.sh for the local hcli setup).
// Every publisher fails if a placeholder survives. X402_FINALIZE_URL overrides at
// invocation time, for a self-hosted payment server the published default doesn't
// match — set it in the same shell that runs this script.
const FINALIZE_URL = process.env.X402_FINALIZE_URL || 'https://payment.agent-accounts.haw.blockydevs.dev/api/x402/finalize';

// Neither fetch call below has a default timeout — an unresponsive payment server or
// merchant would otherwise hang this process forever, stalling the agent and risking
// PAYMENT.message's validBefore lapsing while it waits. X402_TIMEOUT_MS overrides for
// a slow self-hosted server, same convention as X402_FINALIZE_URL above.
const TIMEOUT_MS = Number(process.env.X402_TIMEOUT_MS) || 30_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// A signed Intent, a payment header or the caller's own headers must not cross the network
// unencrypted. Only the origin is echoed: a query string may carry a key.
function requireEncrypted(value, what) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${what} is not a valid URL.`);
  }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return;
  fail(`Refusing ${what} ${url.protocol}//${url.host}: only https is allowed (http on localhost only).`);
}

// `secret`, when given, is redacted from the printed line by exact value match — never
// by header name. The x402 settlement receipt (`payment-response`) is a different
// value from the `PAYMENT-SIGNATURE` we sent and must survive; matching only the literal
// header we generated catches it being reflected back under any key, in headers or in
// the body, without swallowing that receipt.
function output(result, secret) {
  let line = JSON.stringify(result);
  if (secret) line = line.split(secret).join('[redacted]');
  process.stdout.write(line + '\n');
}

/**
 * Plain JSON in, plain JSON out. 2xx carries `{ header, executor, authorization, payer }`;
 * a refusal is non-2xx `{ code?, message }`, `code` being the domain code
 * (NONCE_MISMATCH, INTENT_EXPIRED, ...) when there is one. Any other reply is not an
 * outcome this script can report, so it fails. Nothing from a 2xx reply is ever printed
 * on those failure paths: it carries the header. The one non-2xx reason they do print
 * is the Host/Origin check's (see below).
 */
async function callFinalize({ payment_requirements, intent, agent_signature }) {
  let response;
  try {
    response = await fetch(FINALIZE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ payment_requirements, intent, agent_signature }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // A 3xx then fails below, unfollowed.
      redirect: 'manual',
    });
  } catch (error) {
    if (error.name === 'TimeoutError') {
      fail(
        `Timed out waiting for the payment server after ${TIMEOUT_MS}ms. Nothing was ` +
          'spent; the nonce is untouched — safe to retry.',
      );
    }
    fail(`Could not reach the payment server: ${error.message}`);
  }

  if (response.status >= 300 && response.status < 400) {
    fail(
      `Payment server redirected (HTTP ${response.status}); redirects are not followed. ` +
        'Nothing was spent. Set X402_FINALIZE_URL to its https finalize URL and retry.',
    );
  }

  // The abort signal stays live through body consumption (verified against Node's
  // undici-backed fetch), so a hang here after headers already arrived throws too.
  let text;
  try {
    text = await response.text();
  } catch (error) {
    if (error.name === 'TimeoutError') {
      fail(
        `Timed out reading the payment server's response after ${TIMEOUT_MS}ms. ` +
          'Nothing was spent; the nonce is untouched — safe to retry.',
      );
    }
    fail(`Could not read the payment server's response: ${error.message}`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }

  if (response.ok) {
    const header = body?.header;
    if (typeof header !== 'string' || !header) {
      fail(`Payment server returned HTTP ${response.status} without a payment header`);
    }
    return { ok: true, header };
  }

  if (typeof body?.message !== 'string') {
    // The Host/Origin check in front of the route is the MCP SDK's middleware, so its
    // 403 is a JSON-RPC error (`{ jsonrpc, error: { code, message }, id }`), not a
    // refusal of the payment: the server never read it. Not an outcome either, but
    // its reason ("Invalid Host: ...") is what the user needs to fix the setup.
    const reason = body?.error?.message;
    if (typeof reason === 'string' && reason) {
      fail(`Payment server returned HTTP ${response.status}: ${reason}`);
    }
    fail(`Payment server returned HTTP ${response.status} without an error message`);
  }
  return {
    ok: false,
    code: typeof body.code === 'string' ? body.code : undefined,
    message: body.message,
  };
}

/**
 * Decodes an x402 v2 header value: standard base64 of a JSON object (what
 * `@x402/core/http` encodes and decodes). `undefined` for anything else, so a v1 plain
 * value or a malformed header reads as absent rather than throwing.
 */
function decodeHeaderJson(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A 402's quote: `accepts[]` and `error`, from the v2 `PAYMENT-REQUIRED` header, falling
 * back to the body only when the header is missing or does not decode. The v2 spec leaves
 * the body to the server, so many publish nothing there.
 */
function readPaymentRequired(headers, body) {
  const fromHeader = decodeHeaderJson(headers['payment-required']);
  if (fromHeader) return { source: 'header', accepts: fromHeader.accepts, error: fromHeader.error };
  if (body && typeof body === 'object') {
    return { source: 'body', accepts: body.accepts, error: body.error };
  }
  return { source: 'none', accepts: undefined, error: undefined };
}

/** The settlement receipt: `PAYMENT-RESPONSE`, then v1's `X-PAYMENT-RESPONSE`. */
function readSettlement(headers) {
  return decodeHeaderJson(headers['payment-response'] ?? headers['x-payment-response']);
}

// `header` is the payment to attach; without it this is a plain request (probe mode), so
// a timeout there says nothing about a payment.
async function retryRequest(request, header) {
  const { url, method = 'GET', headers = {}, body } = request;
  const submitted = header ? ' The payment may already have been submitted — do not retry; verify before paying again.' : '';
  // `body` in request.json is written by the model as JSON, so it may be a raw string
  // or a nested object — fetch only accepts a string body, so stringify anything else
  // rather than requiring the model to get this exactly right.
  const requestBody =
    body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: header ? { ...headers, 'PAYMENT-SIGNATURE': header } : headers,
      body: requestBody,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Reported as the outcome instead; see the header comment.
      redirect: 'manual',
    });
  } catch (error) {
    // The header was already attached to this request when it went out — unlike the
    // finalize leg, a timeout here does not mean nothing happened. The merchant may
    // have received and even settled it before going quiet.
    if (error.name === 'TimeoutError') {
      fail(`Timed out waiting for ${url} after ${TIMEOUT_MS}ms.${submitted}`);
    }
    fail(`Could not reach ${url}: ${error.message}`);
  }

  const status = response.status;
  const responseHeaders = Object.fromEntries(response.headers.entries());
  let text;
  try {
    text = await response.text();
  } catch (error) {
    if (error.name === 'TimeoutError') {
      fail(`Timed out reading the response from ${url} after ${TIMEOUT_MS}ms.${submitted}`);
    }
    fail(`Could not read the response from ${url}: ${error.message}`);
  }
  let body_;
  try {
    body_ = JSON.parse(text);
  } catch {
    body_ = text;
  }
  return { status, headers: responseHeaders, body: body_ };
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (error) {
    fail(`Could not parse stdin as JSON: ${error.message}`);
  }

  if (input.probe) {
    if (!input.request?.url) fail('probe stdin JSON must have request.url');
    requireEncrypted(input.request.url, 'request.url');
    const probed = await retryRequest(input.request);
    const quote = readPaymentRequired(probed.headers, probed.body);
    if (probed.status === 402 && Array.isArray(quote.accepts)) {
      output({
        ok: true,
        stage: 'probe',
        status: probed.status,
        source: quote.source,
        error: quote.error,
        accepts: quote.accepts,
      });
    } else {
      output({
        ok: false,
        stage: 'probe',
        status: probed.status,
        headers: probed.headers,
        body: probed.body,
      });
    }
    return;
  }

  const { payment_requirements, intent, agent_signature, request } = input;
  if (!payment_requirements || !intent || !agent_signature || !request?.url) {
    fail('stdin JSON must have payment_requirements, intent, agent_signature, and request.url');
  }
  // Both before finalize, so a refused URL spends nothing.
  requireEncrypted(FINALIZE_URL, 'the payment server URL');
  requireEncrypted(request.url, 'request.url');

  const finalized = await callFinalize({ payment_requirements, intent, agent_signature });
  if (!finalized.ok) {
    output({ ok: false, stage: 'finalize', code: finalized.code, message: finalized.message });
    return;
  }

  const retried = await retryRequest(request, finalized.header);
  const settlement = readSettlement(retried.headers);
  if (retried.status >= 200 && retried.status < 300) {
    output(
      { ok: true, status: retried.status, headers: retried.headers, body: retried.body, settlement },
      finalized.header,
    );
  } else {
    output(
      {
        ok: false,
        stage: 'retry',
        status: retried.status,
        error: readPaymentRequired(retried.headers, retried.body).error,
        headers: retried.headers,
        body: retried.body,
        settlement,
      },
      finalized.header,
    );
  }
}

await main();
