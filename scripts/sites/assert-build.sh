#!/usr/bin/env bash
# Asserts what a static site's build promises (ADR-0028, ADR-0033), in the T0 build job (no
# secrets): the files every deploy requires (check_dist), plus per-site content checks. For the
# docs: search, a Markdown twin per page and an llms.txt entry per twin. For the marketing site: no
# script or inline style in any page (its CSP allows neither) and a sitemap listing its pages.
# Usage: SITE=docs|site scripts/sites/assert-build.sh   (after `pnpm --filter $SITE build`)
source "$(dirname "$0")/lib.sh"
dist="$ROOT/apps/$SITE/dist"
[ -d "$dist" ] || die "no build at apps/$SITE/dist"
check_dist "$dist"
cd "$dist"

case "$SITE" in
  docs)
    for f in guides/getting-started.md pagefind/pagefind.js pagefind/pagefind-entry.json; do
      [ -s "$f" ] || die "missing or empty: $f"
    done
    # Every page has a Markdown twin, llms.txt lists each twin once, and search indexed each page.
    pages="$(find . -name index.html -not -path './pagefind/*' | sed 's|^\./||; s|/*index\.html$||; s|^$|index|' | sort)"
    twins="$(find . -name '*.md' | sed 's|^\./||; s|\.md$||' | sort)"
    listed="$(grep '^- ' llms.txt | sed "s|^- \[.*\](https://${SITE_HOST//./\\.}/\(.*\)\.md).*$|\1|" | sort)"
    printf 'pages:\n%s\ntwins:\n%s\nllms.txt:\n%s\n' "$pages" "$twins" "$listed"
    [ -n "$pages" ] && [ "$pages" = "$twins" ] && [ "$twins" = "$listed" ] || die "pages, .md twins and llms.txt entries differ"
    count="$(grep -c '' <<<"$pages")"
    indexed="$(jq '[.languages[].page_count] | add' pagefind/pagefind-entry.json)"
    fragments="$(find pagefind/fragment -name '*.pf_fragment' | wc -l)"
    chunks="$(find pagefind/index -name '*.pf_index' | wc -l)"
    echo "pages=$count indexed=$indexed fragments=$fragments index_chunks=$chunks"
    [ "$indexed" = "$count" ] && [ "$fragments" = "$count" ] && [ "$chunks" -gt 0 ] || die "search index doesn't cover every page"
    ;;
  site)
    inline="$(grep -l -E '<script|<style|[[:space:]]style=' $(find . -name '*.html') || true)"
    [ -z "$inline" ] || die "scripts or inline styles (the CSP blocks them) in: $inline"
    for path in / /pricing/; do
      grep -q "<loc>https://$SITE_HOST$path</loc>" sitemap-0.xml || die "the sitemap doesn't list $path"
    done
    ! grep -q '404' sitemap-0.xml || die "the sitemap lists the 404 page"
    ;;
esac
log "build OK"
