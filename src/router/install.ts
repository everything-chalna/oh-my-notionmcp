import { resolveOfficialBackendConfig } from './config.js'
import {
  APP_BIN_NAME,
  DEFAULT_ROUTER_SERVER_NAME,
  loadMcpConfig,
  resolveBinPath,
  resolveMcpPath,
  resolveProjectDir,
  sanitizePersistedEnv,
  saveMcpConfig,
  type ParsedOptions,
} from './utils.js'

export function commandInstall(options: ParsedOptions): void {
  const projectDir = resolveProjectDir(options)
  const mcpPath = resolveMcpPath(projectDir)
  const serverName = typeof options.name === 'string' ? options.name : DEFAULT_ROUTER_SERVER_NAME

  const config = loadMcpConfig(mcpPath)

  const selfBin = resolveBinPath()
  const officialBackend = resolveOfficialBackendConfig()
  const { sanitized: persistedOfficialEnv, redactedKeys: redactedOfficialKeys } = sanitizePersistedEnv(
    officialBackend.env,
  )

  const entry: Record<string, unknown> = {
    command: 'node',
    args: [selfBin, 'serve'],
    env: {
      OHMY_NOTION_OFFICIAL_COMMAND: officialBackend.command,
      OHMY_NOTION_OFFICIAL_ARGS_JSON: JSON.stringify(officialBackend.args),
      OHMY_NOTION_OFFICIAL_ENV_JSON: JSON.stringify(persistedOfficialEnv),
    },
  }

  const env = entry.env as Record<string, string>
  if (officialBackend.cwd) {
    env.OHMY_NOTION_OFFICIAL_CWD = officialBackend.cwd
  }

  config.mcpServers[serverName] = entry
  saveMcpConfig(mcpPath, config)

  console.log(`Updated ${mcpPath}`)
  console.log(`- Added/updated router server: ${serverName}`)
  console.log(`- Command: node ${selfBin} serve`)
  if (redactedOfficialKeys.length > 0) {
    console.log(`- Security: redacted sensitive env keys from persisted config: ${redactedOfficialKeys.join(', ')}`)
  }
  console.log('')
  console.log('Next steps:')
  console.log(`1) ${APP_BIN_NAME} login`)
  console.log(`2) ${APP_BIN_NAME} doctor --project ${projectDir} --name ${serverName}`)
}
