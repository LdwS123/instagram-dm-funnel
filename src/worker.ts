/**
 * Affiliate Comment → DM bot — Cloudflare Worker.
 *
 * ManyChat-style 3-step funnel, on a 1-minute cron with sub-minute polling
 * (~15s effective latency):
 *
 *   1. HOOK — someone comments a campaign keyword → they get a DM with a
 *      "Send me the link 🔗" quick-reply button (never the raw link) + a
 *      public reply under their comment.
 *   2. CLICK — they tap the button (or type anything back). The bot polls
 *      conversations, sees their message, and checks `is_user_follow_business`
 *      (the same field ManyChat uses):
 *        · follower      → the campaign link is DM'd.
 *        · not following → "follow @me, then tap again" DM (with the button).
 *   3. FOLLOW — gated people are re-checked for up to 7 days; the moment they
 *      follow, the link is sent automatically (no re-tap needed).
 *
 * Instagram API access: quick replies, conversation reading and the follow
 * check aren't covered by Composio's built-in Instagram tools, so the worker
 * calls graph.instagram.com directly with the connected account's token
 * (recovered from Composio's own paging URLs — no extra setup). If that ever
 * stops working, set COMPOSIO_PROXY_API_KEY (a proxy-execute scoped key) as a
 * fallback transport. With neither available the bot degrades gracefully to
 * the old behavior: keyword comment → link DM'd immediately.
 *
 * To add or edit campaigns / copy: open /admin on the worker URL (no redeploy).
 */

const TOOLS_URL = 'https://backend.composio.dev/api/v3/tools/execute';
const GRAPH = 'https://graph.instagram.com/v21.0';

// ── Campaigns ──────────────────────────────────────────────────────────────
// One entry per partnership. Order matters: if a comment matches multiple
// keywords, the FIRST campaign wins. Put more specific keywords above generic.
type Campaign = {
  name: string;            // shown on the dashboard
  keyword: string;         // matched case-insensitively, anywhere in the comment (@mentions stripped first)
  link: string;            // affiliate link delivered at the end of the funnel
  hookDm: string;          // step-1 DM: teases the link, sent with the button — NO link in here
  dmTemplate: string;      // final DM once they qualify; {link} is replaced with `link` (plain-text fallback)
  linkCardText: string;    // final DM as a sorhan-style card: this text + a link button
  linkButtonTitle: string; // label of the link button on the final card
  publicReplies: string[]; // one is picked at random per match for variety
  // Optional per-campaign follow-gate copy. Falls back to GATE_DM_DEFAULT.
  // {keyword} is replaced with the campaign keyword.
  gateDmTemplate?: string;
};

// ── Funnel copy (edit freely — this is your voice) ─────────────────────────
const MY_HANDLE = '@kokabuildsf';
const MY_PROFILE_URL = 'https://www.instagram.com/kokabuildsf/';

// Label of the in-bubble button. When tapped, the tap shows up as a message
// from the user in the thread — that's how the polling bot "sees" the click.
const BTN_TITLE = 'Send me the link 🔗';
const FOLLOW_BTN_TITLE = `Follow ${MY_HANDLE}`;

const GATE_DM_DEFAULT =
  `not following me yet 👀 I only send this to followers.\n\ntap Follow below, then hit "${BTN_TITLE}" — and it's yours ⚡`;

// Sent if they tap again while STILL not following (instead of silence).
const GATE_NUDGE =
  `still can't see your follow 👀 make sure you're following ${MY_HANDLE}, then tap again ⚡`;

// Minimum gap between two gate/nudge messages to the same person.
const GATE_RESEND_MS = 2 * 60 * 1000;

const CAMPAIGNS: Campaign[] = [
  {
    name: 'Emergent',
    keyword: 'build',
    link: 'https://app.emergent.sh/register?ref=koka217651',
    hookDm:
      'Yo! 🙌 wanna build your own app like in the reel? I got you 5 free credits on Emergent — tap below and I\'ll send you the link ⚡',
    dmTemplate:
      'here it is 🤝 5 free credits to start building on Emergent: {link}\n\nBuild something and tag me 👀',
    linkCardText:
      'here it is 🤝 5 free credits to start building on Emergent.\n\nBuild something and tag me 👀',
    linkButtonTitle: 'Claim 5 free credits ⚡',
    publicReplies: [
      'just slid into your DMs 📩',
      'check your DMs 👀',
      'sent you the details in DMs 📩',
      'dropped it in your DMs ✅',
    ],
  },
  {
    name: 'Krater',
    keyword: 'krater',
    link: 'https://krater.ai/?amb=f9200c6e&coupon=KOKA15&utm_source=affiliate',
    hookDm:
      'Yo! 🙌 Krater = the AI SuperApp I use — ChatGPT, Claude, Midjourney, Runway, Suno all in ONE sub (350+ models). I got you 15% off — tap below ⚡',
    dmTemplate:
      'here it is 🤝 15% off your first month with my code KOKA15:\n{link}\n\nTry it and tell me what you make 👀',
    linkCardText:
      'here it is 🤝 15% off your first month with my code KOKA15.\n\nTry it and tell me what you make 👀',
    linkButtonTitle: 'Get 15% off 🔥',
    publicReplies: [
      'just slid into your DMs — got you 15% off 📩',
      'check your DMs 👀 sent you the Krater code',
      'in your DMs with the discount 📩',
      'dropped the details in your DMs ✅',
    ],
  },
];

// ── Editable config (admin UI at /admin) ───────────────────────────────────
// Everything above (handle, button labels, gate copy, campaigns) is only the
// DEFAULT. The live values are read from KV key `config`, editable in the
// browser at /admin (protected by the ADMIN_KEY secret) — no redeploy needed.
type FunnelConfig = {
  myHandle: string;
  myProfileUrl: string;
  btnTitle: string;
  followBtnTitle: string;
  gateDm: string;
  gateNudge: string;
  campaigns: Campaign[];
};

const DEFAULT_CONFIG: FunnelConfig = {
  myHandle: MY_HANDLE,
  myProfileUrl: MY_PROFILE_URL,
  btnTitle: BTN_TITLE,
  followBtnTitle: FOLLOW_BTN_TITLE,
  gateDm: GATE_DM_DEFAULT,
  gateNudge: GATE_NUDGE,
  campaigns: CAMPAIGNS,
};

// Live config, refreshed from KV at most every 15s (module state survives
// across invocations in a warm isolate, so this is nearly always warm).
let CFG: FunnelConfig = DEFAULT_CONFIG;
let cfgLoadedAt = 0;

async function loadFunnelConfig(env: Env): Promise<void> {
  if (Date.now() - cfgLoadedAt < 15000) return;
  cfgLoadedAt = Date.now();
  try {
    const raw = await env.STATE.get('config');
    if (!raw) { CFG = DEFAULT_CONFIG; return; }
    const j = JSON.parse(raw);
    CFG = {
      ...DEFAULT_CONFIG,
      ...j,
      campaigns: Array.isArray(j.campaigns) && j.campaigns.length ? j.campaigns : DEFAULT_CONFIG.campaigns,
    };
  } catch {
    CFG = DEFAULT_CONFIG;
  }
}

// Campaign colors for the dashboard — assigned by position, so custom
// campaigns added in /admin get a color automatically.
const PALETTE = ['#7c3aed', '#0a66ff', '#0f9d58', '#e37400', '#d81b60', '#00897b'];
function campaignColor(name?: string): string {
  const idx = CFG.campaigns.findIndex((c) => c.name === name);
  return PALETTE[(idx >= 0 ? idx : 0) % PALETTE.length];
}

interface Env {
  STATE: KVNamespace;
  COMPOSIO_API_KEY: string;
  // Secret protecting the /admin page — set it once with:
  //   npx wrangler secret put ADMIN_KEY
  ADMIN_KEY?: string;
  COMPOSIO_USER_ID?: string;
  MAX_PER_HOUR?: string;
  PER_RUN_CAP?: string;
  SCAN_POSTS?: string;
  MAX_AGE_DAYS?: string;
  REPLY_PUBLICLY?: string;
  LOOP_SECONDS?: string;           // how long each cron tick keeps polling (default 56)
  CLICK_GAP_MS?: string;           // gap between click checks (default 2500 ⇒ ~3s tap latency)
  SCAN_INTERVAL_MS?: string;       // full comment scan at most this often (default 18000)
  // Follow gate / funnel knobs.
  FOLLOW_GATE?: string;            // 'true' = require following before the link is sent
  GATE_FAIL_OPEN?: string;         // if the follow check errors: 'true' = send the link anyway
  RECHECK_PER_RUN?: string;        // gated users re-checked per poll (default 3)
  // Optional fallback transport for raw Graph API calls (proxy-execute scoped
  // Composio key). Only needed if direct token recovery ever breaks:
  //   npx wrangler secret put COMPOSIO_PROXY_API_KEY
  COMPOSIO_PROXY_API_KEY?: string;
  CONNECTED_ACCOUNT_ID?: string;   // Composio connected account (ca_…), for the proxy fallback
}

type Entry = {
  comment_id: string;
  campaign: string;        // which campaign matched (for the dashboard)
  from: string;
  from_id?: string;
  commentText: string;
  at: string;
  permalink?: string;
  dm_text: string;
  dm_status: 'sent' | 'failed' | 'skipped' | 'gated';
  dm_error?: string;
  public_reply?: string;
  public_status?: 'sent' | 'failed' | 'skipped';
  // Funnel step this entry records: hook = button sent, gate = told to follow,
  // link = campaign link delivered. Old entries have none (pre-funnel).
  step?: 'hook' | 'gate' | 'link';
  follow_check?: 'follows' | 'not_following' | 'unknown';
};

// Someone in the funnel, keyed `awaiting:{from_id}` in KV. TTL 7 days —
// the private-message window tied to their comment.
type Awaiting = {
  campaign: string;
  from: string;
  from_id: string;
  comment_id: string;
  commentText: string;
  permalink?: string;
  at: string;              // when they entered the funnel (hook sent)
  stage: 'hook' | 'gated';
  lastGateAt?: string;     // last time we sent the "follow me first" DM
  lastCheck?: string;      // last passive follow re-check (stage 'gated')
};

function cfg(env: Env) {
  return {
    maxPerHour: Number(env.MAX_PER_HOUR || 10),
    perRunCap: Number(env.PER_RUN_CAP || 5),
    scanPosts: Number(env.SCAN_POSTS || 6),
    maxAgeDays: Number(env.MAX_AGE_DAYS || 7),
    replyPublicly: env.REPLY_PUBLICLY !== 'false',
    followGate: env.FOLLOW_GATE !== 'false',
    gateFailOpen: env.GATE_FAIL_OPEN !== 'false',
    recheckPerRun: Number(env.RECHECK_PER_RUN || 3),
  };
}

// Cloudflare caps outgoing fetches per invocation: 50 on the FREE plan (which
// this account stays on — that's the whole point), 1000 on paid. The budget
// stops the loop a few calls short of the cap; reset every cron tick.
let SUBREQ = 0;
const SUBREQ_BUDGET = 44;

// Calls a Composio tool over its REST API (the Node SDK can't run on Workers).
async function callTool(env: Env, slug: string, args: Record<string, unknown>): Promise<any> {
  SUBREQ++;
  const r = await fetch(`${TOOLS_URL}/${slug}`, {
    method: 'POST',
    headers: { 'x-api-key': env.COMPOSIO_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: env.COMPOSIO_USER_ID || 'instagram-reels-analytics', arguments: args }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(`${slug}: ${j?.error?.message || j?.error || `HTTP ${r.status}`}`);
  return j.data;
}

// ── Raw Instagram Graph API access ─────────────────────────────────────────
// Composio's tool responses include Graph paging URLs that carry the connected
// account's access token and IG user id — recover both so the worker can call
// endpoints Composio has no tool for (quick replies, conversation messages,
// the follow check). Cached ~25 min in KV; re-fetched on auth errors.
type IgAuth = { token: string; igUserId: string };

async function getIgAuth(env: Env, forceFresh = false): Promise<IgAuth | null> {
  if (!forceFresh) {
    const cached = await env.STATE.get('igauth');
    if (cached) {
      try { return JSON.parse(cached); } catch { /* refetch below */ }
    }
  }
  try {
    const r: any = await callTool(env, 'INSTAGRAM_LIST_ALL_CONVERSATIONS', { limit: 1 });
    const next: string = r?.paging?.next || r?.data?.paging?.next || '';
    const token = /[?&]access_token=([^&]+)/.exec(next)?.[1];
    const igUserId = /instagram\.com\/v[\d.]+\/(\d+)\//.exec(next)?.[1];
    if (!token || !igUserId) return null;
    const auth: IgAuth = { token, igUserId };
    await env.STATE.put('igauth', JSON.stringify(auth), { expirationTtl: 1500 });
    return auth;
  } catch (e) {
    console.log('igauth recovery failed', (e as Error).message);
    return null;
  }
}

// One entry point for every raw Graph call. Tries the recovered token first,
// retries once on an expired token, then falls back to the Composio proxy if
// a proxy-scoped key is configured. Throws when no transport works.
async function graphReq(env: Env, method: 'GET' | 'POST', pathWithQuery: string, body?: unknown): Promise<any> {
  let lastError = 'no Instagram API transport available';

  for (const fresh of [false, true]) {
    const auth = await getIgAuth(env, fresh);
    if (!auth) break;
    const sep = pathWithQuery.includes('?') ? '&' : '?';
    SUBREQ++;
    const r = await fetch(`${GRAPH}${pathWithQuery}${sep}access_token=${auth.token}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const j: any = await r.json().catch(() => ({}));
    if (r.ok && !j?.error) return j;
    lastError = j?.error?.message || `HTTP ${r.status}`;
    const expired = j?.error?.code === 190 || r.status === 401;
    if (!expired) break;          // real error — a fresh token won't fix it
    await env.STATE.delete('igauth');
  }

  if (env.COMPOSIO_PROXY_API_KEY && env.CONNECTED_ACCOUNT_ID) {
    SUBREQ++;
    const r = await fetch('https://backend.composio.dev/api/v3.1/tools/execute/proxy', {
      method: 'POST',
      headers: { 'x-api-key': env.COMPOSIO_PROXY_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        connected_account_id: env.CONNECTED_ACCOUNT_ID,
        endpoint: `/v21.0${pathWithQuery}`,
        method,
        ...(body ? { body } : {}),
      }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (r.ok && !j?.error) return j?.data ?? j;
    lastError = j?.error?.message || `proxy HTTP ${r.status}`;
  }

  throw new Error(lastError);
}

// ── Follow check ────────────────────────────────────────────────────────────
// "Does this person follow the account?" via `is_user_follow_business` —
// the exact field ManyChat's follow gate reads.
async function checkFollows(env: Env, igsid: string): Promise<{ follows: boolean | null; error?: string }> {
  try {
    const j = await graphReq(env, 'GET', `/${igsid}?fields=is_user_follow_business,username`);
    const found = deepFind(j, 'is_user_follow_business');
    if (typeof found === 'boolean') return { follows: found };
    return { follows: null, error: 'is_user_follow_business missing from profile response' };
  } catch (e) {
    return { follows: null, error: (e as Error).message };
  }
}

// Depth-first search for a key anywhere in a nested JSON payload.
function deepFind(obj: any, key: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const hit = deepFind(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// ── DM senders ──────────────────────────────────────────────────────────────
// Rich DM: text + buttons rendered INSIDE the bubble (sorhan/ManyChat style),
// via the Messenger button template. Instagram support for template flavors
// varies, so we cascade through shapes and remember the first one that works
// (KV `dmshape`) to keep later sends single-request fast:
//   1. button template + quick-reply chip (belt & suspenders for tap detection)
//   2. button template alone
//   3. generic template (card with title + buttons)
//   4. plain text + quick-reply chip
//   5. plain text via the Composio tool ("reply link" hint)
// A postback tap shows up as a user message in the thread, a typed reply
// obviously does too — either way the polling loop sees the click.
type DmButton = { title: string; url?: string };   // url → web_url button, else postback

function buttonPayload(buttons: DmButton[]) {
  return buttons.map((b) =>
    b.url
      ? { type: 'web_url', title: b.title, url: b.url }
      : { type: 'postback', title: b.title, payload: 'SEND_LINK' }
  );
}

async function sendButtonDm(
  env: Env,
  to: { userId?: string; commentId?: string },
  text: string,
  buttons: DmButton[],
  // Plain-text version sent via Composio if no rich shape goes through. The
  // default nudges a typed reply; the link card overrides this with the real link.
  fallbackText = `${text}\n\nreply "link" and I'll send it over`
): Promise<{ ok: boolean; error?: string }> {
  const recipient = to.commentId ? { comment_id: to.commentId } : { id: to.userId };
  const chip = buttons.find((b) => !b.url);
  const quickReplies = chip
    ? [{ content_type: 'text', title: chip.title, payload: 'SEND_LINK' }]
    : undefined;

  const template = {
    type: 'template',
    payload: { template_type: 'button', text: text.slice(0, 640), buttons: buttonPayload(buttons) },
  };
  const generic = {
    type: 'template',
    payload: {
      template_type: 'generic',
      elements: [{ title: text.slice(0, 80), subtitle: text.slice(80, 160) || undefined, buttons: buttonPayload(buttons) }],
    },
  };

  // notification_type=REGULAR explicitly asks for a push notification; shapes
  // without it remain in the cascade in case Instagram rejects the param.
  const candidates: Array<{ shape: string; message: Record<string, unknown>; notify?: boolean }> = [
    { shape: 'button+chip', message: { attachment: template, quick_replies: quickReplies }, notify: true },
    { shape: 'button', message: { attachment: template }, notify: true },
    { shape: 'button-plain', message: { attachment: template } },
    { shape: 'generic', message: { attachment: generic } },
    ...(quickReplies ? [{ shape: 'text+chip', message: { text, quick_replies: quickReplies } }] : []),
  ];
  if (!quickReplies) candidates[0].message = { attachment: template }; // no chip to attach

  // Start from the shape that worked last time (skip known-bad ones).
  const known = await env.STATE.get('dmshape');
  const start = Math.max(0, candidates.findIndex((c) => c.shape === known));

  let lastError = '';
  for (let i = start; i < candidates.length; i++) {
    try {
      await graphReq(env, 'POST', '/me/messages', {
        recipient,
        message: candidates[i].message,
        ...(candidates[i].notify ? { notification_type: 'REGULAR' } : {}),
      });
      if (candidates[i].shape !== known) await env.STATE.put('dmshape', candidates[i].shape);
      return { ok: true };
    } catch (e) {
      lastError = (e as Error).message;
      // Recipient errors (window closed, invalid user) won't be fixed by a
      // different message shape — bail to the Composio fallback right away.
      if (/recipient|window|not found|cannot message/i.test(lastError)) break;
    }
  }

  if (!to.userId) return { ok: false, error: lastError };
  try {
    await callTool(env, 'INSTAGRAM_SEND_TEXT_MESSAGE', {
      recipient_id: to.userId,
      text: fallbackText,
    });
    return { ok: true };
  } catch (e2) {
    return { ok: false, error: `graph: ${lastError} · composio: ${(e2 as Error).message}` };
  }
}

function gateDmText(campaign: Campaign): string {
  return (campaign.gateDmTemplate || CFG.gateDm).replace('{keyword}', campaign.keyword);
}

function pickFrom(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)];
}

// Find the first campaign whose keyword appears in the comment text.
// @mentions are stripped first so the account's own handle (e.g. @kokabuildsf,
// which literally contains "build") never triggers a false match.
function findCampaign(text: string): Campaign | undefined {
  const cleaned = text.replace(/@[\w.]+/g, ' ').toLowerCase();
  return CFG.campaigns.find((c) => cleaned.includes(c.keyword.toLowerCase()));
}

// KV write that can't crash the funnel. Returns false on failure (e.g. the
// free plan's 1,000 writes/day quota) — callers use that to SKIP side effects
// that must never happen without their dedupe marker being persisted first.
async function kvPutSafe(env: Env, key: string, value: string, opts?: { expirationTtl?: number }): Promise<boolean> {
  try {
    await env.STATE.put(key, value, opts);
    return true;
  } catch (e) {
    console.log('KV put failed', key, (e as Error).message);
    return false;
  }
}

async function pushLog(env: Env, entry: Entry) {
  try {
    const log: Entry[] = JSON.parse((await env.STATE.get('log')) || '[]');
    log.unshift(entry);
    await env.STATE.put('log', JSON.stringify(log.slice(0, 500)));
  } catch (e) {
    console.log('pushLog failed', (e as Error).message);
  }
}

// Shared hourly budget across all DM types (hook, gate, link).
type HourBudget = { key: string; count: number };

async function bumpHour(env: Env, h: HourBudget) {
  h.count++;
  await kvPutSafe(env, h.key, String(h.count), { expirationTtl: 7200 });
}

async function saveAwaiting(env: Env, aw: Awaiting): Promise<boolean> {
  // KV can't extend TTL in place — re-put with whatever remains of the 7-day window.
  const remaining = Math.max(60, Math.floor((new Date(aw.at).getTime() + 7 * 86400000 - Date.now()) / 1000));
  return kvPutSafe(env, `awaiting:${aw.from_id}`, JSON.stringify(aw), { expirationTtl: remaining });
}

// Deliver the campaign link (funnel finish line) and clean up state.
// Sent as a card with a link button (sorhan style); sendButtonDm falls back to
// plain text with the raw link if templates aren't accepted.
async function deliverLink(
  env: Env,
  h: HourBudget,
  aw: Awaiting,
  followCheck: Entry['follow_check']
): Promise<void> {
  const campaign = CFG.campaigns.find((x) => x.name === aw.campaign) || CFG.campaigns[0];
  const dmText = campaign.dmTemplate.replace('{link}', campaign.link);
  const res = await sendButtonDm(
    env,
    { userId: aw.from_id },
    campaign.linkCardText,
    [{ title: campaign.linkButtonTitle, url: campaign.link }],
    dmText // plain-text fallback carries the raw link
  );
  await pushLog(env, {
    comment_id: aw.comment_id,
    campaign: campaign.name,
    from: aw.from,
    from_id: aw.from_id,
    commentText: aw.commentText,
    at: new Date().toISOString(),
    permalink: aw.permalink,
    dm_text: dmText,
    dm_status: res.ok ? 'sent' : 'failed',
    dm_error: res.error,
    step: 'link',
    follow_check: followCheck,
  });
  if (res.ok) {
    try {
      await env.STATE.delete(`awaiting:${aw.from_id}`);
    } catch (e) {
      console.log('awaiting delete failed', (e as Error).message);
    }
    await bumpHour(env, h);
  }
}

async function loadHour(env: Env): Promise<HourBudget> {
  const key = `hour:${new Date().toISOString().slice(0, 13)}`;
  return { key, count: Number(await env.STATE.get(key)) || 0 };
}

// ── Click poll: button taps only — ONE API call, runs every ~2.5s ──────────
async function pollClicks(env: Env): Promise<number> {
  await loadFunnelConfig(env);
  const c = cfg(env);
  const h = await loadHour(env);
  return handleClicks(env, c, h);
}

// ── Scan poll: keyword comments → hook DM, plus passive follow re-checks. ──
// Heavier (~8 API calls), runs every ~18s — in the BACKGROUND, so it never
// delays a click response.
async function pollScan(env: Env): Promise<{ handled: number; matched: number; unlocked: number; error?: string }> {
  await loadFunnelConfig(env);
  const c = cfg(env);
  const h = await loadHour(env);

  let handled = 0;
  let matched = 0;
  let unlocked = 0;
  let error: string | undefined;

  if (h.count < c.maxPerHour) {
    let media: any[] = [];
    try {
      const mediaRes = await callTool(env, 'INSTAGRAM_GET_USER_MEDIA', { limit: c.scanPosts });
      media = mediaRes?.data ?? [];
    } catch (e) {
      error = (e as Error).message;
    }

    const tooOld = Date.now() - c.maxAgeDays * 86400000;

    // Fetch every post's comments in parallel — cuts a serial ~8s scan to ~2s.
    const commentsByPost = await Promise.all(
      media.map((post) =>
        callTool(env, 'INSTAGRAM_GET_POST_COMMENTS', { ig_post_id: post.id, limit: 50 })
          .then((cr: any) => ({ post, comments: (cr?.data ?? []) as any[] }))
          .catch(() => ({ post, comments: [] as any[] }))
      )
    );

    for (const { post, comments } of commentsByPost) {
      if (handled >= c.perRunCap || h.count >= c.maxPerHour) break;

      for (const cm of comments) {
        if (handled >= c.perRunCap || h.count >= c.maxPerHour) break;

        const text: string = (cm?.text || '').trim();
        const id: string | undefined = cm?.id;
        if (!id || !text) continue;
        const campaign = findCampaign(text);
        if (!campaign) continue;
        const ts = cm?.timestamp ? new Date(cm.timestamp).getTime() : Date.now();
        if (ts < tooOld) continue;

        matched++;
        if (await env.STATE.get(`seen:${id}`)) continue;
        // Mark the comment handled BEFORE messaging anyone: if this write
        // fails (KV daily quota), skipping beats re-DMing them every scan.
        if (!(await kvPutSafe(env, `seen:${id}`, '1', { expirationTtl: 60 * 86400 }))) continue;

        const fromId: string | undefined = cm?.from_user?.id;
        const fromName: string = cm?.from_user?.username || 'unknown';
        const publicReply = c.replyPublicly ? pickFrom(campaign.publicReplies) : undefined;

        const entry: Entry = {
          comment_id: id,
          campaign: campaign.name,
          from: fromName,
          from_id: fromId,
          commentText: text,
          at: new Date().toISOString(),
          permalink: post.permalink,
          dm_text: campaign.hookDm,
          dm_status: 'skipped',
          public_reply: publicReply,
          public_status: publicReply ? 'skipped' : undefined,
          step: 'hook',
        };

        // 1) Hook DM with the quick-reply button. Sent as a private reply to
        //    the comment when possible (that's the one guaranteed message the
        //    API allows per comment).
        if (!fromId && !id) {
          entry.dm_status = 'skipped';
          entry.dm_error = 'no recipient on comment';
        } else {
          const res = await sendButtonDm(env, { userId: fromId, commentId: id }, campaign.hookDm, [
            { title: CFG.btnTitle },
          ]);
          entry.dm_status = res.ok ? 'sent' : 'failed';
          entry.dm_error = res.error;
        }

        // 2) Public reply under their comment.
        if (publicReply) {
          try {
            await callTool(env, 'INSTAGRAM_REPLY_TO_COMMENT', { ig_comment_id: id, message: publicReply });
            entry.public_status = 'sent';
          } catch {
            entry.public_status = 'failed';
          }
        }

        // 3) Remember them: their next message (= button tap) triggers step 2.
        if (entry.dm_status === 'sent' && fromId) {
          const aw: Awaiting = {
            campaign: campaign.name,
            from: fromName,
            from_id: fromId,
            comment_id: id,
            commentText: text,
            permalink: post.permalink,
            at: entry.at,
            stage: 'hook',
          };
          await kvPutSafe(env, `awaiting:${fromId}`, JSON.stringify(aw), { expirationTtl: 7 * 86400 });
        }

        await pushLog(env, entry);
        if (entry.dm_status === 'sent') await bumpHour(env, h);
        handled++;
      }
    }
  }

  // Gated people who followed since (no re-tap needed).
  if (c.followGate) {
    try {
      unlocked = await recheckGated(env, c, h);
    } catch (e) {
      console.log('recheckGated error', (e as Error).message);
    }
  }

  return { handled, matched, unlocked, error };
}

// Full cycle — used by the manual GET /run route.
async function poll(env: Env): Promise<{ handled: number; matched: number; clicks: number; unlocked: number; error?: string }> {
  let clicks = 0;
  try {
    clicks = await pollClicks(env);
  } catch (e) {
    console.log('handleClicks error', (e as Error).message);
  }
  const scan = await pollScan(env);
  return { clicks, ...scan };
}

// ── Step 2: detect the "click" and gate on follow status ───────────────────
// A quick-reply tap arrives as a normal message from the user, so polling the
// conversation feed catches it. Any message from someone in the funnel counts
// (people often type "yes"/"link" instead of tapping — same intent).

// Last successful conversation sweep (module memory — see comment in the
// function; deliberately NOT in KV).
let lastSweepMem = 0;
async function handleClicks(env: Env, c: ReturnType<typeof cfg>, h: HourBudget): Promise<number> {
  const inFunnel = await env.STATE.list({ prefix: 'awaiting:', limit: 1 });
  if (inFunnel.keys.length === 0) return 0;

  const auth = await getIgAuth(env);
  if (!auth && !(env.COMPOSIO_PROXY_API_KEY && env.CONNECTED_ACCOUNT_ID)) {
    console.log('handleClicks: no Graph transport — cannot read conversations');
    return 0;
  }

  // Only look at conversations that moved since the last sweep (90s margin —
  // ticks overlap is fine, msgseen dedupes). Kept in MEMORY, not KV: this runs
  // ~20x/min and KV's free plan only allows 1,000 writes per DAY. A cold
  // isolate just re-inspects the last hour; msgseen dedupes the overlap.
  const lastSweep = lastSweepMem || Date.now() - 3600000;
  const cutoff = lastSweep - 90000;
  let acted = 0;
  let capped = false;

  // ONE round trip for everything: conversations + their latest messages come
  // back together, so a tap is detected in a single API call.
  let msgsByConv: any[][] = [];
  try {
    // Kept lean (8 convs × 4 msgs) — this exact call runs every ~2s, and its
    // round-trip time IS the tap latency floor.
    const j = await graphReq(
      env,
      'GET',
      '/me/conversations?fields=updated_time,messages.limit(4){id,from,message,created_time}&limit=8'
    );
    const convs: any[] = j?.data ?? [];
    msgsByConv = convs
      .filter((conv) => {
        const updated = conv?.updated_time ? new Date(conv.updated_time).getTime() : 0;
        return updated >= cutoff;
      })
      .map((conv) => (conv?.messages?.data ?? []) as any[]);
  } catch (e) {
    console.log('conversation sweep failed', (e as Error).message);
    return 0;
  }

  for (const msgs of msgsByConv) {
    if (h.count >= c.maxPerHour) { capped = true; break; }

    for (const m of msgs) {
      if (h.count >= c.maxPerHour) { capped = true; break; }
      const fromId: string | undefined = m?.from?.id;
      if (!m?.id || !fromId) continue;
      if (auth && fromId === auth.igUserId) continue;            // our own messages

      const rawAw = await env.STATE.get(`awaiting:${fromId}`);
      if (!rawAw) continue;
      let aw: Awaiting;
      try { aw = JSON.parse(rawAw); } catch { continue; }

      const sentAt = m?.created_time ? new Date(m.created_time).getTime() : 0;
      if (sentAt <= new Date(aw.at).getTime()) continue;         // predates the funnel
      if (await env.STATE.get(`msgseen:${m.id}`)) continue;
      // Dedupe marker MUST be persisted before we act — if KV writes are down
      // (daily quota), skip rather than risk answering the same tap forever.
      if (!(await kvPutSafe(env, `msgseen:${m.id}`, '1', { expirationTtl: 3 * 86400 }))) continue;

      // The click. Follower → link. Not following → gate (with the button again).
      let follows: boolean | null = null;
      let followCheck: Entry['follow_check'] = 'unknown';
      if (!c.followGate || (await env.STATE.get(`follower:${fromId}`))) {
        follows = true;
        followCheck = 'follows';
      } else {
        const res = await checkFollows(env, fromId);
        follows = res.follows;
        followCheck = res.follows === true ? 'follows' : res.follows === false ? 'not_following' : 'unknown';
        if (res.follows === true) await env.STATE.put(`follower:${fromId}`, '1', { expirationTtl: 30 * 86400 });
        if (res.follows === null) console.log('follow check failed', fromId, res.error);
      }

      if (follows === true || (follows === null && c.gateFailOpen)) {
        await deliverLink(env, h, aw, followCheck);
        acted++;
      } else {
        // First time → full gate message. Tapping again while still not
        // following → short nudge. Both rate-limited so rapid taps don't spam.
        const sinceGate = aw.lastGateAt ? Date.now() - new Date(aw.lastGateAt).getTime() : Infinity;
        if (sinceGate >= GATE_RESEND_MS) {
          const campaign = CFG.campaigns.find((x) => x.name === aw.campaign) || CFG.campaigns[0];
          const gateText = aw.stage === 'gated' ? CFG.gateNudge : gateDmText(campaign);
          const res = await sendButtonDm(env, { userId: fromId }, gateText, [
            { title: FOLLOW_BTN_TITLE, url: MY_PROFILE_URL },
            { title: CFG.btnTitle },
          ]);
          aw.stage = 'gated';
          aw.lastGateAt = new Date().toISOString();
          await saveAwaiting(env, aw);
          await pushLog(env, {
            comment_id: aw.comment_id,
            campaign: aw.campaign,
            from: aw.from,
            from_id: fromId,
            commentText: aw.commentText,
            at: aw.lastGateAt,
            permalink: aw.permalink,
            dm_text: gateText,
            dm_status: res.ok ? 'gated' : 'failed',
            dm_error: res.error,
            step: 'gate',
            follow_check: followCheck,
          });
          if (res.ok) await bumpHour(env, h);
          acted++;
        }
      }
    }
  }

  // If the hourly cap cut the sweep short, keep the cursor where it was so
  // unprocessed taps are retried next tick instead of silently skipped.
  if (!capped) lastSweepMem = Date.now();
  return acted;
}

// ── Step 3: gated users who followed since ─────────────────────────────────
// How long to wait between two passive follow checks on the same person.
// 60s keeps "followed but never tapped again" people from waiting long.
const RECHECK_COOLDOWN_MS = 60 * 1000;

async function recheckGated(env: Env, c: ReturnType<typeof cfg>, h: HourBudget): Promise<number> {
  if (h.count >= c.maxPerHour) return 0;
  const list = await env.STATE.list({ prefix: 'awaiting:', limit: 100 });
  let delivered = 0;
  let checked = 0;

  for (const key of list.keys) {
    if (checked >= c.recheckPerRun || h.count >= c.maxPerHour) break;
    const raw = await env.STATE.get(key.name);
    if (!raw) continue;
    let aw: Awaiting;
    try { aw = JSON.parse(raw); } catch { await env.STATE.delete(key.name); continue; }
    if (aw.stage !== 'gated') continue;   // only people we explicitly told to follow
    if (aw.lastCheck && Date.now() - new Date(aw.lastCheck).getTime() < RECHECK_COOLDOWN_MS) continue;

    checked++;
    // Stamp the attempt BEFORE doing anything: if this write fails (KV daily
    // quota), skip — otherwise a failed cleanup later would re-send the link
    // to the same person every minute.
    aw.lastCheck = new Date().toISOString();
    if (!(await saveAwaiting(env, aw))) continue;

    const res = await checkFollows(env, aw.from_id);
    if (res.follows !== true) continue;

    // They followed → unlock. The messaging window is open (they messaged us
    // at the gate step), so the link DM goes straight through.
    await kvPutSafe(env, `follower:${aw.from_id}`, '1', { expirationTtl: 30 * 86400 });
    await deliverLink(env, h, aw, 'follows');
    delivered++;
  }
  return delivered;
}

// ── Dashboard ───────────────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return (s || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

function dashboard(log: Entry[]): string {
  // Pre-funnel entries (no `step`) were direct link sends — count them as links.
  const stepOf = (e: Entry) => e.step || 'link';
  const links = log.filter((e) => stepOf(e) === 'link' && e.dm_status === 'sent').length;
  const hooks = log.filter((e) => stepOf(e) === 'hook' && e.dm_status === 'sent').length;
  const gatedCount = log.filter((e) => stepOf(e) === 'gate' && e.dm_status === 'gated').length;
  const failed = log.filter((e) => e.dm_status === 'failed').length;
  const last24h = log.filter((e) => Date.now() - new Date(e.at).getTime() < 86400000).length;

  // Pre-multi-campaign entries have no `campaign` field; they were all Emergent,
  // so fold them under the first campaign. Same logic in camBadge below.
  const tagOf = (e: Entry) => e.campaign || CFG.campaigns[0].name;
  const perCampaign = CFG.campaigns.map((c) => {
    const n = log.filter((e) => tagOf(e) === c.name && stepOf(e) === 'link' && e.dm_status === 'sent').length;
    const col = campaignColor(c.name);
    return `<div class="stat" style="border-left:4px solid ${col}"><div class="v">${n}</div><div class="k">${escapeHtml(c.name)} · "${escapeHtml(c.keyword)}"</div></div>`;
  }).join('');

  const stepBadge = (e: Entry) => {
    const m: Record<string, [string, string]> = {
      hook: ['📩 button sent', 'b-purple'],
      gate: ['🔒 follow gate', 'b-amber'],
      link: ['🔗 link delivered', 'b-green'],
    };
    const [l, cls] = m[stepOf(e)] || ['', 'b-muted'];
    return `<span class="badge ${cls}">${l}</span>`;
  };

  const badge = (s?: string) => {
    const m: Record<string, [string, string]> = {
      sent: ['✓ sent', 'b-green'],
      failed: ['✗ failed', 'b-red'],
      skipped: ['– skipped', 'b-muted'],
      gated: ['✓ sent', 'b-green'],   // the gate DM itself went out fine
    };
    const [l, cls] = m[s || ''] || ['?', 'b-muted'];
    return `<span class="badge ${cls}">${l}</span>`;
  };

  const followBadge = (f?: Entry['follow_check']) => {
    if (!f) return '';
    const m: Record<string, [string, string]> = {
      follows: ['👥 follower', 'b-green'],
      not_following: ['👤 not following', 'b-amber'],
      unknown: ['? check failed', 'b-muted'],
    };
    const [l, cls] = m[f] || ['', 'b-muted'];
    return l ? `<span class="badge ${cls}">${l}</span>` : '';
  };

  const rows = log
    .map(
      (e) => `<div class="row">
      <div class="row-meta">${camBadge(tagOf(e))}<span class="from">@${escapeHtml(e.from)}</span>${stepBadge(e)}${badge(e.dm_status)}${followBadge(e.follow_check)}<span class="time" data-iso="${escapeHtml(e.at)}">${escapeHtml(e.at)}</span>${e.permalink ? `<a class="post" href="${escapeHtml(e.permalink)}" target="_blank" rel="noopener">📍 reel ↗</a>` : ''}</div>
      <div class="comment">${escapeHtml(e.commentText)}</div>
      <div class="dm">${escapeHtml(e.dm_text)}</div>
      ${e.public_reply ? `<div class="public">${escapeHtml(e.public_reply)} ${e.public_status === 'sent' ? '<span class="ok">✓ posted</span>' : e.public_status === 'failed' ? '<span class="no">✗ failed</span>' : ''}</div>` : ''}
      ${e.dm_error ? `<div class="err">⚠ ${escapeHtml(e.dm_error)}</div>` : ''}
    </div>`
    )
    .join('');

  function camBadge(name?: string) {
    if (!name) return '';
    const col = campaignColor(name);
    return `<span class="cam" style="background:${col}20;color:${col}">${escapeHtml(name)}</span>`;
  }

  const campaignsList = CFG.campaigns.map((c) => `"${c.keyword}" → ${c.name}`).join(' · ');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Comment → DM funnel</title>
<style>
  :root{--bg:#f5f5f7;--card:#fff;--ink:#0d1117;--muted:#5a6271;--line:#e8e8ec;--green:#197043;--red:#a02323}
  *{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;max-width:900px;margin:32px auto 60px;padding:0 24px;color:var(--ink);background:var(--bg);line-height:1.5}
  h1{font-size:26px;margin:0 0 4px}.sub{color:var(--muted);font-size:13px;margin-bottom:20px}
  a{color:#0a66ff;text-decoration:none}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:24px}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 14px}
  .stat .v{font-size:26px;font-weight:700}.stat .k{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-top:4px;font-weight:600}
  .stat.feature{background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff}.stat.feature .k{color:rgba(255,255,255,.85)}
  .row{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin-bottom:8px}
  .row-meta{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:11px;color:var(--muted);margin-bottom:8px}
  .from{font-weight:700;color:var(--ink);font-size:14px}.post{background:#eef0f3;padding:2px 8px;border-radius:6px;color:var(--muted)}
  .cam{font-size:11px;font-weight:700;padding:2px 9px;border-radius:99px}
  .comment{font-size:13px;color:var(--muted);padding-left:10px;border-left:3px solid var(--line);margin-bottom:8px}.comment::before{content:'💬 '}
  .dm{font-size:14px;padding:8px 12px;background:linear-gradient(90deg,#f3e8ff,#faf5ff);border-left:3px solid #7c3aed;border-radius:0 6px 6px 0;white-space:pre-wrap}.dm::before{content:'📩 '}
  .public{font-size:14px;padding:8px 12px;margin-top:6px;background:linear-gradient(90deg,#e6f7ee,#f0f9f4);border-left:3px solid var(--green);border-radius:0 6px 6px 0}.public::before{content:'💬 public reply: ';color:var(--green);font-weight:600}
  .public .ok{color:var(--green);font-weight:600}.public .no{color:var(--red);font-weight:600}
  .err{font-size:11px;color:var(--red);margin-top:6px}
  .badge{font-size:11px;font-weight:700;padding:2px 9px;border-radius:99px}.b-green{background:#e6f7ee;color:var(--green)}.b-red{background:#fdecec;color:var(--red)}.b-muted{background:#eef0f3;color:var(--muted)}.b-amber{background:#fdf3e0;color:#b45309}.b-purple{background:#f3e8ff;color:#7c3aed}
  .empty{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:40px;text-align:center;color:var(--muted)}
</style></head><body>
<h1>🚀 Comment → DM funnel <span style="font-size:13px;color:#7c3aed;font-weight:600">· instant (~15s)</span> <a href="/admin" style="float:right;font-size:13px;font-weight:600">⚙️ settings</a></h1>
<div class="sub">Cloudflare Worker · ${CFG.campaigns.length} campaign${CFG.campaigns.length > 1 ? 's' : ''}: ${escapeHtml(campaignsList)} · flow: comment → 📩 button → 🔒 follow gate → 🔗 link</div>
<div class="stats">
  <div class="stat feature"><div class="v">${links}</div><div class="k">🔗 Links delivered</div></div>
  ${perCampaign}
  <div class="stat" style="border-left:4px solid #7c3aed"><div class="v">${hooks}</div><div class="k">📩 Buttons sent</div></div>
  <div class="stat" style="border-left:4px solid #b45309"><div class="v">${gatedCount}</div><div class="k">🔒 Told to follow</div></div>
  <div class="stat"><div class="v">${last24h}</div><div class="k">Activity (24h)</div></div>
  <div class="stat"><div class="v">${failed}</div><div class="k">Failed</div></div>
</div>
${log.length === 0 ? `<div class="empty"><strong>No keyword comments handled yet.</strong><p>Polling every minute. Comment any of the keywords on a recent reel and it'll appear here within ~15s.</p></div>` : rows}
<script>
document.querySelectorAll('[data-iso]').forEach(el=>{const d=new Date(el.getAttribute('data-iso'));el.textContent=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(d);el.title=d.toString();});
setTimeout(()=>location.reload(),60000);
</script>
</body></html>`;
}

// ── Admin UI: edit campaigns / links / copy in the browser, no redeploy ────
function adminAuthorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_KEY) return false;
  return request.headers.get('x-admin-key') === env.ADMIN_KEY;
}

// Validate + normalize a config payload coming from the admin form.
function sanitizeConfig(input: any): FunnelConfig | { error: string } {
  const str = (v: any, max: number, fallback = '') => (typeof v === 'string' ? v.slice(0, max).trim() : fallback);
  const campaigns: Campaign[] = [];
  if (!Array.isArray(input?.campaigns) || input.campaigns.length === 0) return { error: 'at least one campaign required' };
  if (input.campaigns.length > 10) return { error: 'max 10 campaigns' };
  for (const c of input.campaigns) {
    const name = str(c?.name, 40);
    const keyword = str(c?.keyword, 40).toLowerCase();
    const link = str(c?.link, 500);
    if (!name || !keyword) return { error: 'each campaign needs a name and a keyword' };
    if (!/^https:\/\//.test(link)) return { error: `campaign "${name}": link must start with https://` };
    const publicReplies = (Array.isArray(c?.publicReplies) ? c.publicReplies : String(c?.publicReplies || '').split('|'))
      .map((s: any) => String(s).slice(0, 200).trim())
      .filter(Boolean)
      .slice(0, 8);
    campaigns.push({
      name,
      keyword,
      link,
      hookDm: str(c?.hookDm, 640) || DEFAULT_CONFIG.campaigns[0].hookDm,
      dmTemplate: str(c?.dmTemplate, 900) || `here it is 🤝 {link}`,
      linkCardText: str(c?.linkCardText, 640) || str(c?.dmTemplate, 640) || 'here it is 🤝',
      linkButtonTitle: str(c?.linkButtonTitle, 30) || 'Open the link ⚡',
      publicReplies: publicReplies.length ? publicReplies : ['check your DMs 👀'],
    });
  }
  return {
    myHandle: str(input?.myHandle, 40, DEFAULT_CONFIG.myHandle),
    myProfileUrl: /^https:\/\/(www\.)?instagram\.com\//.test(input?.myProfileUrl || '')
      ? str(input.myProfileUrl, 120)
      : DEFAULT_CONFIG.myProfileUrl,
    btnTitle: str(input?.btnTitle, 30, DEFAULT_CONFIG.btnTitle) || DEFAULT_CONFIG.btnTitle,
    followBtnTitle: str(input?.followBtnTitle, 30, DEFAULT_CONFIG.followBtnTitle) || DEFAULT_CONFIG.followBtnTitle,
    gateDm: str(input?.gateDm, 640, DEFAULT_CONFIG.gateDm) || DEFAULT_CONFIG.gateDm,
    gateNudge: str(input?.gateNudge, 640, DEFAULT_CONFIG.gateNudge) || DEFAULT_CONFIG.gateNudge,
    campaigns,
  };
}

const ADMIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Funnel settings</title>
<style>
  :root{--bg:#f5f5f7;--card:#fff;--ink:#0d1117;--muted:#5a6271;--line:#e8e8ec;--accent:#7c3aed}
  *{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;max-width:760px;margin:32px auto 80px;padding:0 20px;background:var(--bg);color:var(--ink);line-height:1.5}
  h1{font-size:24px;margin:0 0 4px}.sub{color:var(--muted);font-size:13px;margin-bottom:20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:14px}
  .card h2{font-size:15px;margin:0 0 12px}
  label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:10px 0 4px}
  input,textarea{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;font:inherit;font-size:14px;background:#fafafa}
  textarea{min-height:64px;resize:vertical}
  input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:-1px;background:#fff}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .btn{display:inline-block;border:0;border-radius:9px;padding:10px 18px;font-weight:700;font-size:14px;cursor:pointer}
  .btn-primary{background:var(--accent);color:#fff}.btn-ghost{background:#eee;color:var(--ink)}.btn-danger{background:#fdecec;color:#a02323}
  .camp{border-left:4px solid var(--accent)}
  .toolbar{position:sticky;bottom:14px;display:flex;gap:10px;justify-content:flex-end;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;box-shadow:0 6px 24px rgba(0,0,0,.08)}
  #toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#0d1117;color:#fff;padding:10px 18px;border-radius:9px;font-size:14px;display:none;z-index:9}
  .hint{font-size:12px;color:var(--muted);margin-top:2px}
  a{color:var(--accent);text-decoration:none}
</style></head><body>
<div id="toast"></div>
<h1>⚙️ Funnel settings</h1>
<div class="sub">Changes go live within ~15 seconds — no redeploy. <a href="/">← back to dashboard</a></div>
<div class="card">
  <h2>🔑 Access</h2>
  <label>Admin key</label><input id="key" type="password" placeholder="your ADMIN_KEY secret">
  <div class="hint">Stored only in this browser. Set it on the worker with: npx wrangler secret put ADMIN_KEY</div>
  <div style="margin-top:10px"><button class="btn btn-primary" onclick="load()">Unlock</button></div>
</div>
<div id="form" style="display:none">
  <div class="card">
    <h2>👤 Account</h2>
    <div class="row2"><div><label>Instagram handle</label><input id="myHandle"></div>
    <div><label>Profile URL</label><input id="myProfileUrl"></div></div>
    <div class="row2"><div><label>Main button label</label><input id="btnTitle"></div>
    <div><label>Follow button label</label><input id="followBtnTitle"></div></div>
  </div>
  <div class="card">
    <h2>🔒 Follow-gate messages</h2>
    <label>Not following yet (first message)</label><textarea id="gateDm"></textarea>
    <label>Still not following (reminder)</label><textarea id="gateNudge"></textarea>
  </div>
  <div id="campaigns"></div>
  <div style="margin:6px 0 16px"><button class="btn btn-ghost" onclick="addCampaign()">+ Add campaign</button></div>
  <div class="toolbar"><button class="btn btn-primary" onclick="save()">💾 Save — live in ~15s</button></div>
</div>
<script>
const F = ['name','keyword','link','hookDm','dmTemplate','linkCardText','linkButtonTitle','publicReplies'];
const LBL = {name:'Campaign name',keyword:'Trigger keyword',link:'Link (https://…)',hookDm:'First DM (with the button — no link in it)',dmTemplate:'Fallback DM text ({link} = the link)',linkCardText:'Final card text',linkButtonTitle:'Link button label',publicReplies:'Public replies (separate with | )'};
const TA = new Set(['hookDm','dmTemplate','linkCardText','publicReplies']);
function toast(m){const t=document.getElementById('toast');t.textContent=m;t.style.display='block';setTimeout(()=>t.style.display='none',2600)}
function campCard(c,i){
  const el=document.createElement('div');el.className='card camp';el.dataset.i=i;
  el.innerHTML='<h2>📣 Campaign <button class="btn btn-danger" style="float:right;padding:4px 10px;font-size:12px" onclick="this.closest(\\'.card\\').remove()">delete</button></h2>'+
    F.map(f=>'<label>'+LBL[f]+'</label>'+(TA.has(f)?'<textarea data-f="'+f+'"></textarea>':'<input data-f="'+f+'">')).join('');
  F.forEach(f=>{const v=c[f];el.querySelector('[data-f='+f+']').value=Array.isArray(v)?v.join(' | '):(v||'')});
  return el;
}
function addCampaign(){document.getElementById('campaigns').appendChild(campCard({},Date.now()))}
async function load(){
  const key=document.getElementById('key').value||localStorage.getItem('adminKey')||'';
  const r=await fetch('/admin/config',{headers:{'x-admin-key':key}});
  if(!r.ok){toast(r.status===401?'wrong key':'error '+r.status);return}
  localStorage.setItem('adminKey',key);
  const cfg=await r.json();
  for(const f of ['myHandle','myProfileUrl','btnTitle','followBtnTitle','gateDm','gateNudge'])document.getElementById(f).value=cfg[f]||'';
  const wrap=document.getElementById('campaigns');wrap.innerHTML='';
  cfg.campaigns.forEach((c,i)=>wrap.appendChild(campCard(c,i)));
  document.getElementById('form').style.display='block';
  toast('loaded ✓');
}
async function save(){
  const out={campaigns:[]};
  for(const f of ['myHandle','myProfileUrl','btnTitle','followBtnTitle','gateDm','gateNudge'])out[f]=document.getElementById(f).value;
  document.querySelectorAll('#campaigns .card').forEach(el=>{
    const c={};F.forEach(f=>c[f]=el.querySelector('[data-f='+f+']').value);
    c.publicReplies=c.publicReplies.split('|').map(s=>s.trim()).filter(Boolean);
    out.campaigns.push(c);
  });
  const r=await fetch('/admin/config',{method:'POST',headers:{'x-admin-key':localStorage.getItem('adminKey')||'','content-type':'application/json'},body:JSON.stringify(out)});
  const j=await r.json().catch(()=>({}));
  toast(r.ok?'saved ✓ live in ~15s':'✗ '+(j.error||('error '+r.status)));
}
if(localStorage.getItem('adminKey')){document.getElementById('key').value=localStorage.getItem('adminKey');load()}
</script></body></html>`;

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cloudflare's minimum cron is 1 minute, so each tick runs a ~56s loop:
    // light polls (button taps — a single API call) every ~2.5s, and a full
    // poll (+ comment scan + follow re-checks) at most every ~18s. The
    // SUBREQ budget stops the loop before the per-invocation fetch cap.
    // Defaults sized so a full minute fits the FREE-plan fetch cap:
    // ~22 click checks (1 call each) + 3 scans (~8 calls) ≈ 46 ≤ 50.
    const loopMs = Math.min(58, Math.max(20, Number(env.LOOP_SECONDS || 56))) * 1000;
    const clickGap = Math.max(1000, Number(env.CLICK_GAP_MS || 2500));
    const scanInterval = Math.max(5000, Number(env.SCAN_INTERVAL_MS || 20000));
    ctx.waitUntil(
      (async () => {
        SUBREQ = 0;
        const start = Date.now();
        let lastScan = 0;
        let scanning: Promise<void> | null = null;
        for (let i = 0; ; i++) {
          // Clicks first, every tick — a tap answers in ~clickGap seconds.
          const tickStart = Date.now();
          try {
            const clicks = await pollClicks(env);
            console.log('clicks', i, `subreq=${SUBREQ}`, clicks);
          } catch (e) {
            console.log('clicks error', (e as Error).message);
          }
          // Comment scan runs in the BACKGROUND so it never delays a tap.
          if (Date.now() - lastScan >= scanInterval && !scanning) {
            lastScan = Date.now();
            scanning = pollScan(env)
              .then((r) => console.log('scan', `subreq=${SUBREQ}`, JSON.stringify(r)))
              .catch((e) => console.log('scan error', (e as Error).message))
              .finally(() => { scanning = null; });
          }
          const remaining = loopMs - (Date.now() - start);
          if (remaining <= clickGap || SUBREQ >= SUBREQ_BUDGET) break;
          // Pace from tick START, not end: the API round trip (~2.5s) already
          // consumed most of the gap, so checks run ~2x as often for free.
          const sleepMs = Math.max(0, clickGap - (Date.now() - tickStart));
          if (sleepMs > 0) await new Promise((res) => setTimeout(res, sleepMs));
        }
        if (scanning) await scanning;
      })()
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    await loadFunnelConfig(env);
    // Manual run for testing: GET /run
    if (url.pathname === '/run') {
      const r = await poll(env);
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
    }
    // Admin UI: edit campaigns, links and copy in the browser (no redeploy).
    if (url.pathname === '/admin') {
      return new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/admin/config') {
      if (!env.ADMIN_KEY) {
        return new Response(JSON.stringify({ error: 'ADMIN_KEY not set — run: npx wrangler secret put ADMIN_KEY' }), {
          status: 503, headers: { 'content-type': 'application/json' },
        });
      }
      if (!adminAuthorized(request, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
      }
      if (request.method === 'POST') {
        let body: any;
        try { body = await request.json(); } catch { body = null; }
        const cfgOrErr = sanitizeConfig(body);
        if ('error' in cfgOrErr) {
          return new Response(JSON.stringify(cfgOrErr), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        if (!(await kvPutSafe(env, 'config', JSON.stringify(cfgOrErr)))) {
          return new Response(JSON.stringify({ error: 'KV write failed (free-plan daily write quota?) — try again after midnight UTC' }), {
            status: 503, headers: { 'content-type': 'application/json' },
          });
        }
        cfgLoadedAt = 0; // this isolate picks it up immediately; others within 15s
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(CFG, null, 2), { headers: { 'content-type': 'application/json' } });
    }
    // Funnel health check: GET /gate-check          → is Graph access working?
    //                      GET /gate-check?igsid=… → live follow check on one user
    if (url.pathname === '/gate-check') {
      const c = cfg(env);
      const auth = await getIgAuth(env);
      const out: Record<string, unknown> = {
        follow_gate: c.followGate,
        fail_open: c.gateFailOpen,
        graph_token_recovered: !!auth,
        ig_user_id: auth?.igUserId || null,
        proxy_fallback_configured: !!(env.COMPOSIO_PROXY_API_KEY && env.CONNECTED_ACCOUNT_ID),
      };
      const igsid = url.searchParams.get('igsid');
      if (igsid) out.check = await checkFollows(env, igsid);
      return new Response(JSON.stringify(out, null, 2), { headers: { 'content-type': 'application/json' } });
    }
    const log: Entry[] = JSON.parse((await env.STATE.get('log')) || '[]');
    return new Response(dashboard(log), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
};
