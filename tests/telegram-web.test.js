const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  findWebUrl,
  parseTweetUrl,
  canonicalUrl,
  extractHtml,
  tweetToContent,
  buildDistillPrompt,
  buildWikiNote,
  wikiHasUrl
} = require('../system/telegram/web.js');

/* ------------------------------ findWebUrl ------------------------------ */

test('findWebUrl: bare URL', () => {
  const r = findWebUrl('https://example.com/some-article');
  assert.strictEqual(r.url, 'https://example.com/some-article');
});

test('findWebUrl: URL with surrounding text (the share-sheet / "Read this today:" case)', () => {
  const r = findWebUrl('Read this today: https://x.com/openai/status/2074704958419792299?s=46&t=abc');
  assert.strictEqual(r.url, 'https://x.com/openai/status/2074704958419792299?s=46&t=abc');
});

test('findWebUrl: strips trailing punctuation', () => {
  assert.strictEqual(findWebUrl('look at https://example.com/post.').url, 'https://example.com/post');
  assert.strictEqual(findWebUrl('(see https://example.com/post)').url, 'https://example.com/post');
});

test('findWebUrl: no URL -> null', () => {
  assert.strictEqual(findWebUrl('what did I decide about thumbnails?'), null);
  assert.strictEqual(findWebUrl(''), null);
  assert.strictEqual(findWebUrl(null), null);
});

test('findWebUrl: skips YouTube URLs (those belong to the YouTube pipeline)', () => {
  assert.strictEqual(findWebUrl('https://youtu.be/VoKiKvgpk78'), null);
  assert.strictEqual(findWebUrl('https://www.youtube.com/watch?v=VoKiKvgpk78'), null);
  // ...but still finds a non-YouTube URL alongside text
  const r = findWebUrl('via https://substack.com/p/some-post today');
  assert.strictEqual(r.url, 'https://substack.com/p/some-post');
});

/* ----------------------------- parseTweetUrl ---------------------------- */

test('parseTweetUrl: x.com and twitter.com status URLs', () => {
  const a = parseTweetUrl('https://x.com/openai/status/2074704958419792299?s=46&t=abc');
  assert.deepStrictEqual(a, { user: 'openai', id: '2074704958419792299' });
  const b = parseTweetUrl('https://twitter.com/naval/status/1002103360646823936');
  assert.deepStrictEqual(b, { user: 'naval', id: '1002103360646823936' });
  const c = parseTweetUrl('https://mobile.twitter.com/naval/status/1002103360646823936');
  assert.deepStrictEqual(c, { user: 'naval', id: '1002103360646823936' });
});

test('parseTweetUrl: non-tweet URLs -> null', () => {
  assert.strictEqual(parseTweetUrl('https://x.com/openai'), null);
  assert.strictEqual(parseTweetUrl('https://example.com/status/123'), null);
});

/* ----------------------------- canonicalUrl ----------------------------- */

test('canonicalUrl: strips share-tracking params from x.com links', () => {
  assert.strictEqual(
    canonicalUrl('https://x.com/openai/status/2074704958419792299?s=46&t=H_MJ1ZXAMeW'),
    'https://x.com/openai/status/2074704958419792299'
  );
});

test('canonicalUrl: strips utm_*/fbclid but keeps meaningful query params', () => {
  assert.strictEqual(
    canonicalUrl('https://example.com/post?utm_source=tw&utm_medium=social&p=5'),
    'https://example.com/post?p=5'
  );
  assert.strictEqual(
    canonicalUrl('https://example.com/post?fbclid=xyz'),
    'https://example.com/post'
  );
});

/* ------------------------------ extractHtml ----------------------------- */

const HTML = `<!doctype html><html><head>
<title>Fallback Title | Site</title>
<meta property="og:title" content="How Retention Really Works">
<meta property="og:site_name" content="Creator Science">
<meta property="og:description" content="A deep dive into audience retention.">
<meta property="og:image" content="https://example.com/cover.jpg">
</head><body>
<nav>Home About</nav>
<script>var x = 1;</script>
<style>.a{color:red}</style>
<article><h1>How Retention Really Works</h1>
<p>Retention is the &amp; game. It compounds.</p>
<p>Second paragraph with a <a href="/x">link</a> inside.</p></article>
<footer>© 2026</footer>
</body></html>`;

test('extractHtml: prefers og tags and strips script/style/nav/footer', () => {
  const r = extractHtml(HTML);
  assert.strictEqual(r.title, 'How Retention Really Works');
  assert.strictEqual(r.siteName, 'Creator Science');
  assert.strictEqual(r.description, 'A deep dive into audience retention.');
  assert.strictEqual(r.image, 'https://example.com/cover.jpg');
  assert.ok(r.text.includes('Retention is the & game. It compounds.'));
  assert.ok(r.text.includes('Second paragraph with a link inside.'));
  assert.ok(!r.text.includes('var x'), 'script content leaked into text');
  assert.ok(!r.text.includes('color:red'), 'style content leaked into text');
  assert.ok(!r.text.includes('Home About'), 'nav content leaked into text');
});

test('extractHtml: falls back to <title> when no og:title', () => {
  const r = extractHtml('<html><head><title>Plain Title</title></head><body><p>Hi there.</p></body></html>');
  assert.strictEqual(r.title, 'Plain Title');
  assert.ok(r.text.includes('Hi there.'));
});

test('extractHtml: tolerates empty/garbage input', () => {
  const r = extractHtml('');
  assert.strictEqual(r.title, '');
  assert.strictEqual(r.text, '');
});

/* ---------------------------- tweetToContent ---------------------------- */

const FX_TWEET = {
  url: 'https://x.com/OpenAI/status/2074704958419792299',
  id: '2074704958419792299',
  text: 'GPT-5.6 Sol, along with Terra and Luna, will launch publicly this Thursday.\n\nWe’re expanding preview access globally now.',
  author: { screen_name: 'OpenAI', name: 'OpenAI' },
  media: { photos: [{ url: 'https://pbs.twimg.com/media/abc.jpg' }] }
};

test('tweetToContent: maps fxtwitter JSON to capture content', () => {
  const c = tweetToContent(FX_TWEET);
  assert.strictEqual(c.siteName, 'X (@OpenAI)');
  assert.ok(c.title.startsWith('GPT-5.6 Sol'));
  assert.ok(c.text.includes('expanding preview access'));
  assert.strictEqual(c.image, 'https://pbs.twimg.com/media/abc.jpg');
});

test('tweetToContent: no media -> null image, long text -> truncated title', () => {
  const c = tweetToContent({ text: 'x'.repeat(300), author: { screen_name: 'a', name: 'A' } });
  assert.strictEqual(c.image, null);
  assert.ok(c.title.length <= 80);
});

/* --------------------------- prompt + wiki note ------------------------- */

test('buildDistillPrompt: includes source, content, and the JSON contract', () => {
  const p = buildDistillPrompt(
    { title: 'T', siteName: 'S', url: 'https://e.com/p' },
    'the content body'
  );
  assert.ok(p.includes('https://e.com/p'));
  assert.ok(p.includes('the content body'));
  assert.ok(p.includes('"apply"') || p.includes('apply'));
  assert.ok(p.includes('department'));
});

test('buildWikiNote: valid frontmatter + Source and Apply sections', () => {
  const note = buildWikiNote({
    meta: { title: 'Original Title', siteName: 'Creator Science', url: 'https://e.com/p' },
    distill: {
      title: 'Retention compounds',
      department: 'content',
      tags: ['retention', 'youtube-strategy'],
      takeaway: 'Retention compounds.',
      notes_md: '## Core ideas\n- one\n- two',
      apply: 'Check retention weekly.'
    },
    dateStr: '2026-07-08',
    rawRelPath: 'raw/articles/2026-07-08-retention-compounds.md'
  });
  assert.ok(note.startsWith('---\n'));
  assert.ok(note.includes('title: Retention compounds'));
  assert.ok(note.includes('department: content'));
  assert.ok(note.includes('behaviors: [learn]'));
  assert.ok(note.includes('source: capture:https://e.com/p'));
  assert.ok(note.includes('updated: 2026-07-08'));
  assert.ok(note.includes('## Source'));
  assert.ok(note.includes('## Apply'));
  assert.ok(note.includes('Check retention weekly.'));
  // must pass the real linter
  const { noteErrors } = require('../system/lib/note-write.js');
  assert.deepStrictEqual(noteErrors(note), []);
});

/* ------------------------------- wikiHasUrl ------------------------------ */

test('wikiHasUrl: finds a canonical URL in wiki source lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-wiki-'));
  fs.mkdirSync(path.join(dir, 'content', 'learning'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'content', 'learning', 'a.md'),
    '---\ntitle: A\ndepartment: content\nsource: capture:https://x.com/openai/status/2074704958419792299\nupdated: 2026-07-08\n---\nbody\n'
  );
  assert.strictEqual(wikiHasUrl('https://x.com/openai/status/2074704958419792299', dir), true);
  // share-tracking variant of the same link still counts as a duplicate
  assert.strictEqual(wikiHasUrl('https://x.com/openai/status/2074704958419792299?s=46&t=zz', dir), true);
  assert.strictEqual(wikiHasUrl('https://x.com/openai/status/999', dir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------- thread + linked articles ---------------------- */

const { extractLinks, buildThreadContent } = require('../system/telegram/web.js');

test('extractLinks: non-twitter links only, deduped, capped at 2', () => {
  const text = [
    'read https://openai.com/index/introducing-gpt-live/ and',
    'https://x.com/foo/status/123 plus https://openai.com/index/introducing-gpt-live/',
    'also https://example.com/a and https://example.com/b'
  ].join(' ');
  assert.deepStrictEqual(extractLinks(text), [
    'https://openai.com/index/introducing-gpt-live/',
    'https://example.com/a'
  ]);
});

test('extractLinks: empty/no-link text -> []', () => {
  assert.deepStrictEqual(extractLinks('no links here'), []);
  assert.deepStrictEqual(extractLinks(''), []);
});

test('buildThreadContent: single tweet behaves like tweetToContent', () => {
  const c = buildThreadContent([FX_TWEET]);
  assert.strictEqual(c.siteName, 'X (@OpenAI)');
  assert.ok(c.title.startsWith('GPT-5.6 Sol'));
  assert.strictEqual(c.image, 'https://pbs.twimg.com/media/abc.jpg');
  assert.ok(!c.text.includes('Post 1'), 'single tweet should not be numbered');
});

test('buildThreadContent: multi-tweet thread is numbered root-first and titled from the root', () => {
  const root = { text: 'Introducing GPT-Live, a new generation of voice models.', author: { screen_name: 'OpenAI' } };
  const second = { text: 'GPT-Live makes talking with AI feel natural.\nhttps://openai.com/index/introducing-gpt-live/', author: { screen_name: 'OpenAI' } };
  const c = buildThreadContent([root, second]);
  assert.ok(c.title.startsWith('Introducing GPT-Live'), 'title should come from the ROOT tweet');
  assert.strictEqual(c.siteName, 'X (@OpenAI), thread of 2 posts');
  assert.ok(c.text.includes('Post 1:') && c.text.includes('Post 2:'));
  assert.ok(c.text.indexOf('Introducing') < c.text.indexOf('feel natural'));
});

test('buildThreadContent: includes quoted tweet text when present', () => {
  const t = {
    text: 'This is huge.',
    author: { screen_name: 'sam' },
    quote: { text: 'Original claim here.', author: { screen_name: 'someone' } }
  };
  const c = buildThreadContent([t]);
  assert.ok(c.text.includes('Quoting @someone: Original claim here.'));
});

/* ---------------------------- parseLinkedInUrl -------------------------- */

const { parseLinkedInUrl } = require('../system/telegram/web.js');

test('parseLinkedInUrl: posts and pulse URLs match', () => {
  const a = parseLinkedInUrl('https://www.linkedin.com/posts/melaniedeziel_ai-is-coming-activity-7438690113863237632-cIL9');
  assert.ok(a);
  assert.strictEqual(a.user, 'melaniedeziel');
  const b = parseLinkedInUrl('https://linkedin.com/pulse/some-article-title-someone');
  assert.ok(b);
  const c = parseLinkedInUrl('https://et.linkedin.com/posts/dylan-kaplan-9ab520b0_top-100-activity-6996071537904607232-ejZB');
  assert.ok(c);
  assert.strictEqual(c.user, 'dylan-kaplan-9ab520b0');
});

test('parseLinkedInUrl: profiles, company pages, non-LinkedIn -> null', () => {
  assert.strictEqual(parseLinkedInUrl('https://www.linkedin.com/in/melaniedeziel/'), null);
  assert.strictEqual(parseLinkedInUrl('https://www.linkedin.com/company/anthropic/'), null);
  assert.strictEqual(parseLinkedInUrl('https://example.com/posts/x'), null);
  assert.strictEqual(parseLinkedInUrl(null), null);
});
