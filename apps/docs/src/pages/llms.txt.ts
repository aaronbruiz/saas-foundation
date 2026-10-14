// ADR-0028 decision 3: an llmstxt.org index of the Markdown twins (`[...slug].md.ts`).
import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'

export const GET: APIRoute = async ({ site }) => {
  // The home page first, then the rest by path.
  const pages = (await getCollection('docs')).sort(
    (a, b) => Number(b.id === 'index') - Number(a.id === 'index') || a.id.localeCompare(b.id),
  )
  const home = pages.find((p) => p.id === 'index')
  const url = (id: string) => new URL(`/${id}.md`, site).href
  const lines = [
    `# ${home?.data.title ?? 'Documentation'}`,
    '',
    ...(home?.data.description ? [`> ${home.data.description}`, ''] : []),
    '## Docs',
    '',
    ...pages.map(
      (p) =>
        `- [${p.data.title}](${url(p.id)})${p.data.description ? `: ${p.data.description}` : ''}`,
    ),
  ]
  return new Response(`${lines.join('\n')}\n`)
}
