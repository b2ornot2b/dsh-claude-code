import { describe, expect, it } from 'vitest'

import { translatePath } from '../src/paths.ts'

/**
 * Path translation. b2umini sees b2studio's `/Users/b2/Developer/mine/grigios`
 * as `/System/Volumes/Data/mnt/b2/Developer/mine/grigios` (design P7), so a
 * cwd is only meaningful once it has been re-expressed in local terms.
 */

const MAP = [{ from: '/System/Volumes/Data/mnt/b2', to: '/Users/b2' }]

describe('translatePath', () => {
  it('rewrites a mapped prefix and leaves everything else alone', () => {
    expect(translatePath(MAP, '/System/Volumes/Data/mnt/b2/Developer/mine/grigios'))
      .toBe('/Users/b2/Developer/mine/grigios')
    expect(translatePath(MAP, '/Users/b2/Developer/mine/b2infra'))
      .toBe('/Users/b2/Developer/mine/b2infra')
  })

  it('only matches whole path segments', () => {
    // A prefix that is not a segment boundary must not be rewritten.
    expect(translatePath([{ from: '/mnt/b2', to: '/Users/b2' }], '/mnt/b2extra/thing'))
      .toBe('/mnt/b2extra/thing')
  })

  it('applies the longest matching prefix', () => {
    const map = [
      { from: '/mnt', to: '/a' },
      { from: '/mnt/b2', to: '/Users/b2' },
    ]

    expect(translatePath(map, '/mnt/b2/Developer')).toBe('/Users/b2/Developer')
  })
})
