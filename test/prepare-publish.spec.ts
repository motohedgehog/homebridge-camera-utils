import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { preparePublish } from '../.github/scripts/prepare-publish.mjs'

const scriptPath = fileURLToPath(new URL('../.github/scripts/prepare-publish.mjs', import.meta.url))

function createInput() {
  const name = '@motohedgehog/camera-utils'
  const version = '3.0.0'
  const packageJson = { name, version }
  const packageLock = {
    name,
    version,
    lockfileVersion: 3,
    packages: { '': { name, version } },
  }

  return {
    ref: 'refs/heads/latest',
    runId: '123',
    runAttempt: '1',
    packageJson,
    packageLock,
  }
}

function expectRejectedWithoutMutation(input: ReturnType<typeof createInput>) {
  const before = JSON.stringify([input.packageJson, input.packageLock])

  expect(() => preparePublish(input)).toThrow()
  expect(JSON.stringify([input.packageJson, input.packageLock])).toBe(before)
}

let tempDirectory: string | undefined

afterEach(() => {
  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true })
    tempDirectory = undefined
  }
})

describe('preparePublish', () => {
  it('mutates package and lock versions for latest development releases', () => {
    const first = createInput()
    const retry = createInput()
    retry.runAttempt = '2'

    expect(preparePublish(first)).toEqual({ version: '3.0.0-dev.123.1', tag: 'latest' })
    expect(first.packageJson.version).toBe('3.0.0-dev.123.1')
    expect(first.packageLock.version).toBe('3.0.0-dev.123.1')
    expect(first.packageLock.packages[''].version).toBe('3.0.0-dev.123.1')
    expect(preparePublish(retry)).toEqual({ version: '3.0.0-dev.123.2', tag: 'latest' })
  })

  it('returns a stable tag without changing either manifest', () => {
    const input = createInput()
    input.ref = 'refs/tags/v3.0.0'
    const before = JSON.stringify([input.packageJson, input.packageLock])

    expect(preparePublish(input)).toEqual({ version: '3.0.0', tag: 'latest' })
    expect(JSON.stringify([input.packageJson, input.packageLock])).toBe(before)
  })

  it.each([
    'refs/tags/v01.2.3',
    'refs/tags/v1.02.3',
    'refs/tags/v1.2.03',
    'refs/tags/v1.2.3-rc.1',
    'refs/tags/v1.2',
    'refs/tags/v1.2.3+build.1',
  ])('rejects non-canonical stable tag %s without mutation', (ref) => {
    const input = createInput()
    input.ref = ref
    expectRejectedWithoutMutation(input)
  })

  it('rejects a stable tag that does not match package.json', () => {
    const input = createInput()
    input.ref = 'refs/tags/v3.0.1'

    expect(() => preparePublish(input)).toThrow('Tag v3.0.1 does not match package version 3.0.0')
    expect(input.packageJson.version).toBe('3.0.0')
  })

  it.each(['version', 'packages[""].version'])('rejects a package-lock mismatch in %s', (field) => {
    const input = createInput()
    if (field === 'version') {
      input.packageLock.version = '3.0.1'
    } else {
      input.packageLock.packages[''].version = '3.0.1'
    }

    expectRejectedWithoutMutation(input)
  })

  it('rejects unsupported branches without mutation', () => {
    const input = createInput()
    input.ref = 'refs/heads/main'
    expectRejectedWithoutMutation(input)
  })

  it.each([
    { field: 'runId', value: undefined },
    { field: 'runId', value: '' },
    { field: 'runId', value: '0' },
    { field: 'runId', value: '01' },
    { field: 'runId', value: '-1' },
    { field: 'runId', value: '1.5' },
    { field: 'runAttempt', value: undefined },
    { field: 'runAttempt', value: '' },
    { field: 'runAttempt', value: '0' },
    { field: 'runAttempt', value: '01' },
    { field: 'runAttempt', value: '-1' },
    { field: 'runAttempt', value: '1.5' },
  ])('rejects invalid $field $value without mutation', ({ field, value }) => {
    const input = createInput()
    Object.assign(input, { [field]: value })
    expectRejectedWithoutMutation(input)
  })
})

describe('prepare-publish CLI', () => {
  it('writes both manifest versions and GitHub outputs for a dev release', () => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'prepare-publish-'))
    const input = createInput()
    writeFileSync(join(tempDirectory, 'package.json'), `${JSON.stringify(input.packageJson, null, 2)}\n`)
    writeFileSync(join(tempDirectory, 'package-lock.json'), `${JSON.stringify(input.packageLock, null, 2)}\n`)
    const outputPath = join(tempDirectory, 'github-output')
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: tempDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REF: input.ref,
        GITHUB_RUN_ID: input.runId,
        GITHUB_RUN_ATTEMPT: input.runAttempt,
        GITHUB_OUTPUT: outputPath,
      },
    })

    expect(result.status).toBe(0)
    expect(JSON.parse(readFileSync(join(tempDirectory, 'package.json'), 'utf8')).version).toBe('3.0.0-dev.123.1')
    expect(JSON.parse(readFileSync(join(tempDirectory, 'package-lock.json'), 'utf8'))).toMatchObject({
      version: '3.0.0-dev.123.1',
      packages: { '': { version: '3.0.0-dev.123.1' } },
    })
    expect(readFileSync(outputPath, 'utf8')).toBe('version=3.0.0-dev.123.1\ntag=latest\n')
  })

  it('leaves files and GitHub output untouched when the ref is rejected', () => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'prepare-publish-'))
    const input = createInput()
    const packageContents = `{ "name": "${input.packageJson.name}", "version": "3.0.0" }\n`
    const lockContents = `${JSON.stringify(input.packageLock, null, 2)}\n`
    const outputContents = 'existing output\n'
    writeFileSync(join(tempDirectory, 'package.json'), packageContents)
    writeFileSync(join(tempDirectory, 'package-lock.json'), lockContents)
    const outputPath = join(tempDirectory, 'github-output')
    writeFileSync(outputPath, outputContents)
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: tempDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REF: 'refs/heads/main',
        GITHUB_RUN_ID: input.runId,
        GITHUB_RUN_ATTEMPT: input.runAttempt,
        GITHUB_OUTPUT: outputPath,
      },
    })

    expect(result.status).toBe(1)
    expect(readFileSync(join(tempDirectory, 'package.json'), 'utf8')).toBe(packageContents)
    expect(readFileSync(join(tempDirectory, 'package-lock.json'), 'utf8')).toBe(lockContents)
    expect(readFileSync(outputPath, 'utf8')).toBe(outputContents)
  })
})
