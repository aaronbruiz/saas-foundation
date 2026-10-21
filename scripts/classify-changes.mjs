import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// An allowlist: new paths get the full suite until explicitly reviewed.
export function classifyChanges(files, expectedCount) {
  const safe = (path) =>
    typeof path === 'string' && /^(apps\/(docs|site)\/|docs\/|[^/]+\.md$)/.test(path)
  return Array.isArray(files) &&
    Number.isSafeInteger(expectedCount) &&
    expectedCount > 0 &&
    files.length === expectedCount &&
    files.every(
      (file) =>
        file &&
        safe(file.filename) &&
        (file.previous_filename === undefined || safe(file.previous_filename)),
    )
    ? 'light'
    : 'full'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result = 'full'
  try {
    if (process.argv[2] === '--pr-files') {
      result = classifyChanges(JSON.parse(readFileSync(0, 'utf8')), Number(process.argv[3]))
    } else if (process.argv[2]) {
      // Disabling rename detection includes both the deleted and added paths.
      const names = execFileSync(
        'git',
        ['diff', '--name-only', '--no-renames', '-z', process.argv[2], 'HEAD', '--'],
        { encoding: 'utf8' },
      )
      const files = names
        .split('\0')
        .filter(Boolean)
        .map((filename) => ({ filename }))
      result = classifyChanges(files, files.length)
    }
  } catch {
    // An unreadable or incomplete diff must never skip app checks.
  }
  console.log(result)
}
