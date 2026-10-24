// POST /api/generate  { url }  ->  { title, description, image, url, summary, angles[] }
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

function meta(html, key) {
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i');
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i');
  const m = html.match(a) || html.match(b);
  return m ? decode(m[1]) : '';
}

function articleText(html) {
  let body = (html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i) || [html])[0];
  body = body.replace(/<(script|style|nav|footer|aside|form|noscript|svg)[\s\S]*?<\/\1>/gi, '');
  const parts = [];
  for (const m of body.matchAll(/<(h[1-3]|p|li|blockquote)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = decode(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const heading = m[1][0].toLowerCase() === 'h';
    if (heading || t.length > 30) parts.push(heading ? `## ${t}` : t);
  }
  const text = parts.join('\n');
  // Long posts: keep the start and the end so the conclusion/solutions are not lost.
  return text.length > 16000 ? text.slice(0, 9000) + '\n[...]\n' + text.slice(-7000) : text;
}

const SYSTEM = `You are the social media editor for a personal blog. You read the whole article, understand its argument, then write posts that make a stranger want to read it.
Rules:
- Use only ideas, stories and claims that are actually in the article. Never invent statistics, quotes or facts.
- Each angle must be built on a DIFFERENT specific idea, moment, claim or practical tip from the article, not its opening lines. Different hook, different point.
- Write in the author's voice (honest, direct, first person where the article is first person). No profanity.
- Avoid clichés: "dive in", "unlock", "game-changer", "in today's fast-paced world", "let's talk about".
- Do not copy more than 8 consecutive words from the article.
- Do not include URLs or hashtags inside post text.
Reply with JSON only.`;

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    angles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          angle: { type: 'string' },
          x: { type: 'string' },
          facebook: { type: 'string' },
          instagram: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
        },
        required: ['angle', 'x', 'facebook', 'instagram', 'hashtags'],
      },
    },
  },
  required: ['summary', 'angles'],
};

function userPrompt(title, desc, text) {
  return `TITLE: ${title}
DESCRIPTION: ${desc}

ARTICLE:
${text}

TASK: Write "summary" (one sentence: the article's core argument). Then write exactly 3 "angles". For each angle:
- "angle": 2-4 word name for the idea it uses.
- "x": a standalone post under 230 characters. Strong hook, one idea, no hashtags, no link.
- "facebook": 300-500 characters, conversational, ends with a question or a gentle invitation to read. No link.
- "instagram": 450-750 characters with short paragraphs separated by blank lines, at most 2 emojis, last line exactly "Link in bio." No hashtags here.
- "hashtags": 6-8 relevant lowercase tags without the # symbol.`;
}

function tidyX(s) {
  s = s.trim();
  if (s.length <= 250) return s;
  const cut = s.slice(0, 250);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > 120 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
}

function parseModel(out) {
  if (out && typeof out === 'object') return out;
  const s = String(out || '');
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('The AI returned an unreadable answer. Try again.');
}

export async function onRequestPost({ request, env }) {
  if (env.APP_PASSWORD && request.headers.get('x-app-password') !== env.APP_PASSWORD)
    return json({ error: 'Wrong or missing password.' }, 401);

  let url;
  try {
    ({ url } = await request.json());
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw 0;
  } catch {
    return json({ error: 'Enter a full link starting with https://' }, 400);
  }

  let html;
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; PostWriter/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`The page returned ${r.status}.`);
    html = await r.text();
  } catch (e) {
    return json({ error: `Couldn’t open that link. ${e.message || ''}`.trim() }, 502);
  }

  const title = meta(html, 'og:title') || decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]).trim();
  const description = meta(html, 'og:description') || meta(html, 'description');
  const image = meta(html, 'og:image');
  const text = articleText(html);
  if (text.length < 300) return json({ error: 'Couldn’t find enough article text on that page.' }, 422);

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userPrompt(title, description, text) },
  ];

  let parsed;
  try {
    let res;
    try {
      res = await env.AI.run(MODEL, {
        messages, max_tokens: 1800, temperature: 0.8,
        response_format: { type: 'json_schema', json_schema: SCHEMA },
      });
    } catch {
      res = await env.AI.run(MODEL, { messages, max_tokens: 1800, temperature: 0.8 });
    }
    parsed = parseModel(res.response);
  } catch (e) {
    return json({ error: e.message || 'The AI request failed. Try again in a minute.' }, 502);
  }

  const angles = (parsed.angles || []).slice(0, 3).map((a) => ({
    angle: String(a.angle || 'Angle').trim(),
    x: tidyX(String(a.x || '')) + '\n\n' + url,
    facebook: String(a.facebook || '').trim() + '\n\n' + url,
    instagram: String(a.instagram || '').trim(),
    hashtags: (a.hashtags || [])
      .map((h) => '#' + String(h).replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase())
      .filter((h) => h.length > 1)
      .slice(0, 8)
      .join(' '),
  }));
  if (!angles.length) return json({ error: 'The AI didn’t return any posts. Try again.' }, 502);

  return json({ title, description, image, url, summary: String(parsed.summary || ''), angles });
}
