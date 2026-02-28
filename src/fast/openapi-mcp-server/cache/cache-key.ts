import { createHash } from 'node:crypto'

export type CacheKeyOperation = {
  method: string
  path: string
  operationId?: string | null
}

function serializeDeterministic(value: unknown, seen: WeakSet<object>): string | undefined {
  if (value === null) {
    return 'null'
  }

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return JSON.stringify(value)
    case 'bigint':
      return JSON.stringify(value.toString())
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined
    default:
      break
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString())
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => {
      const serialized = serializeDeterministic(item, seen)
      return serialized ?? 'null'
    })
    return `[${items.join(',')}]`
  }

  const objectValue = value as Record<string, unknown>
  const toJSON = objectValue.toJSON
  if (typeof toJSON === 'function') {
    const transformed = toJSON.call(value)
    if (transformed !== value) {
      return serializeDeterministic(transformed, seen)
    }
  }

  if (seen.has(objectValue)) {
    throw new TypeError('Cannot stringify circular structure')
  }
  seen.add(objectValue)

  const entries = Object.keys(objectValue)
    .sort()
    .map((key) => {
      const serialized = serializeDeterministic(objectValue[key], seen)
      if (serialized === undefined) {
        return null
      }
      return `${JSON.stringify(key)}:${serialized}`
    })
    .filter((entry): entry is string => entry !== null)

  seen.delete(objectValue)
  return `{${entries.join(',')}}`
}

/**
 * Stable JSON-like stringify that sorts object keys recursively.
 */
export function deterministicStringify(value: unknown): string {
  return serializeDeterministic(value, new WeakSet()) ?? 'null'
}

/**
 * Build a stable cache key from OpenAPI operation metadata + params.
 *
 * Key format:
 * openapi-cache:v1:<METHOD>:<PATH>:<OPERATION_ID_OR_DASH>:<SHA256_HEX>
 */
export function createCacheKey(operation: CacheKeyOperation, params: unknown): string {
  const normalizedOperation = {
    method: operation.method.toUpperCase(),
    path: operation.path,
    operationId: operation.operationId ?? null,
  }

  const payload = deterministicStringify({
    operation: normalizedOperation,
    params,
  })
  const digest = createHash('sha256').update(payload).digest('hex')
  const operationId = normalizedOperation.operationId ?? '-'

  return `openapi-cache:v1:${normalizedOperation.method}:${normalizedOperation.path}:${operationId}:${digest}`
}
