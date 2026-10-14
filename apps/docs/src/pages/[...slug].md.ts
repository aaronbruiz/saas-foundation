// ADR-0028 decision 3: every page's Markdown source at `<route>.md` (the index at `/index.md`),
// for agents. Built as static files; `public/_headers` serves them as text/markdown.
import type { APIRoute, GetStaticPaths } from 'astro'
import { getCollection, type CollectionEntry } from 'astro:content'

export const getStaticPaths = (async () => {
  const pages = await getCollection('docs')
  return pages.map((page) => ({ params: { slug: page.id }, props: { page } }))
}) satisfies GetStaticPaths

export const GET: APIRoute = ({ props }) => {
  const { page } = props as { page: CollectionEntry<'docs'> }
  const intro = page.data.description ? `\n\n> ${page.data.description}` : ''
  return new Response(`# ${page.data.title}${intro}\n\n${(page.body ?? '').trim()}\n`)
}
