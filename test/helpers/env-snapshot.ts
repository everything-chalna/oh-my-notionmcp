export async function withEnvSnapshot<T>(fn: () => T | Promise<T>): Promise<T> {
  const snapshot = { ...process.env }
  try {
    return await fn()
  } finally {
    // Restore: remove keys that were added, restore changed keys
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) {
        delete process.env[key]
      }
    }
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}
