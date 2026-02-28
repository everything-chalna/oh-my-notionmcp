import { describe, expect, it } from 'vitest'
import notionOpenApi from '../../../scripts/notion-openapi.json'
import { OpenAPIV3 } from 'openapi-types'

import { READ_OPERATION_IDS, READ_OPERATION_METHODS } from '../../../src/fast/openapi-mcp-server/mcp/read-only-allowlist'

describe('read-only operation allowlist', () => {
  it('matches the current read policy derived from Notion OpenAPI', () => {
    const spec = notionOpenApi as unknown as OpenAPIV3.Document
    const operationMethodsById = new Map<string, Set<string>>()
    const derivedReadOperationMethods = new Map<string, 'get' | 'post'>()
    const readOnlyPostOperations = new Set(['post-search', 'query-data-source'])
    const supportedMethods = new Set(['get', 'post', 'put', 'patch', 'delete'])

    for (const pathItem of Object.values(spec.paths ?? {})) {
      if (!pathItem) {
        continue
      }

      for (const [method, operation] of Object.entries(pathItem)) {
        if (!supportedMethods.has(method)) {
          continue
        }
        if (!operation || typeof operation !== 'object' || !('operationId' in operation)) {
          continue
        }

        const operationId = operation.operationId
        if (!operationId) {
          continue
        }

        const methodSet = operationMethodsById.get(operationId) ?? new Set<string>()
        methodSet.add(method)
        operationMethodsById.set(operationId, methodSet)

        if (method === 'get') {
          derivedReadOperationMethods.set(operationId, 'get')
          continue
        }
        if (method === 'post' && readOnlyPostOperations.has(operationId)) {
          derivedReadOperationMethods.set(operationId, 'post')
        }
      }
    }

    expect(READ_OPERATION_METHODS).toEqual(derivedReadOperationMethods)
    for (const [operationId, expectedMethod] of READ_OPERATION_METHODS.entries()) {
      expect(operationMethodsById.get(operationId)).toEqual(new Set([expectedMethod]))
    }
    expect(READ_OPERATION_IDS.size).toBe(13)
  })
})
