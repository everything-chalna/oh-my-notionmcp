import { resolveOfficialBackendConfig } from './config.js'
import { buildChildEnv, runCommand, type ParsedOptions } from './utils.js'

export function commandLogin(_options?: ParsedOptions): void {
  const official = resolveOfficialBackendConfig()
  console.log('Starting official MCP OAuth bootstrap via mcp-remote...')
  console.log('Complete browser authentication, then press Ctrl+C after "Proxy established".')
  const result = runCommand(official.command, official.args, {
    cwd: official.cwd,
    stdio: 'inherit',
    env: buildChildEnv(official.env),
  })

  if (result.error) {
    throw new Error(`login failed: ${(result.error && result.error.message) || String(result.error)}`)
  }

  const interrupted = result.signal === 'SIGINT' || result.status === 130
  if (result.status !== 0 && !interrupted) {
    const signalSuffix = result.signal ? ` signal=${result.signal}` : ''
    throw new Error(`login failed: exit=${result.status}${signalSuffix}`)
  }
}
