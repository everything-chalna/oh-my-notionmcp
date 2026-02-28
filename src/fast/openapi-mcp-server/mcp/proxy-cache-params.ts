export const MCP_FAST_FORCE_REFRESH_FIELD = '__mcpFastForceRefresh' as const

export type ProxyCacheParamsSplitResult<TParams extends Record<string, unknown>> = {
  sanitizedParams: Omit<TParams, typeof MCP_FAST_FORCE_REFRESH_FIELD>
  forceRefresh: boolean
}

export function splitProxyCacheParams<TParams extends Record<string, unknown>>(
  params: TParams | null | undefined,
): ProxyCacheParamsSplitResult<TParams> {
  if (!params) {
    return {
      sanitizedParams: {} as Omit<TParams, typeof MCP_FAST_FORCE_REFRESH_FIELD>,
      forceRefresh: false,
    }
  }

  const { [MCP_FAST_FORCE_REFRESH_FIELD]: forceRefreshMeta, ...sanitizedParams } = params

  return {
    sanitizedParams: sanitizedParams as Omit<TParams, typeof MCP_FAST_FORCE_REFRESH_FIELD>,
    forceRefresh: typeof forceRefreshMeta === 'boolean' ? forceRefreshMeta : false,
  }
}
