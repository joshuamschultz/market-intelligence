import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { helpTopic, searchHelp } from '../frontend/help.js';
import { names } from '../frontend/ui.js';

const { version, topics } = JSON.parse(await readFile(new URL('../frontend/help-content.json', import.meta.url), 'utf8'));
const routeUrl = (page) => `#${page}?universe=sample`;

test('every view has an addressable guide and glossary terms open a rendered definition', () => {
  assert.equal(version, 1);
  const ids = new Set(topics.map(({ id }) => id));
  assert.equal(ids.size, topics.length);
  for (const page of Object.keys(names)) assert.ok(ids.has(page), page);
  for (const topic of topics) assert.ok((topic.related || []).every((id) => ids.has(id)));
  const result = searchHelp(topics, 'breadth percentage').find((match) => match.anchor);
  assert.ok(result, 'a matching glossary definition');
  const rendered = helpTopic(topics, result.id, routeUrl);
  const dom = new JSDOM(rendered.html);
  const definition = dom.window.document.getElementById(result.anchor);
  assert.equal(definition.querySelector('dt').textContent, result.title);
  dom.window.close();
});

test('guide text is escaped and links can only lead to app routes or HTTPS sources', () => {
  const { html } = helpTopic([{
    id: 'overview', title: '<script>title</script>', summary: '<b>summary</b>',
    sections: [{ heading: 'Input', definitions: [{ term: '<img src=x onerror=bad()>', text: 'literal text', formula: '<b>literal formula</b>' }] }],
    links: [
      { label: 'Blocked', href: 'javascript:alert(1)' },
      { label: 'Settings', href: '#settings' },
      { label: 'Reference', href: 'https://example.test/method' },
    ],
  }], 'overview', routeUrl);
  const dom = new JSDOM(html);
  const document = dom.window.document;
  assert.equal(document.querySelectorAll('img, script, b').length, 0);
  assert.equal(document.querySelector('code').textContent, '<b>literal formula</b>');
  const links = [...document.querySelectorAll('a')];
  assert.deepEqual(links.map((link) => link.getAttribute('href')), ['#settings?universe=sample', 'https://example.test/method']);
  assert.equal(links[1].rel, 'noopener noreferrer');
  dom.window.close();
});
