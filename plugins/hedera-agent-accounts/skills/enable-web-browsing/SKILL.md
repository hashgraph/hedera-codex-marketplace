---
name: enable-web-browsing
description: Set up browser automation for CLI coding agents (Claude Code CLI, Codex CLI, Cursor, opencode) so the agent can browse the web to find and purchase items, using Playwright MCP or Browser Use MCP. Use when the user asks to browse, shop, or find things to buy online from a CLI agent and no browser tool is available. For desktop apps (Claude Desktop, ChatGPT / Codex desktop) it gives UI-only connector steps and runs no commands.
---

# enable-web-browsing

Give a CLI agent a real browser so it can find items to purchase and fill in checkout
forms. Once set up the agent browses to the invoice; payment is handled by the
`request-payment` skill using Hedera HBAR or USDC.

## Desktop apps (UI steps only, no commands)

- **ChatGPT / Codex desktop:** has a built-in browser; just ask the agent to browse.
  Add the Chrome connector (Plugins → Chrome) only to reuse your logged-in profile.
- **Claude Desktop:** needs a browser connector to click and fill forms. Either:
  - Settings → Extensions → **chrome-control** → Install, plus the **Claude** extension
    from the Chrome Web Store, with Chrome running; or
  - Settings → Plugins → Partners → **Browser Use** → Install.

Do not run anything from this skill in a desktop app — inside Claude Desktop's Co-work or
Chat tab you are sandboxed and cannot run `claude mcp add` or `npx` anyway. Give the user
the UI steps above and stop.

## Step 1 — Identify the CLI (one question, wait for answer)

> Which CLI agent are you using?
> **A** — Claude Code CLI
> **B** — Codex CLI
> **C** — Another CLI agent (Cursor, opencode, or similar)

## Step 2 — Choose the method (one question, wait for answer)

> Which web-navigation method do you want?
> **1** — Playwright MCP (local browser; no account or API key)
> **2** — Browser Use MCP (cloud browser; API key entered locally, never pasted into chat)

Summarize the choice and ask **"Ready to proceed?"**. Do not run any command until the
user says yes.

Playwright MCP runs your installed Chrome/Edge/Brave/Arc locally — no account, works
offline. Browser Use runs the browser in the cloud — no local browser, but needs an API
key (free account, $15 credits on sign-up).

---

## Playwright MCP (A, B or C + 1)

### 1. Detect the installed browser (read-only)

```bash
detect_browser() {
  [ -d "/Applications/Google Chrome.app" ] && { echo "channel:chrome"; return; }
  command -v google-chrome         >/dev/null 2>&1 && { echo "channel:chrome"; return; }
  command -v google-chrome-stable  >/dev/null 2>&1 && { echo "channel:chrome"; return; }
  [ -d "/Applications/Microsoft Edge.app" ] && { echo "channel:msedge"; return; }
  command -v microsoft-edge        >/dev/null 2>&1 && { echo "channel:msedge"; return; }
  command -v microsoft-edge-stable >/dev/null 2>&1 && { echo "channel:msedge"; return; }
  [ -f "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" ] && { echo "exec:/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"; return; }
  [ -f "/Applications/Arc.app/Contents/MacOS/Arc"                     ] && { echo "exec:/Applications/Arc.app/Contents/MacOS/Arc"; return; }
  [ -f "/Applications/Chromium.app/Contents/MacOS/Chromium"           ] && { echo "exec:/Applications/Chromium.app/Contents/MacOS/Chromium"; return; }
  for b in brave-browser brave chromium-browser chromium; do
    command -v "$b" >/dev/null 2>&1 && { echo "exec:$(which "$b")"; return; }
  done
  # Playwright drives its own Gecko build, not system Firefox; detected only so we can
  # offer the no-sudo "playwright install firefox" download.
  [ -d "/Applications/Firefox.app" ] && { echo "browser:firefox"; return; }
  for b in firefox firefox-esr; do
    command -v "$b" >/dev/null 2>&1 && { echo "browser:firefox"; return; }
  done
  for cache in ~/Library/Caches/ms-playwright ~/.cache/ms-playwright; do
    ls -d "${cache}/chromium-"* >/dev/null 2>&1 && { echo "bundled:chromium"; return; }
    ls -d "${cache}/firefox-"*  >/dev/null 2>&1 && { echo "bundled:firefox"; return; }
  done
  echo "none"
}
detect_browser
```

### 2. Map the output to a flag

| Detection output   | Playwright flags                    |
|--------------------|-------------------------------------|
| `channel:chrome`   | `--browser chrome`                  |
| `channel:msedge`   | `--browser msedge`                  |
| `exec:<path>`      | `--executable-path "<path>"`        |
| `bundled:chromium` | `--browser chromium`                |
| `bundled:firefox`  | `--browser firefox`                 |
| `browser:firefox`  | Download first — see below          |
| `none`             | **Stop — see below**                |

Tell the user which browser was detected and which command will run before running it.

**Firefox (`browser:firefox`):** Playwright needs its own Gecko build (~100 MB, no sudo).
Tell the user, wait for their go-ahead, then run `npx -y playwright install firefox`
and use `--browser firefox`.

**None found:** Safari is not supported. Do not download anything. Offer: (a) install
Google Chrome (`brew install --cask google-chrome`) — recommended; (b) install Firefox;
(c) `npx -y playwright install chromium` (~180 MB, blank profile). Wait for the user to
choose and run the install themselves, then re-run this skill.

### 3. Register (replace any previous entry first)

A stale flag-less `playwright` entry silently defaults to Chrome and breaks without it,
so always remove before adding.

**Claude Code CLI (A):**

```bash
claude mcp remove playwright -s user  2>/dev/null || true
claude mcp remove playwright -s local 2>/dev/null || true
claude mcp add -s user playwright -- npx -y @playwright/mcp@latest <flags>
```

**Codex CLI (B):**

```bash
codex mcp remove playwright 2>/dev/null || true
codex mcp add playwright -- npx -y @playwright/mcp@latest <flags>
```

**Other CLI (C):** don't run another CLI's command. Give the user this entry for their
agent's **global** MCP config (check its docs for the file location):

```json
{ "mcpServers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest", "<flags>"] } } }
```

To reuse a logged-in profile, add `--user-data-dir <path>` with the browser fully closed.

Then tell the user: **restart the agent** (MCP servers load at startup) and confirm
`playwright` appears in its MCP list (`/mcp` in Claude Code).

### Hard limits

- Never run `playwright install chrome` or `--with-deps` (they trigger sudo), never use
  `sudo`, never `npm install -g playwright`.
- If a command fails, stop, show the exact error, and let the user decide. Do not retry
  with different flags.

---

## Browser Use MCP (A, B or C + 2)

### 1. Get an API key

Send the user to <https://cloud.browser-use.com/settings?tab=api-keys> (key starts with
`bu_`). **Never ask them to paste the key into chat, and never read, print or echo it.**

### 2. Store the key and load it in every terminal

The configs below reference the variable `BROWSER_USE_API_KEY`, so it must be set in
**every** terminal or IDE that launches the agent — otherwise the header resolves to the
literal `${BROWSER_USE_API_KEY}` and every session gets a 401. Have the user store the key
in the OS keychain and add a profile line that looks it up, so the profile holds a lookup
command, not the key. The user runs these; you never read or echo the key.

**macOS** (prompts for the key with hidden input):

```bash
security add-generic-password -U -a "$USER" -s browser-use-api-key -w
echo 'export BROWSER_USE_API_KEY="$(security find-generic-password -a "$USER" -s browser-use-api-key -w 2>/dev/null)"' >> ~/.zshrc
```

**Linux** (Secret Service; prompts for the key with hidden input):

```bash
secret-tool store --label='Browser Use API key' service browser-use-api-key
echo 'export BROWSER_USE_API_KEY="$(secret-tool lookup service browser-use-api-key 2>/dev/null)"' >> ~/.bashrc
```

Use `~/.bashrc` / `~/.zshrc` to match the user's shell. Skip the `echo >>` if the line is
already in the profile.

**No keychain available:** load it for this terminal only, and tell the user they must
repeat this in each new terminal before launching the agent:

```bash
# zsh
read -r -s 'BROWSER_USE_API_KEY?Paste your Browser Use API key (hidden): '; echo; export BROWSER_USE_API_KEY
# bash
read -r -s -p 'Paste your Browser Use API key (hidden): ' BROWSER_USE_API_KEY; echo; export BROWSER_USE_API_KEY
```

Then, in a **new terminal**, verify without revealing it:

```bash
test -n "$BROWSER_USE_API_KEY" && echo loaded || echo missing
```

If `missing`, have them redo this step. Never write the literal key into a shell profile or
any config file; the configs below store only the variable **name**. IDEs started from the
Dock or an app launcher may not read the shell profile — start them from a terminal
(e.g. `code .`) so they inherit the variable.

### 3. Register the server

**Claude Code CLI (A)** — single quotes so the literal `${BROWSER_USE_API_KEY}` is stored,
not the key:

```bash
claude mcp remove browser-use -s user  2>/dev/null || true
claude mcp remove browser-use -s local 2>/dev/null || true
claude mcp add -s user browser-use https://api.browser-use.com/v3/mcp \
  -t http -H 'x-browser-use-api-key: ${BROWSER_USE_API_KEY}'
claude mcp get browser-use
```

`get` should show the literal reference, not the key.

**Codex CLI (B)** — `codex mcp add` has no custom-header option, so the entry goes into
`~/.codex/config.toml` directly (the value is the variable *name*). A second
`[mcp_servers.browser-use]` table makes the whole file unparseable, so remove any previous
entry and append only if the table is absent:

```bash
codex mcp remove browser-use 2>/dev/null || true
grep -q '^\[mcp_servers\.browser-use\]' ~/.codex/config.toml 2>/dev/null || cat >> ~/.codex/config.toml <<'EOF'

[mcp_servers.browser-use]
url = "https://api.browser-use.com/v3/mcp"
env_http_headers = { "x-browser-use-api-key" = "BROWSER_USE_API_KEY" }
EOF
codex mcp get browser-use
```

If the table is still present after the remove, edit it in place — never add a second copy.

**Other CLI (C):** use that agent's docs for a remote HTTP MCP server with the endpoint
`https://api.browser-use.com/v3/mcp` and header `x-browser-use-api-key` taken from the
`BROWSER_USE_API_KEY` environment variable.

### 4. Start the agent from that terminal

Tell the user: exit the current agent and run it again **from a terminal where the key is
loaded** (step 2's check prints `loaded`), then confirm `browser-use` is listed and
connected. A 401 means the variable was not in the environment at launch — redo step 2.

---

## Verify

```
Using browser automation, open https://www.bitrefill.com/us/en/gift-cards/doordash-usa/,
accept essential cookies only, select 20 USD, add to cart, and check out with email
test@example.com paying with USDC. Stop at the payment invoice — do not connect a wallet
or send any funds. Report the USDC amount, payment address, network, and invoice ID.
```

Once the agent reaches the invoice, use the `request-payment` skill to pay with Hedera
HBAR or USDC. Invoke it the way this harness invokes skills: `/request-payment` (skills
installed with `npx skills`), `/hedera-agent-accounts:request-payment` (Claude plugin), or
`$Request Payment` (Codex).

## Boundaries

- Setup only: this skill registers a browser tool; it does not browse or purchase.
- Only the commands in the chosen section run, and only after the user confirms.
- Stop on failure; never improvise. Payment is out of scope — hand off to `request-payment`.
