// Starlight's own filter (utils/routing): drafts are built in dev only, never in production.
export const published = ({ data }: { data: { draft: boolean } }) =>
  import.meta.env.MODE !== 'production' || !data.draft
