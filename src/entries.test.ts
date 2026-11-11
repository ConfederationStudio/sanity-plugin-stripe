import {existsSync, readFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {describe, expect, it} from 'vitest'

import {isObject} from './core/guards'
import {VERSION} from './version'

const SRC = dirname(fileURLToPath(import.meta.url))
const IMPORT = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

/** Every package an entry reaches, following its own files, type imports included. */
function packagesReached(entry: string): string[] {
  const packages = new Set<string>()
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2]
      if (!specifier) continue
      if (!specifier.startsWith('.')) {
        packages.add(specifier)
        continue
      }
      const base = resolve(dirname(file), specifier)
      const found = ['.ts', '.tsx', '/index.ts']
        .map((end) => base + end)
        .find((path) => existsSync(path))
      if (found) visit(found)
    }
  }
  visit(resolve(SRC, entry))
  return [...packages].toSorted()
}

describe('entry points', () => {
  it('gives the browser the cart with React alone: no Sanity, no Stripe', () => {
    expect(packagesReached('react/index.ts')).toEqual(['react'])
  })

  it('gives the server Stripe alone: no Sanity, no React', () => {
    expect(packagesReached('server/index.ts')).toEqual(['stripe'])
  })

  it('keeps Stripe out of the Studio', () => {
    const reached = packagesReached('index.ts')
    expect(reached.filter((name) => name.startsWith('stripe'))).toEqual([])
    expect(reached).toContain('sanity')
  })

  it('keeps the shared core free of all three', () => {
    expect(packagesReached('core/index.ts')).toEqual([])
  })
})

function manifest(): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(resolve(SRC, '../package.json'), 'utf8'))
  if (!isObject(value)) throw new TypeError('package.json is not an object')
  return value
}

describe('the version sent to Stripe', () => {
  it('is the package’s', () => {
    expect(manifest()).toMatchObject({version: VERSION})
  })
})

describe('the export map that is published', () => {
  // The working map has "source" entries for building in this repository. The package holds
  // `dist` alone, so the map in `publishConfig` is the one that goes out, when pnpm publishes.
  it('has every entry of the working map, each pointing into dist', () => {
    const {exports: working, publishConfig} = manifest()
    const published = isObject(publishConfig) ? publishConfig.exports : undefined
    if (!isObject(working) || !isObject(published)) throw new TypeError('an export map is missing')
    expect(Object.keys(published)).toEqual(Object.keys(working))
    for (const target of Object.values(published))
      expect(target).toMatch(/^\.\/(?:dist\/[\w-]+\.js|package\.json)$/)
  })
})
