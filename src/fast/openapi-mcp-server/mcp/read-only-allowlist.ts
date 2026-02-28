// Keep a single source of truth for read operations exposed by the fast backend.
// If upstream Notion OpenAPI changes, update this map intentionally.
export const READ_OPERATION_METHODS = new Map<string, 'get' | 'post'>([
  ['get-user', 'get'],
  ['get-users', 'get'],
  ['get-self', 'get'],
  ['post-search', 'post'],
  ['get-block-children', 'get'],
  ['retrieve-a-block', 'get'],
  ['retrieve-a-page', 'get'],
  ['retrieve-a-page-property', 'get'],
  ['retrieve-a-comment', 'get'],
  ['query-data-source', 'post'],
  ['retrieve-a-data-source', 'get'],
  ['list-data-source-templates', 'get'],
  ['retrieve-a-database', 'get'],
])

export const READ_OPERATION_IDS = new Set<string>(READ_OPERATION_METHODS.keys())

export type OperationWithMethodAndId = {
  method?: string
  operationId?: string
}

export function isReadOnlyOperationAllowlisted(operation: OperationWithMethodAndId): boolean {
  if (!operation.operationId || !operation.method) {
    return false
  }
  const method = operation.method.toLowerCase()
  const expectedMethod = READ_OPERATION_METHODS.get(operation.operationId)
  return expectedMethod === method
}
