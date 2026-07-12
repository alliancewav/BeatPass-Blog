#!/usr/bin/env node

/*
 * Idempotently applies the GetMusic competitive content plan to Ghost.
 * Use --dry-run to inspect, then --apply to publish the scoped changes.
 */
const jwt = require('jsonwebtoken');
require('./load-env');

const BASE = process.env.GHOST_URL;
const ID = process.env.GHOST_ADMIN_KEY_ID;
const SECRET = process.env.GHOST_ADMIN_KEY_SECRET;
const HUB = 'subscription-beat-platform-checklist';
const HUB_URL = `https://blog.beatpass.ca/${HUB}/`;
const FAQ_START = '<!-- beatpass-faq-schema:start -->';
const FAQ_END = '<!-- beatpass-faq-schema:end -->';
const VIDEO_START = '<!-- beatpass-video-schema:start -->';
const VIDEO_END = '<!-- beatpass-video-schema:end -->';

function token() {
  return jwt.sign({}, Buffer.from(SECRET, 'hex'), { keyid: ID, algorithm: 'HS256', expiresIn: '5m', audience: '/admin/' });
}
async function api(method, endpoint, data) {
  const options = { method, headers: { Authorization: `Ghost ${token()}`, 'Content-Type': 'application/json' } };
  if (data) options.body = JSON.stringify(data);
  const res = await fetch(`${BASE}/ghost/api/admin/${endpoint}`, options);
  if (!res.ok) throw new Error(`${method} ${endpoint}: ${res.status} ${await res.text()}`);
  return res.json();
}
function json(value, label) {
  if (value && typeof value === 'object') return value;
  if (!value) throw new Error(`${label} is missing`);
  return JSON.parse(value);
}
function markdownCard(post) {
  const lexical = json(post.lexical, `${post.slug} lexical`);
  const nodes = lexical?.root?.children?.filter((node) => node.type === 'markdown' && typeof node.markdown === 'string') || [];
  if (nodes.length !== 1) throw new Error(`${post.slug} must have exactly one Markdown card; found ${nodes.length}`);
  return { lexical, node: nodes[0] };
}
function before(markdown, marker, block, slug) {
  if (markdown.includes(block)) return markdown;
  const at = markdown.indexOf(marker);
  if (at < 0) throw new Error(`${slug}: missing marker ${marker}`);
  return `${markdown.slice(0, at).trimEnd()}\n\n${block.trim()}\n\n${markdown.slice(at)}`;
}
function section(markdown, start, end, replacement, slug) {
  const a = markdown.indexOf(start), b = markdown.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`${slug}: cannot replace ${start}`);
  return `${markdown.slice(0, a).trimEnd()}\n\n${replacement.trim()}\n\n${markdown.slice(b)}`;
}
function hubLink(markdown, slug) {
  return before(markdown, '## Next reads', `Before you upload a catalog or release a song, use this [subscription beat platform checklist](${HUB_URL}) to compare rights, proof, payout logic, cancellation terms, and exclusive-sale handling.`, slug);
}
function schema(existing, start, end, value) {
  const stripped = (existing || '').replace(new RegExp(`${start}[\\s\\S]*?${end}\\n?`, 'g'), '').trim();
  return [stripped, value].filter(Boolean).join('\n');
}
function faq(items) {
  const body = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items.map(([name, text]) => ({ '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text } })) };
  return `${FAQ_START}\n<script type="application/ld+json">${JSON.stringify(body)}</script>\n${FAQ_END}`;
}
function videoSchema(data) {
  const body = { '@context': 'https://schema.org', '@type': 'VideoObject', name: data.title, description: data.description, thumbnailUrl: [data.thumbnailUrl], uploadDate: data.uploadDate, embedUrl: `https://www.youtube.com/embed/${data.videoId}`, url: `https://www.youtube.com/watch?v=${data.videoId}`, relatedLink: data.trackUrl };
  return `${VIDEO_START}\n<script type="application/ld+json">${JSON.stringify(body)}</script>\n${VIDEO_END}`;
}

const faqItems = {
  'best-beat-subscription-services-2026': [
    ['Are beat subscriptions worth it for artists?', 'They can be worthwhile for artists or creators who release regularly. Compare catalog fit, license scope, proof, cancellation terms, Content ID rules, and upgrade paths before subscribing.'],
    ['What happens to beats after I cancel a subscription?', 'It depends on the platform. Check whether licenses for downloads made during an active subscription remain valid and whether the platform keeps a usable proof record after cancellation.'],
    ['Can I register subscription beats with YouTube Content ID?', 'Usually not with a non-exclusive license, because multiple artists can license the same beat. Check the specific license and exclusive-upgrade terms first.']
  ],
  'how-to-choose-a-beat-subscription': [
    ['Is unlimited beats the same as unlimited rights?', 'No. Unlimited access means you can download or lease eligible beats under the platform rules. The license still controls how each beat can be used.'],
    ['What should I check before using a newer subscription beat platform?', 'Check license scope, cancellation terms, proof of license, Content ID rules, exclusive upgrade path, producer ownership rules, payout transparency, AI policy, and dispute support.'],
    ['Is sound-based beat search a good feature?', 'It can help when you know the direction you want. Use reference-driven discovery to find fit, not to copy. If the original beat is available, license the original producer.']
  ],
  'how-beat-subscription-payouts-work-for-producers': [
    ['Is paid per play the same as a subscription payout?', 'Not necessarily. A platform may pay a fixed rate per play or calculate a relative share from a pool. Producers should read the published mechanism before uploading.'],
    ['How does BeatPass calculate subscription payout share?', 'BeatPass uses contribution value across eligible catalog. The published formula considers recency, plays, and collaborator count, so it is not a fixed amount per play.']
  ],
  'custom-beat-request-platform': [
    ['Can I use a YouTube beat as a reference?', 'Yes, as a direction reference. Do not ask producers to copy it. Use the reference to communicate mood, tempo, energy, or arrangement.'],
    ['What if I already found the exact beat I want?', 'License that beat from the original producer if it is available. Beat Requests are best when you need a custom fit, not a cheaper clone.']
  ],
  'how-to-verify-beat-licenses': [
    ['What is beat license verification?', 'It is the process of confirming that an artist has a valid license to use a specific beat. Strong systems combine the license terms, a track-level record, and a way for third parties to check current status.'],
    ['Can I verify a BeatPass license without a BeatPass account?', 'Yes. BeatPass provides a public verification page for a certificate UUID, so a distributor, label, platform, or collaborator can check the certificate record and current status without logging in.']
  ],
  [HUB]: [
    ['What is the most important thing to verify before joining a beat subscription platform?', 'Verify the rights, proof of license, payout model, cancellation terms, Content ID rules, producer ownership, and exclusive-sale handling before uploading or downloading.'],
    ['Is a receipt enough proof for a beat license?', 'A receipt proves a payment, not necessarily the specific rights received. Keep the license terms and look for a track-level certificate or public verification method when available.'],
    ['Should producers upload their best catalog to a new platform immediately?', 'Only after reading the producer agreement and understanding ownership, platform rights, payout calculation, removal procedures, and how existing licenses interact with later exclusive sales.']
  ]
};

const blocks = {
  'best-beat-subscription-services-2026': ['## What about the per-beat platforms?', `### GetMusic — new entrant with unlimited leasing and sound-based discovery

[GetMusic](https://www.getmusic.shop/) is a newer beat subscription marketplace positioning itself around one subscription, unlimited leasing, licenses that remain valid after the subscription ends, producer chat, release tracking, and sound-based beat discovery.

**What stands out:**

- Simple artist pitch: one subscription and unlimited beats.
- Producer pitch: free uploads, rights retention, revenue sharing, analytics, chat, and release tracking.
- Sound-based discovery can help artists who know the direction they want.

**What to verify before relying on it:**

- How the producer revenue pool is calculated.
- How license proof is issued and verified.
- How Content ID and exclusive sales are handled.
- Whether the license terms are easy to access and stable.
- How reference or sound-based matching avoids copycat behavior.

**Best for:** artists and producers testing a new platform who are willing to read the terms and understand the economics before making it their main system.

BeatPass is strongest when proof matters: eligible downloads create a verifiable certificate, [non-exclusive license terms](https://docs.beatpass.ca/help/legal/license-terms/non-exclusive) are documented, [BeatPassID](https://docs.beatpass.ca/help/downloads-and-licensing/beatpass-id) adds fingerprint-linked certificate context, and the [producer contribution formula](https://docs.beatpass.ca/help/earnings/contribution-system/formula) is published.`],
  'how-to-choose-a-beat-subscription': ['## How the three subscription platforms compare', `## New platforms make the checklist more important

New beat subscription platforms are entering the market with simple promises: unlimited beats, forever-valid licenses, producer chat, release tracking, and sound-based discovery.

Those features can be useful. But they do not replace the basics.

Before you subscribe anywhere, check:

- Does every download create proof you can show a distributor?
- Does the license stay valid after cancellation?
- Is Content ID allowed or restricted?
- Can you verify a license publicly?
- Are the terms easy to read before you download?
- Can you upgrade to exclusive rights if a song takes off?
- Does reference or sound-based search help you find fit without copying another producer's beat?`],
  'sell-beats-without-beatstars': ['### BeatPass — subscription model with Producer Program', `### GetMusic — new subscription marketplace with paid-activity positioning

[GetMusic](https://www.getmusic.shop/) is a newer subscription marketplace pitching producers on free uploads, rights retention, analytics, chat, release tracking, and revenue from subscribed artist activity.

The hook is strong because it speaks directly to producer frustration: marketplace saturation, expensive ads, weak organic reach, low lease volume, and catalog income that resets every month.

**What producers should like:**

- No upfront upload fee in the public pitch.
- A simple subscription-based artist-demand story.
- Analytics and release-tracking messaging.
- Sound-based discovery that may expose catalog to artists searching by reference.

**What producers should verify:**

- How the revenue pool is calculated.
- Whether “paid on plays” means a fixed rate or a relative pool share.
- How downloads, likes, releases, and plays are weighted.
- How existing non-exclusive licenses interact with later exclusive sales.
- What license proof artists receive.
- What rights the platform receives to host, promote, process, and match beats.
- How removal and disputes work.

**Best for:** producers testing a new channel, not producers blindly uploading their best catalog without understanding the terms.`],
  'beat-marketplace-vs-subscription-platform': ['## Side-by-side comparison', `## The new wave: subscription marketplaces for beats

The newest wave of beat platforms is borrowing from streaming, sample libraries, and traditional beat marketplaces.

The promise is simple: artists subscribe, producers upload, usage creates payouts, and licenses stay valid.

That model can work. But the details determine whether it protects artists and producers.

The useful question is not “marketplace or subscription?” The useful questions are:

- Who owns the beat?
- Who gets what license?
- How is proof created?
- How is payout share calculated?
- What happens after cancellation?
- What happens after an exclusive sale?
- What happens if a reference track is used to find a similar beat?

A subscription platform is not better just because it has unlimited downloads. It is better when it gives artists clean proof, gives producers clear ownership terms, and explains how catalog activity turns into earnings.`],
  'how-to-verify-beat-licenses': ['## The real problem: you have a license, but no proof system', `## Why this matters more with subscription beats

Subscription beat platforms make downloading easier. That is the point.

But easier downloading creates a bigger responsibility: every beat needs clear proof.

If you download 30 beats across a year, you do not want 30 vague receipts, screenshots, or dashboard memories. You want a license record you can verify when a distributor, label, collaborator, or rights team asks.

That is why proof systems matter more as subscriptions grow.`],
  'how-audio-fingerprinting-helps-producers': ['## How BeatPass approaches it: Audio Recon', `## Similarity search is not the same as rights protection

Sound-based discovery helps users find beats that match a direction.

Audio fingerprinting for protection has a different job: it helps identify duplicate uploads, high-similarity matches, and potential uses that producers may need to review.

Those two ideas sound similar, but they serve different purposes.

A beat-finder helps an artist discover options. A protection system helps producers investigate catalog integrity. A license proof system helps artists show what they are allowed to use.

BeatPass connects protection and proof through [Audio Recon](https://docs.beatpass.ca/help/licensing-for-producers/audio-recon), [BeatPassID](https://docs.beatpass.ca/help/downloads-and-licensing/beatpass-id), and [license certificates](https://docs.beatpass.ca/help/downloads-and-licensing/license-certificates).

Audio Recon surfaces similarity signals for producer review; it is not automatic proof that a beat was used without permission.`]
};

const payout = `## Is this the same as getting paid per play?

Not exactly.

Some platforms market subscription payouts as “paid per play” because it is easy to understand. The important question is whether the platform pays a fixed rate per play or calculates a relative share from a pool.

On BeatPass, producer earnings from subscription activity are contribution-based. The [published contribution formula](https://docs.beatpass.ca/help/earnings/contribution-system/formula) considers recency, plays, and collaborator count. That means producer share is calculated from platform activity, not guessed or described only as “fair.”

When a platform says “fair revenue share,” producers should ask:

- Is the formula published?
- Are plays, downloads, likes, and releases weighted differently?
- Is there a fixed rate or a pool?
- What happens when the catalog grows?
- What happens when other producers outperform you?
- Are collaborators split automatically?
- Are exclusive-only tracks included or excluded?

## How BeatPass payouts work specifically

BeatPass calculates subscription payout share from contribution value across eligible catalog. The documented formula has three parts: time decay gives newer uploads more recency strength, a logarithmic play curve boosts popular tracks, and a collaboration split divides a track's value equally across credited producers.

Tracks marked exclusive-only have a contribution value of zero for subscription sharing. Contribution values are recalculated periodically, so a producer's share can move as their own catalog and the platform total change.

That is different from a fixed per-play rate and different from a vague “fair share” promise. Producers can read the [formula](https://docs.beatpass.ca/help/earnings/contribution-system/formula), [maximising-earnings guidance](https://docs.beatpass.ca/help/earnings/contribution-system/maximizing-earnings), and [Finances documentation](https://docs.beatpass.ca/help/producer-dashboard/finances) before they join.

For current checkout fees and exclusive-purchase mechanics, use the amount shown at checkout and the [Platform Fee documentation](https://docs.beatpass.ca/help/billing/platform-fee).`;
const proof = `### Weak proof

- Payment receipt only.
- Screenshot of a download page.
- Generic dashboard history.
- Expired account access.
- License text with no public verification.

### Stronger proof

- Certificate tied to the user and track.
- Public verification page.
- Issue date and current status.
- License type.
- Usage terms.
- Fingerprint details when available.`;
const reference = `## Reference search vs Beat Requests

Some newer beat platforms are starting to use sound-based search: paste a reference, get similar beats.

That can help when an artist knows the sound they want, especially if the original beat is unavailable. But it also creates a risk: artists may start treating reference search as a way to avoid licensing the original producer.

Beat Requests take a different path.

A reference track helps communicate direction, but the request still goes to human producers who can submit beats that fit the brief without cloning the original.

**Good use:** “I want this tempo, space, and energy.”

**Bad use:** “Make this exact beat cheaper.”

If the original beat is available, license the original producer. If you need a new direction built around your project, use a [Beat Request](https://docs.beatpass.ca/help/beat-requests/index).`;
const newFaqs = `### Is “unlimited beats” the same as unlimited rights?

No. Unlimited access means you can download or lease eligible beats under the platform's rules. The license still controls how you can use each beat.

### What should I check before using a newer subscription beat platform?

Check license scope, cancellation terms, proof of license, Content ID rules, exclusive upgrade path, producer ownership rules, payout transparency, AI policy, and dispute support.

### Is sound-based beat search a good feature?

It can be useful when you know the direction you want. But if the original beat is available, the cleanest move is to license the original producer. Use sound-based or reference-driven discovery to find fit, not to copy.`;
const requestFaqs = `### Can I use a YouTube beat as a reference?

Yes, as a direction reference. Do not ask producers to copy it. Use the reference to communicate mood, tempo, energy, or arrangement.

### What if I already found the exact beat I want?

License that beat from the original producer if it is available. Beat Requests are best when you need a custom fit, not a cheaper clone.`;
const sellerContrast = `BeatPass is different because the producer-side system is tied to published docs: [producer ownership terms](https://docs.beatpass.ca/help/legal/producer-upload-seller-agreement), the [contribution formula](https://docs.beatpass.ca/help/earnings/contribution-system/formula), [license certificates](https://docs.beatpass.ca/help/downloads-and-licensing/license-certificates), and [standard non-exclusive license terms](https://docs.beatpass.ca/help/legal/license-terms/non-exclusive) are documented.

Compare the models before you upload your best catalog:

- [How beat subscription payouts work for producers](https://blog.beatpass.ca/how-beat-subscription-payouts-work-for-producers/)
- [How audio fingerprinting helps producers](https://blog.beatpass.ca/how-audio-fingerprinting-helps-producers/)
- [How to verify beat licenses](https://blog.beatpass.ca/how-to-verify-beat-licenses/)
- [BeatPass contribution formula](https://docs.beatpass.ca/help/earnings/contribution-system/formula)
- [Producer ownership terms](https://docs.beatpass.ca/help/legal/producer-upload-seller-agreement)`;

function flagship() {
  return `## Quick answer

A beat subscription platform is only as strong as its rights, proof, payout model, and producer standards. Before uploading or downloading, check who owns the beat, what license is issued, whether proof is verifiable, how payouts are calculated, what happens after cancellation, and how exclusive sales are handled.

## Why this matters now

New beat platforms are entering the market with simple promises: one subscription, unlimited beats, forever licenses, producer chat, activity-based payouts, and sound-based discovery.

That can be useful. But the fine print decides whether the model protects artists and producers.

Unlimited access is convenient. Proof is what protects the release.

## The 12-point checklist

### 1. Who owns the beat after upload?

Producers should keep ownership unless they knowingly transfer rights. Read the [producer ownership terms](https://docs.beatpass.ca/help/legal/producer-upload-seller-agreement), not just the signup headline.

### 2. What rights does the platform receive?

Hosting, streaming, licensing, promotion, matching, verification, and moderation rights should be clear before a producer uploads.

### 3. What license does the artist receive?

The license should explain commercial release rights, project limits, credit, Content ID, resale, transfer, and prohibited uses. Compare the [non-exclusive license terms](https://docs.beatpass.ca/help/legal/license-terms/non-exclusive) with the terms of any platform you are considering.

### 4. Does the license survive cancellation?

Artists need to know whether downloads stay licensed after they stop paying. Keep the applicable certificate and terms with the release project.

### 5. Is there proof of license?

A receipt is not the same as proof. Stronger systems issue certificates, public verification, and track-level license records. On BeatPass, [license certificates](https://docs.beatpass.ca/help/downloads-and-licensing/license-certificates) are created when a track is downloaded.

### 6. Can third parties verify the license?

A distributor, label, platform, or collaborator should be able to verify the license without relying on screenshots. [Public license verification](https://docs.beatpass.ca/help/downloads-and-licensing/verifying-licenses) is stronger than asking someone to trust a dashboard memory.

### 7. How are producers paid?

“Fair revenue share” is not enough. Ask whether the formula is published and how plays, downloads, likes, releases, recency, and collaborators affect payout.

### 8. Is “paid per play” fixed-rate or pool-based?

These are different economics. Producers need to know which model applies. BeatPass uses a [contribution formula](https://docs.beatpass.ca/help/earnings/contribution-system/formula) that considers recency, plays, and collaborator count rather than a fixed rate per play.

### 9. What happens when a beat sells exclusively?

Already issued non-exclusive licenses, future downloads, Content ID, and producer obligations should be clearly explained before either side commits.

### 10. How does the platform handle AI and reference matching?

Sound-based discovery should help artists find fit, not copy available beats or bypass the original producer. Read the [AI audio policy](https://docs.beatpass.ca/help/legal/ai-audio-human-made-content) and use references to communicate direction, not to request a clone.

### 11. Can producers remove or update catalog?

Producers need a clear process for delisting, rights conflicts, exclusive sales, and corrections.

### 12. What happens in a rights dispute?

The platform should explain Proof of Rights requests, DMCA, non-DMCA rights reports, AI-origin issues, refund review, certificate status, and support paths. [Audio Recon](https://docs.beatpass.ca/help/licensing-for-producers/audio-recon) can surface similarity signals for review, but it is not automatic proof of infringement.

## Artist checklist

Before downloading, ask:

- Can I release this song commercially?
- Can I monetise it on streaming and YouTube?
- Is Content ID allowed?
- Will the license still be valid after cancellation?
- Can I show proof to my distributor?
- What happens if the beat later sells exclusive?
- Do I need to credit the producer?

## Producer checklist

Before uploading, ask:

- Do I keep ownership?
- What licenses can the platform issue?
- How is payout share calculated?
- Is the formula visible?
- Can I still sell elsewhere?
- How do exclusive conflicts work?
- What can the platform do with previews, metadata, and audio?
- What proof does the artist receive?
- How are AI, samples, and Proof of Rights handled?

## Where BeatPass fits

BeatPass documents its system publicly:

- [Non-exclusive license terms](https://docs.beatpass.ca/help/legal/license-terms/non-exclusive)
- [License certificates](https://docs.beatpass.ca/help/downloads-and-licensing/license-certificates)
- [Public license verification](https://docs.beatpass.ca/help/downloads-and-licensing/verifying-licenses)
- [BeatPassID](https://docs.beatpass.ca/help/downloads-and-licensing/beatpass-id)
- [Contribution formula](https://docs.beatpass.ca/help/earnings/contribution-system/formula)
- [Producer Upload and Seller Agreement](https://docs.beatpass.ca/help/legal/producer-upload-seller-agreement)
- [AI Audio and Human-Made Content policy](https://docs.beatpass.ca/help/legal/ai-audio-human-made-content)
- [Beat Requests](https://docs.beatpass.ca/help/beat-requests/index)
- [Audio Recon](https://docs.beatpass.ca/help/licensing-for-producers/audio-recon)

## FAQs

### What is the most important thing to verify before joining a beat subscription platform?

Verify the rights, proof of license, payout model, cancellation terms, Content ID rules, producer ownership, and exclusive-sale handling before uploading or downloading.

### Is a receipt enough proof for a beat license?

A receipt proves a payment, not necessarily the specific rights received. Keep the license terms and look for a track-level certificate or public verification method when available.

### Should producers upload their best catalog to a new platform immediately?

Only after reading the producer agreement and understanding ownership, platform rights, payout calculation, removal procedures, and how existing licenses interact with later exclusive sales.

## Bottom line

Unlimited access is convenient. Proof is what protects the release.

A serious beat subscription platform should make rights, payout logic, proof, cancellation terms, and producer ownership easy to understand before you commit.

## Next reads

- [How to choose a beat subscription](https://blog.beatpass.ca/how-to-choose-a-beat-subscription/)
- [How to verify beat licenses](https://blog.beatpass.ca/how-to-verify-beat-licenses/)
- [How beat subscription payouts work for producers](https://blog.beatpass.ca/how-beat-subscription-payouts-work-for-producers/)
- [Beat marketplace vs subscription platform](https://blog.beatpass.ca/beat-marketplace-vs-subscription-platform/)`;
}

function update(post) {
  const { lexical, node } = markdownCard(post);
  const original = node.markdown;
  let markdown = original;
  if (blocks[post.slug]) markdown = before(markdown, blocks[post.slug][0], blocks[post.slug][1], post.slug);
  if (post.slug === 'how-to-choose-a-beat-subscription') markdown = before(markdown, '## Next reads', newFaqs, post.slug);
  if (post.slug === 'sell-beats-without-beatstars') markdown = before(markdown, '## Comparison table', sellerContrast, post.slug);
  if (post.slug === 'how-beat-subscription-payouts-work-for-producers') {
    if (!markdown.includes('## Is this the same as getting paid per play?')) markdown = section(markdown, '## How BeatPass payouts work specifically', '## Comparing income models: marketplace vs subscription vs hybrid', payout, post.slug);
    markdown = markdown.replace('BeatPass: 15% on top (not deducted from share)', '[Current checkout fee](https://docs.beatpass.ca/help/billing/platform-fee)');
    markdown = markdown.replace('On BeatPass specifically, the producer receives their full calculated share — the 15% platform fee is charged on top, not deducted from the producer\'s portion.', 'On BeatPass, review the published contribution formula for subscription allocation and the current checkout amount for any applicable platform fee.');
    markdown = markdown.replace('BeatPass uses Audio Recon fingerprinting technology to identify your beats at the audio level. This prevents unauthorized re-uploads and duplicate submissions, protecting your catalog from misuse within the platform.', 'BeatPass fingerprints uploaded tracks, and Audio Recon surfaces high-similarity matches on supported streaming platforms for producer review. A match is a signal to investigate, not automatic proof of use.');
  }
  if (post.slug === 'custom-beat-request-platform') {
    markdown = before(markdown, '## What makes this different from just messaging producers', reference, post.slug);
    markdown = before(markdown, '## Next reads', requestFaqs, post.slug);
  }
  if (post.slug === 'how-to-verify-beat-licenses') markdown = before(markdown, '## How BeatPass approaches verification', proof, post.slug);
  markdown = hubLink(markdown, post.slug);
  const payload = { updated_at: post.updated_at };
  if (markdown !== original) { node.markdown = markdown; payload.lexical = JSON.stringify(lexical); }
  if (faqItems[post.slug]) {
    const nextSchema = schema(post.codeinjection_head, FAQ_START, FAQ_END, faq(faqItems[post.slug]));
    if (nextSchema !== post.codeinjection_head) payload.codeinjection_head = nextSchema;
  }
  if (post.slug === 'how-beat-subscription-payouts-work-for-producers') {
    const metaTitle = 'Paid Per Play for Beats? How Subscription Payouts Work';
    const metaDescription = 'Some platforms say producers get paid per play. Learn the difference between fixed per-play payouts, revenue pools, and BeatPass contribution-based subscription payouts.';
    if (post.meta_title !== metaTitle) payload.meta_title = metaTitle;
    if (post.meta_description !== metaDescription) payload.meta_description = metaDescription;
  }
  if (post.slug === 'custom-beat-request-platform') {
    const metaTitle = 'AI Beat Matching vs Beat Requests: Finding Beats Without Copying';
    const metaDescription = 'Sound-based beat search can help artists find direction, but references should guide fit, not copy another producer’s beat. Learn how Beat Requests work on BeatPass.';
    if (post.meta_title !== metaTitle) payload.meta_title = metaTitle;
    if (post.meta_description !== metaDescription) payload.meta_description = metaDescription;
  }
  return payload;
}
function videoId(value) { return String(value || '').match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1] || null; }
function trackUrl(value) { return String(value || '').match(/https:\/\/open\.beatpass\.ca\/track\/[^\s)"']+/)?.[0] || null; }
async function youtubeUploadDate(id) {
  try { const r = await fetch(`https://www.youtube.com/watch?v=${id}`); const h = await r.text(); return h.match(/<meta itemprop="uploadDate" content="([^"<]+)"/i)?.[1] || null; } catch { return null; }
}
function videoLicense(markdown) {
  const block = `## License this beat cleanly

On BeatPass, eligible downloads include [standardized license terms](https://docs.beatpass.ca/help/legal/license-terms/non-exclusive) and access to [license proof](https://docs.beatpass.ca/help/downloads-and-licensing/license-certificates) inside your library.

If you are releasing a song, keep your license certificate with the project so you can show proof later if a distributor, platform, collaborator, or rights team asks.

Useful guides:

- [How BeatPass licenses work](https://docs.beatpass.ca/help/legal/license-terms/non-exclusive)
- [How to verify BeatPass licenses](https://blog.beatpass.ca/how-to-verify-beat-licenses/)
- [Beat licensing explained](https://blog.beatpass.ca/beat-licensing-explained/)`;
  if (markdown.includes('## License this beat cleanly')) return markdown;
  const at = markdown.lastIndexOf('\n---\n');
  return at < 0 ? `${markdown.trimEnd()}\n\n${block}` : `${markdown.slice(0, at).trimEnd()}\n\n${block}\n\n${markdown.slice(at)}`;
}
async function scheduledVideo(posts) {
  const post = posts.find((p) => p.status === 'scheduled' && (p.tags || []).some((t) => t.slug === 'hash-video'));
  if (!post) return null;
  const mobile = json(post.mobiledoc, `${post.slug} mobiledoc`);
  const card = mobile.cards?.find((c) => c[0] === 'markdown' && typeof c[1]?.markdown === 'string');
  if (!card) throw new Error(`${post.slug}: no Markdown card`);
  const source = `${JSON.stringify(mobile)} ${post.html || ''}`;
  const id = videoId(source);
  if (!id) throw new Error(`${post.slug}: no YouTube ID`);
  const next = videoLicense(card[1].markdown);
  const payload = { updated_at: post.updated_at };
  if (!(post.codeinjection_head || '').includes('"@type":"VideoObject"')) {
    const nextSchema = schema(post.codeinjection_head, VIDEO_START, VIDEO_END, videoSchema({ title: post.title, description: post.custom_excerpt || `Watch ${post.title} and listen on BeatPass.`, thumbnailUrl: post.feature_image || `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, uploadDate: await youtubeUploadDate(id) || post.published_at, videoId: id, trackUrl: trackUrl(source) }));
    if (nextSchema !== post.codeinjection_head) payload.codeinjection_head = nextSchema;
  }
  if (next !== card[1].markdown) { card[1].markdown = next; payload.mobiledoc = JSON.stringify(mobile); }
  return { post, payload };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const fields = 'id,title,slug,status,published_at,updated_at,lexical,mobiledoc,html,feature_image,custom_excerpt,codeinjection_head,meta_title,meta_description';
  const data = await api('GET', `posts/?limit=all&status=all&include=tags&fields=${fields}`);
  const posts = data.posts || [], bySlug = new Map(posts.map((p) => [p.slug, p]));
  const targets = [...Object.keys(blocks), 'how-beat-subscription-payouts-work-for-producers', 'custom-beat-request-platform'];
  const changes = targets.map((slug) => { const post = bySlug.get(slug); if (!post) throw new Error(`Missing ${slug}`); return { post, payload: update(post) }; });
  for (const slug of ['buying-beats-vs-beat-subscription', 'beat-subscription-for-content-creators', 'best-platform-to-sell-beats-online', 'how-producers-build-recurring-revenue', 'beat-licensing-explained']) {
    const post = bySlug.get(slug); if (!post) throw new Error(`Missing ${slug}`);
    const { lexical, node } = markdownCard(post), next = hubLink(node.markdown, slug);
    const payload = { updated_at: post.updated_at };
    if (next !== node.markdown) { node.markdown = next; payload.lexical = JSON.stringify(lexical); }
    changes.push({ post, payload });
  }
  const scheduled = await scheduledVideo(posts);
  const existingHub = bySlug.get(HUB);
  console.log(apply ? '═══ APPLYING GETMUSIC CONTENT PLAN ═══' : '═══ DRY RUN — NO GHOST CHANGES ═══');
  for (const { post, payload } of changes) console.log(`${Object.keys(payload).length > 1 ? 'UPDATE' : 'SKIP  '} ${post.slug} ${Object.keys(payload).filter((k) => k !== 'updated_at').join(', ')}`);
  if (scheduled) console.log(`${Object.keys(scheduled.payload).length > 1 ? 'UPDATE' : 'SKIP  '} ${scheduled.post.slug} ${Object.keys(scheduled.payload).filter((k) => k !== 'updated_at').join(', ')}`);
  console.log(`${existingHub ? 'SKIP  ' : 'CREATE'} ${HUB}`);
  if (!apply) return;
  for (const { post, payload } of changes) if (Object.keys(payload).length > 1) { await api('PUT', `posts/${post.id}/`, { posts: [payload] }); console.log(`✓ ${post.slug}`); }
  if (scheduled && Object.keys(scheduled.payload).length > 1) { await api('PUT', `posts/${scheduled.post.id}/`, { posts: [scheduled.payload] }); console.log(`✓ ${scheduled.post.slug}`); }
  if (!existingHub) {
    const template = bySlug.get('best-beat-subscription-services-2026');
    const { lexical, node } = markdownCard(template); node.markdown = flagship();
    const result = await api('POST', 'posts/', { posts: [{ title: 'Subscription Beat Platform Checklist: What Producers and Artists Should Verify Before Joining', slug: HUB, lexical: JSON.stringify(lexical), meta_title: 'Subscription Beat Platform Checklist: Rights, Payouts, Proof', meta_description: 'Before joining a beat subscription platform, check licensing, payout transparency, producer ownership, license proof, cancellation terms, Content ID rules, AI policy, and exclusive rights.', custom_excerpt: 'Before you upload or download on any beat subscription platform, verify the rights, proof, payout logic, cancellation terms, Content ID rules, and exclusive-sale handling.', feature_image: 'https://blog.beatpass.ca/content/images/2026/04/pricing-page-hero.webp', tags: [{ name: 'Articles' }, { name: 'Guides' }, { name: 'Artist Guide' }, { name: 'Beat Licensing' }, { name: 'Selling Beats' }], codeinjection_head: faq(faqItems[HUB]), status: 'published' }] });
    console.log(`✓ ${result.posts[0].url}`);
  }
}
main().catch((error) => { console.error(`Fatal: ${error.message}`); process.exit(1); });
