import { describe, expect, it } from 'vitest'
import { OpenAPIToMCPConverter } from '../../../src/fast/openapi-mcp-server/openapi/parser'
import notionOpenApi from '../../../scripts/notion-openapi.json'
import { OpenAPIV3 } from 'openapi-types'

describe('Notion read tool description parity', () => {
  it("keeps selected read tool descriptions in 'Notion | ... Error Responses...' format", () => {
    const converter = new OpenAPIToMCPConverter(notionOpenApi as unknown as OpenAPIV3.Document)
    const { tools } = converter.convertToMCPTools()
    const methodsByName = new Map(tools.API.methods.map((method) => [method.name, method]))

    const expectedDescriptions = new Map<string, string>([
      ['retrieve-a-block', 'Notion | Retrieve a block\nError Responses:\n400: Bad request'],
      ['retrieve-a-page', 'Notion | Retrieve a page\nError Responses:\n400: Bad request'],
      ['retrieve-a-page-property', 'Notion | Retrieve a page property item\nError Responses:\n400: Bad request'],
      ['retrieve-a-data-source', 'Notion | Retrieve a data source\nError Responses:\n400: Bad request'],
      ['retrieve-a-database', 'Notion | Retrieve a database\nError Responses:\n400: Bad request'],
    ])

    expectedDescriptions.forEach((expectedDescription, methodName) => {
      const method = methodsByName.get(methodName)
      expect(method, `Missing MCP method ${methodName}`).toBeDefined()
      expect(method?.description).toBe(expectedDescription)
    })
  })
})
