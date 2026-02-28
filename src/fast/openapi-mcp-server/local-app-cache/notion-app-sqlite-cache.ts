import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'
import { LocalAppCacheConfig } from './config'

const execFileAsync = promisify(execFile)

type SqliteRow = Record<string, unknown>

type SqlRunner = (dbPath: string, sql: string) => Promise<SqliteRow[]>

type BlockRow = {
  id: string
  type: string
  parent_table?: string | null
  parent_id?: string | null
  space_id?: string | null
  created_time?: number | null
  last_edited_time?: number | null
  alive?: number | null
  properties?: string | null
  content?: string | null
  meta_last_access_timestamp?: number | null
}

type NotionRichText = {
  type: 'text'
  text: {
    content: string
    link: null
  }
  annotations: {
    bold: boolean
    italic: boolean
    strikethrough: boolean
    underline: boolean
    code: boolean
    color: 'default'
  }
  plain_text: string
  href: null
}

function toRichText(text: string): NotionRichText[] {
  if (!text) return []
  return [
    {
      type: 'text',
      text: {
        content: text,
        link: null,
      },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: 'default',
      },
      plain_text: text,
      href: null,
    },
  ]
}

function toIsoTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null
  }
  return new Date(raw).toISOString()
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Ignore parse failures and treat it as empty payload.
  }
  return {}
}

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return []
  }

  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed
    }
  } catch {
    // Ignore parse failures and treat it as empty payload.
  }
  return []
}

function parseJsonObjectStrict(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') {
    return null
  }

  if (raw.trim().length === 0) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Invalid snapshot payload.
  }
  return null
}

function parseJsonArrayStrict(raw: unknown): unknown[] | null {
  if (typeof raw !== 'string') {
    return null
  }

  if (raw.trim().length === 0) {
    return []
  }

  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed
    }
  } catch {
    // Invalid snapshot payload.
  }
  return null
}

function extractPlainText(rawPropertyValue: unknown): string {
  if (!Array.isArray(rawPropertyValue)) {
    return ''
  }

  return rawPropertyValue
    .map((part) => (Array.isArray(part) && typeof part[0] === 'string' ? part[0] : ''))
    .join('')
}

function buildPageProperties(rawProperties: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [name, value] of Object.entries(rawProperties)) {
    const text = extractPlainText(value)
    if (name === 'title') {
      result[name] = {
        id: 'title',
        type: 'title',
        title: toRichText(text),
      }
      continue
    }

    result[name] = {
      id: name,
      type: 'rich_text',
      rich_text: toRichText(text),
    }
  }

  if (!result.title) {
    result.title = {
      id: 'title',
      type: 'title',
      title: [],
    }
  }

  return result
}

function normalizePageOrBlockId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const compact = raw.trim().replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(compact)) return null
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''")
}

function mapLocalTypeToApiType(localType: string): string {
  switch (localType) {
    case 'text':
      return 'paragraph'
    case 'header':
      return 'heading_1'
    case 'sub_header':
      return 'heading_2'
    case 'sub_sub_header':
      return 'heading_3'
    case 'bulleted_list':
      return 'bulleted_list_item'
    case 'numbered_list':
      return 'numbered_list_item'
    case 'page':
      return 'child_page'
    default:
      return localType
  }
}

function buildBlockPayload(apiType: string, plainText: string): Record<string, unknown> {
  if (apiType === 'divider') {
    return {}
  }
  if (apiType === 'child_page') {
    return {
      title: plainText,
    }
  }
  if (apiType === 'to_do') {
    return {
      rich_text: toRichText(plainText),
      checked: false,
      color: 'default',
    }
  }
  return {
    rich_text: toRichText(plainText),
    color: 'default',
  }
}

function toNotionBlock(row: BlockRow): Record<string, unknown> {
  const properties = parseJsonObject(row.properties)
  const plainText = extractPlainText(properties.title)
  const apiType = mapLocalTypeToApiType(row.type)
  const children = parseJsonArray(row.content)

  return {
    object: 'block',
    id: row.id,
    created_time: toIsoTimestamp(row.created_time),
    last_edited_time: toIsoTimestamp(row.last_edited_time),
    archived: row.alive !== 1,
    in_trash: row.alive !== 1,
    has_children: children.length > 0,
    type: apiType,
    [apiType]: buildBlockPayload(apiType, plainText),
  }
}

async function defaultSqlRunner(dbPath: string, sql: string): Promise<SqliteRow[]> {
  const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql], {
    maxBuffer: 20 * 1024 * 1024,
  })

  const raw = stdout.trim()
  if (!raw) {
    return []
  }

  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? (parsed as SqliteRow[]) : []
}

export class NotionAppSqliteCache {
  private readonly config: LocalAppCacheConfig
  private readonly runSql: SqlRunner
  private readonly shouldCheckDbAccess: boolean

  constructor(config: LocalAppCacheConfig, runSql: SqlRunner = defaultSqlRunner) {
    this.config = config
    this.runSql = runSql
    this.shouldCheckDbAccess = runSql === defaultSqlRunner
  }

  async query(operationId: string | undefined, params: Record<string, unknown>): Promise<unknown | null> {
    if (!this.config.enabled || !operationId) {
      return null
    }

    if (this.shouldCheckDbAccess && !(await this.isDbReadable())) {
      return null
    }

    switch (operationId) {
      case 'retrieve-a-page':
        return this.retrievePage(params.page_id)
      case 'retrieve-a-block':
        return this.retrieveBlock(params.block_id)
      case 'get-block-children':
        return this.getBlockChildren(params)
      default:
        return null
    }
  }

  private async isDbReadable(): Promise<boolean> {
    try {
      await access(this.config.dbPath)
      return true
    } catch {
      return false
    }
  }

  private async retrievePage(pageId: unknown): Promise<Record<string, unknown> | null> {
    const normalizedId = normalizePageOrBlockId(pageId)
    if (!normalizedId) return null

    const sql = [
      'SELECT id, type, parent_table, parent_id, space_id, created_time, last_edited_time, alive, properties',
      'FROM block',
      `WHERE id='${escapeSqlString(normalizedId)}' AND type='page'`,
      'ORDER BY meta_last_access_timestamp DESC',
      'LIMIT 1;',
    ].join(' ')

    const rows = await this.runSql(this.config.dbPath, sql)
    if (rows.length === 0) return null

    const row = rows[0] as BlockRow
    if (normalizePageOrBlockId(row.id) !== normalizedId || row.type !== 'page') {
      return null
    }

    const rawProperties = parseJsonObjectStrict(row.properties)
    if (rawProperties === null) {
      return null
    }
    if (!Array.isArray(rawProperties.title)) {
      return null
    }

    return {
      object: 'page',
      id: row.id,
      created_time: toIsoTimestamp(row.created_time),
      last_edited_time: toIsoTimestamp(row.last_edited_time),
      archived: row.alive !== 1,
      in_trash: row.alive !== 1,
      url: `https://www.notion.so/${row.id.replace(/-/g, '')}`,
      parent: row.parent_table && row.parent_id
        ? {
            type: `${row.parent_table}_id`,
            [`${row.parent_table}_id`]: row.parent_id,
          }
        : undefined,
      properties: buildPageProperties(rawProperties),
    }
  }

  private async retrieveBlock(blockId: unknown): Promise<Record<string, unknown> | null> {
    const normalizedId = normalizePageOrBlockId(blockId)
    if (!normalizedId) return null

    const sql = [
      'SELECT id, type, created_time, last_edited_time, alive, properties, content, meta_last_access_timestamp',
      'FROM block',
      `WHERE id='${escapeSqlString(normalizedId)}'`,
      'ORDER BY meta_last_access_timestamp DESC',
      'LIMIT 1;',
    ].join(' ')

    const rows = await this.runSql(this.config.dbPath, sql)
    if (rows.length === 0) return null

    const row = rows[0] as BlockRow
    if (normalizePageOrBlockId(row.id) !== normalizedId || typeof row.type !== 'string' || row.type.trim().length === 0) {
      return null
    }
    if (parseJsonObjectStrict(row.properties) === null || parseJsonArrayStrict(row.content) === null) {
      return null
    }

    return toNotionBlock(row)
  }

  private async getBlockChildren(params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const normalizedBlockId = normalizePageOrBlockId(params.block_id)
    if (!normalizedBlockId) return null

    const parentSql = [
      'SELECT content',
      'FROM block',
      `WHERE id='${escapeSqlString(normalizedBlockId)}'`,
      'ORDER BY meta_last_access_timestamp DESC',
      'LIMIT 1;',
    ].join(' ')

    const parentRows = await this.runSql(this.config.dbPath, parentSql)
    if (parentRows.length === 0) {
      return null
    }

    const parentContent = parseJsonArrayStrict((parentRows[0] as BlockRow).content)
    if (parentContent === null) {
      return null
    }

    const childIds: string[] = []
    for (const childId of parentContent) {
      const normalizedChildId = normalizePageOrBlockId(childId)
      if (!normalizedChildId) {
        return null
      }
      childIds.push(normalizedChildId)
    }

    const pageSizeRaw = typeof params.page_size === 'number'
      ? params.page_size
      : Number.parseInt(String(params.page_size ?? ''), 10)
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
      ? Math.min(pageSizeRaw, this.config.maxPageSize)
      : this.config.maxPageSize

    let startIndex = 0
    if (params.start_cursor !== undefined && params.start_cursor !== null) {
      const startCursor = normalizePageOrBlockId(params.start_cursor)
      if (!startCursor) {
        return null
      }
      const cursorIndex = childIds.indexOf(startCursor)
      if (cursorIndex < 0) {
        return null
      }
      startIndex = cursorIndex + 1
    }
    const pagedChildIds = childIds.slice(startIndex, startIndex + pageSize)

    if (pagedChildIds.length === 0) {
      return {
        object: 'list',
        results: [],
        next_cursor: null,
        has_more: false,
        type: 'block',
        block: {},
      }
    }

    const inClause = pagedChildIds.map((id) => `'${escapeSqlString(id)}'`).join(',')
    const childrenSql = [
      'SELECT id, type, created_time, last_edited_time, alive, properties, content, meta_last_access_timestamp',
      'FROM block',
      `WHERE id IN (${inClause})`,
      'ORDER BY meta_last_access_timestamp DESC;',
    ].join(' ')

    const childRows = await this.runSql(this.config.dbPath, childrenSql)
    const latestRowById = new Map<string, BlockRow>()
    for (const row of childRows as BlockRow[]) {
      if (!latestRowById.has(row.id)) {
        latestRowById.set(row.id, row)
      }
    }

    const orderedRows: BlockRow[] = []
    for (const childId of pagedChildIds) {
      const row = latestRowById.get(childId)
      if (!row) {
        return null
      }
      if (normalizePageOrBlockId(row.id) !== childId || typeof row.type !== 'string' || row.type.trim().length === 0) {
        return null
      }
      if (parseJsonObjectStrict(row.properties) === null || parseJsonArrayStrict(row.content) === null) {
        return null
      }
      orderedRows.push(row)
    }

    const results = orderedRows.map((row) => toNotionBlock(row))

    const hasMore = startIndex + pagedChildIds.length < childIds.length
    const nextCursor = hasMore ? pagedChildIds[pagedChildIds.length - 1] : null

    return {
      object: 'list',
      results,
      next_cursor: nextCursor,
      has_more: hasMore,
      type: 'block',
      block: {},
    }
  }
}
