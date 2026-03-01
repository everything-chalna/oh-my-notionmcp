import { describe, expect, it } from 'vitest'

import { Headers } from '../../../src/fast/openapi-mcp-server/client/polyfill-headers'

describe('PolyfillHeaders', () => {
  it('append and get basic usage', () => {
    const h = new Headers()
    h.append('Content-Type', 'application/json')
    expect(h.get('Content-Type')).toBe('application/json')
  })

  it('case-insensitive key matching', () => {
    const h = new Headers()
    h.append('Content-Type', 'application/json')
    expect(h.get('content-type')).toBe('application/json')
    expect(h.get('CONTENT-TYPE')).toBe('application/json')
  })

  it('multiple values for same key joined with comma-space', () => {
    const h = new Headers()
    h.append('Accept', 'text/html')
    h.append('Accept', 'application/json')
    expect(h.get('Accept')).toBe('text/html, application/json')
  })

  it('returns null for non-existent key', () => {
    const h = new Headers()
    expect(h.get('X-Missing')).toBeNull()
  })

  it('constructor with init object', () => {
    const h = new Headers({ Authorization: 'Bearer token123', 'Content-Type': 'text/plain' })
    expect(h.get('Authorization')).toBe('Bearer token123')
    expect(h.get('Content-Type')).toBe('text/plain')
  })

  it('constructor with no init creates empty headers', () => {
    const h = new Headers()
    expect(h.get('Any-Header')).toBeNull()
  })

  it('append multiple different headers', () => {
    const h = new Headers()
    h.append('X-First', 'one')
    h.append('X-Second', 'two')
    h.append('X-Third', 'three')
    expect(h.get('X-First')).toBe('one')
    expect(h.get('X-Second')).toBe('two')
    expect(h.get('X-Third')).toBe('three')
  })

  it('get after appending to existing key', () => {
    const h = new Headers({ 'X-Custom': 'initial' })
    h.append('X-Custom', 'appended')
    expect(h.get('X-Custom')).toBe('initial, appended')
  })

  it('case insensitive with append', () => {
    const h = new Headers()
    h.append('x-token', 'abc')
    h.append('X-Token', 'def')
    expect(h.get('X-TOKEN')).toBe('abc, def')
  })

  it('handles empty string value', () => {
    const h = new Headers()
    h.append('X-Empty', '')
    expect(h.get('X-Empty')).toBe('')
  })
})
