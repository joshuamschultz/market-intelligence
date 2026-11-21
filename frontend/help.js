import { action, icon, names, safe } from './ui.js';

let handbook;

export function loadHelp() {
  handbook ||= fetch('/help-content.json').then(async (response) => {
    if (!response.ok) throw new Error('The workspace guide could not be loaded.');
    const content = await response.json();
    if (content.version !== 1 || !Array.isArray(content.topics)) throw new Error('The workspace guide could not be read.');
    return content.topics;
  }).catch((error) => {
    handbook = undefined;
    throw error;
  });
  return handbook;
}

function matches(query, text) {
  const haystack = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).every((term) => haystack.includes(term));
}

export function searchHelp(topics, query) {
  if (!query) return [];
  const definitions = topics.flatMap((topic) => topic.sections.flatMap((section, s) =>
    (section.definitions || []).flatMap((definition, d) => matches(query, definition.term)
      ? [{ id: topic.id, title: definition.term, description: topic.title, anchor: `help-definition-${s}-${d}` }] : [])));
  const guides = topics.filter((topic) => matches(query, [topic.title, topic.summary, ...topic.sections.flatMap(
    ({ heading, paragraphs = [], steps = [] }) => [heading, ...paragraphs, ...steps])].join(' ')))
    .map(({ id, title, summary }) => ({ id, title, description: summary }));
  return [...definitions, ...guides].slice(0, 8);
}

function referenceLink({ href, label }, routeUrl) {
  const route = /^#([a-z]+)$/.exec(href)?.[1];
  if (route && Object.hasOwn(names, route)) return `<a class="text-link" href="${safe(routeUrl(route))}">${safe(label)}</a>`;
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return `<a class="text-link" href="${safe(url.href)}" target="_blank" rel="noopener noreferrer">${safe(label)} ${icon('arrow-up-right')}</a>`;
  } catch {
    return '';
  }
}

export function helpTopic(topics, id, routeUrl) {
  const topic = topics.find((item) => item.id === id) || topics.find((item) => item.id === 'overview') || topics[0];
  if (!topic) return { title: 'Workspace help', html: '<p class="muted">No guide topics are available.</p>' };
  const html = `<div class="stack help-guide">
    <label class="field"><span>Guide topic</span><select data-help-topic aria-label="Guide topic">${topics.map((item) =>
      `<option value="${safe(item.id)}"${item.id === topic.id ? ' selected' : ''}>${safe(item.title)}</option>`).join('')}</select></label>
    <p class="muted">${safe(topic.summary)}</p>
    ${topic.sections.map((section, s) => `<section class="help-section"><h3>${safe(section.heading)}</h3>
      ${(section.paragraphs || []).map((paragraph) => `<p>${safe(paragraph)}</p>`).join('')}
      ${section.steps?.length ? `<ol>${section.steps.map((step) => `<li>${safe(step)}</li>`).join('')}</ol>` : ''}
      ${section.definitions?.length ? `<dl>${section.definitions.map((definition, d) =>
        `<div id="help-definition-${s}-${d}" tabindex="-1"><dt>${safe(definition.term)}</dt><dd>${safe(definition.text)}
          ${definition.formula ? `<code>${safe(definition.formula)}</code>` : ''}</dd></div>`).join('')}</dl>` : ''}</section>`).join('')}
    ${topic.related?.length ? `<section class="help-section"><h3>Related topics</h3><div class="actions">${topic.related.map((related) => {
      const linked = topics.find((item) => item.id === related);
      return linked ? action(linked.title, 'help-topic', null, { value: linked.id }) : '';
    }).join('')}</div></section>` : ''}
    ${topic.links?.length ? `<div class="actions help-links">${topic.links.map((link) => referenceLink(link, routeUrl)).join('')}</div>` : ''}
  </div>`;
  return { title: topic.title, html };
}
