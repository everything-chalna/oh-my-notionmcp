import { describe, it, expect } from 'vitest'
import { renderAuthTemplate } from '../../../src/fast/openapi-mcp-server/auth/template'
import type { AuthTemplate, TemplateContext } from '../../../src/fast/openapi-mcp-server/auth/types'

describe('renderAuthTemplate', () => {
  const baseTemplate: AuthTemplate = {
    url: 'https://api.example.com/oauth/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }

  const baseContext: TemplateContext = {
    args: {},
  }

  it('renders URL with Mustache template variables', () => {
    const template: AuthTemplate = {
      ...baseTemplate,
      url: 'https://api.example.com/{{args.tenant}}/oauth/token',
    }
    const context: TemplateContext = { args: { tenant: 'acme' } }
    const result = renderAuthTemplate(template, context)
    expect(result.url).toBe('https://api.example.com/acme/oauth/token')
  })

  it('renders body when present', () => {
    const template: AuthTemplate = {
      ...baseTemplate,
      body: 'grant_type=client_credentials&client_id={{args.clientId}}',
    }
    const context: TemplateContext = { args: { clientId: 'my-client' } }
    const result = renderAuthTemplate(template, context)
    expect(result.body).toBe('grant_type=client_credentials&client_id=my-client')
  })

  it('preserves original template (no mutation)', () => {
    const template: AuthTemplate = {
      url: 'https://api.example.com/{{args.tenant}}/token',
      method: 'POST',
      headers: { Authorization: 'Basic abc' },
      body: 'scope={{args.scope}}',
    }
    const originalUrl = template.url
    const originalBody = template.body
    const originalHeaders = { ...template.headers }

    renderAuthTemplate(template, { args: { tenant: 'x', scope: 'read' } })

    expect(template.url).toBe(originalUrl)
    expect(template.body).toBe(originalBody)
    expect(template.headers).toEqual(originalHeaders)
  })

  it('does not HTML-escape URLs (& stays &, not &amp;)', () => {
    const template: AuthTemplate = {
      ...baseTemplate,
      url: 'https://api.example.com/token?a=1&b=2&c={{args.val}}',
    }
    const context: TemplateContext = { args: { val: 'x&y' } }
    const result = renderAuthTemplate(template, context)
    expect(result.url).toBe('https://api.example.com/token?a=1&b=2&c=x&y')
    expect(result.url).not.toContain('&amp;')
  })

  it('handles empty context args', () => {
    const result = renderAuthTemplate(baseTemplate, baseContext)
    expect(result.url).toBe(baseTemplate.url)
    expect(result.method).toBe(baseTemplate.method)
  })

  it('renders with securityScheme context', () => {
    const template: AuthTemplate = {
      ...baseTemplate,
      url: '{{securityScheme.oauth2.tokenUrl}}',
    }
    const context: TemplateContext = {
      args: {},
      securityScheme: {
        oauth2: { tokenUrl: 'https://auth.example.com/token' },
      },
    }
    const result = renderAuthTemplate(template, context)
    expect(result.url).toBe('https://auth.example.com/token')
  })

  it('renders with servers context', () => {
    const template: AuthTemplate = {
      ...baseTemplate,
      url: '{{servers.0.url}}/oauth/token',
    }
    const context: TemplateContext = {
      args: {},
      servers: [{ url: 'https://api.prod.example.com' }],
    }
    const result = renderAuthTemplate(template, context)
    expect(result.url).toBe('https://api.prod.example.com/oauth/token')
  })

  it('handles template with no variables', () => {
    const template: AuthTemplate = {
      ...baseTemplate,
      url: 'https://static.example.com/token',
    }
    const result = renderAuthTemplate(template, { args: { unused: 'value' } })
    expect(result.url).toBe('https://static.example.com/token')
  })

  it('handles missing body (undefined)', () => {
    const template: AuthTemplate = {
      url: 'https://api.example.com/token',
      method: 'GET',
      headers: {},
    }
    const result = renderAuthTemplate(template, baseContext)
    expect(result.body).toBeUndefined()
  })

  it('preserves headers without modification', () => {
    const template: AuthTemplate = {
      url: 'https://api.example.com/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic secret',
        'X-Custom': 'static-value',
      },
    }
    const result = renderAuthTemplate(template, { args: { credentials: 'abc123' } })
    expect(result.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic secret',
      'X-Custom': 'static-value',
    })
    expect(result.headers).not.toBe(template.headers)
  })
})
