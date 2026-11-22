import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = path.join(webRoot, 'openapi.json')
const generatedPath = path.join(webRoot, 'src', 'types', 'openapi.gen.ts')
const driftMessage =
  '契约未同步：src/types/openapi.gen.ts 已过期或被手动修改，请运行 make gen-api。'

if (!existsSync(schemaPath) || !existsSync(generatedPath)) {
  console.error(driftMessage)
  process.exit(1)
}

const tempDir = mkdtempSync(path.join(tmpdir(), 'vs-openapi-'))
const tempOut = path.join(tempDir, 'openapi.gen.ts')

try {
  execFileSync('pnpm', ['exec', 'openapi-typescript', schemaPath, '-o', tempOut], {
    cwd: webRoot,
    stdio: 'pipe',
  })
  const expected = readFileSync(tempOut, 'utf8')
  const actual = readFileSync(generatedPath, 'utf8')
  if (expected !== actual) {
    console.error(driftMessage)
    process.exit(1)
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
