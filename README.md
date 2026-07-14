# 🚀 Instagram DM Funnel — free ManyChat alternative

A ManyChat-style **comment-to-DM funnel** for Instagram that costs **$0/month**, no matter how many people go through it. Built by [@kokabuildsf](https://www.instagram.com/kokabuildsf/).

Someone comments your keyword on a reel → they get a DM with a button → the bot checks if they **follow you** → followers get your link, non-followers get "follow me first" and are unlocked automatically the moment they follow.

ManyChat charges $29+/month and bills you *per contact* (a viral reel can cost you hundreds of dollars in overage fees). This does the same core funnel on free tiers: **Cloudflare Workers** (free plan) + **Composio** (free tier) + your own Instagram professional account.

## How it works

```
 💬 comment "build"          📩 DM with button           🔀 follow check
 ────────────────►  bot  ────────────────────►  tap  ────────────────────►
                                                        │
                              follower? ──────────────► 🔗 link card
                              not following? ─────────► 🔒 "follow @you, tap again"
                                                        │  (auto-unlocked when
                                                        │   they follow — even
                                                        │   without re-tapping)
```

1. **HOOK** — a keyword comment triggers a DM with a *"Send me the link 🔗"* button (never the raw link) + a public reply under the comment ("check your DMs 👀").
2. **CLICK** — the tap arrives as a message; the bot polls conversations every ~2.5s and reacts in ~5 seconds. It checks Instagram's `is_user_follow_business` field — the exact same field ManyChat's follow gate uses.
3. **FOLLOW GATE** — non-followers get a message with a **Follow** button (opens your profile) and the link button. For up to 7 days, the bot re-checks them every minute and delivers the link automatically once they follow.

Everything is tracked in a **live dashboard** (the worker's URL): buttons sent, people gated, links delivered, per-campaign stats.

## Requirements

- An **Instagram professional account** (business or creator — free to switch in the app)
- A free [Composio](https://composio.dev) account (handles the Instagram OAuth for you)
- A free [Cloudflare](https://cloudflare.com) account
- Node.js 18+

## Setup (~10 minutes)

### 1. Connect Instagram via Composio

1. Create a free account at [composio.dev](https://composio.dev)
2. In the dashboard, add the **Instagram** toolkit and connect your Instagram professional account (OAuth flow)
3. Note the **user id** you connected under (e.g. `default`) and copy your **API key**

### 2. Configure the bot

```bash
git clone https://github.com/LdwS123/instagram-dm-funnel.git
cd instagram-dm-funnel
npm install
```

Open `src/worker.ts` and edit the top section:

- `MY_HANDLE` / `MY_PROFILE_URL` → your Instagram handle and profile URL
- `CAMPAIGNS` → your keywords, links and message copy (the two entries in there are working examples — replace them with your own offers)
- The gate messages (`GATE_DM_DEFAULT`, `GATE_NUDGE`) if you want your own voice

In `wrangler.toml`, set `COMPOSIO_USER_ID` to the user id from step 1.

### 3. Deploy to Cloudflare

```bash
npx wrangler login                        # opens your browser
npx wrangler kv namespace create STATE    # copy the printed id into wrangler.toml
npx wrangler secret put COMPOSIO_API_KEY  # paste your Composio API key
npx wrangler secret put ADMIN_KEY         # any long random string — unlocks /admin
npx wrangler deploy
```

### 4. Verify

- Open `https://<your-worker>.workers.dev/gate-check` → you want `"graph_token_recovered": true`
- Open `https://<your-worker>.workers.dev` → the live dashboard
- From another account, comment your keyword on a recent reel → the DM lands within ~20s, the button answers in ~5s

## Admin UI — edit everything in the browser

Open `https://<your-worker>.workers.dev/admin` to edit your campaigns (keywords, links, DM copy), button labels and follow-gate messages **without touching code or redeploying** — changes go live in ~15 seconds.

Protect it first (required — anyone with the key can change your links):

```bash
npx wrangler secret put ADMIN_KEY   # pick a long random value
```

Enter that key once on the /admin page; it's stored only in your browser.

## Configuration reference

| Variable | Default | What it does |
|---|---|---|
| `MAX_PER_HOUR` | 10 | Max DMs sent per hour (safety valve) |
| `SCAN_POSTS` | 6 | How many recent posts are scanned for keyword comments |
| `MAX_AGE_DAYS` | 7 | Ignore comments older than this (Instagram's private-reply window) |
| `REPLY_PUBLICLY` | true | Post a public "check your DMs" reply under keyword comments |
| `CLICK_GAP_MS` | 2500 | How often button taps are checked (lower = faster, more API calls) |
| `SCAN_INTERVAL_MS` | 20000 | How often comments are scanned |
| `FOLLOW_GATE` | true | Require following before the link is sent |
| `GATE_FAIL_OPEN` | true | If the follow check errors, send the link anyway |

## FAQ

**Is it really free?** Yes. Cloudflare's free plan includes 1-minute crons and 100k requests/day; the polling loop is sized to stay inside the free plan's 50-fetches-per-invocation cap. Composio's free tier covers the API volume. Cost scales with *nothing* — 100 or 100,000 comments is the same bill: $0.

**How fast is it?** Comment → DM in ~15-20s. Button tap → response in ~5s. That's the physical floor for a polling architecture (each Instagram API round trip takes ~2.5s). Sub-second responses would require a Meta webhook app (what ManyChat runs) — a much heavier setup with Meta app review.

**Why does the follow check happen at the click, not the comment?** Instagram only allows reading a user's profile (including whether they follow you) after that user has **sent you a message**. The button tap *is* that message — it's also why ManyChat structures its funnels the same way.

**The buttons don't render / messages arrive as plain text?** Instagram is picky about message templates. The bot cascades through formats (button template → generic template → quick replies → plain text) and remembers what works, so the funnel keeps working either way — typed replies count as taps too.

**Use responsibly.** Respect Instagram's platform policies and rate limits (the defaults are deliberately conservative). You're messaging real people: keep it useful, don't spam.

---

MIT licensed. Built with Cloudflare Workers + Composio. No paid services, no subscriptions, no per-contact billing.
