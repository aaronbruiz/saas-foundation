import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// An allowlist: new paths get the full suite until explicitly reviewed.
export function classifyChanges(files) {
  return files.length > 0 &&
    files.every((path) => /^(apps\/(docs|site)\/|docs\/|[^/]+\.md$)/.test(path))
    ? 'light'
    : 'full'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result = 'full'
  try {
    if (process.argv[2]) {
      // Disabling rename detection includes both the deleted and added paths.
      const names = execFileSync(
        'git',
        ['diff', '--name-only', '--no-renames', '-z', process.argv[2], 'HEAD', '--'],
        { encoding: 'utf8' },
      )
      result = classifyChanges(names.split('\0').filter(Boolean))
    }
  } catch {
    // An unreadable diff must never skip app checks.
  }
  console.log(result)
}
