import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

export function preparePublish({ ref, runId, runAttempt, packageJson, packageLock }) {
  const version = packageJson.version
  if (!stableVersion.test(version)
    || packageLock.version !== version
    || packageLock.packages?.['']?.version !== version) {
    throw new Error('package.json and package-lock.json must contain the same canonical stable version')
  }

  const tagMatch = /^refs\/tags\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(ref)
  if (tagMatch) {
    if (tagMatch[1] !== version) {
      throw new Error(`Tag v${tagMatch[1]} does not match package version ${version}`)
    }
    return { version, tag: 'latest' }
  }

  if (ref !== 'refs/heads/latest') {
    throw new Error(`Refusing to publish from ${ref}`)
  }
  if (!/^[1-9]\d*$/.test(runId) || !/^[1-9]\d*$/.test(runAttempt)) {
    throw new Error('GitHub run ID and attempt must be positive integers')
  }

  const devVersion = `${version}-dev.${runId}.${runAttempt}`
  packageJson.version = devVersion
  packageLock.version = devVersion
  packageLock.packages[''].version = devVersion
  return { version: devVersion, tag: 'latest' }
}

function main() {
  const packagePath = resolve('package.json')
  const lockPath = resolve('package-lock.json')
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
  const packageLock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const result = preparePublish({
    ref: process.env.GITHUB_REF,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    packageJson,
    packageLock,
  })

  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
  writeFileSync(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\ntag=${result.tag}\n`)
  } else {
    console.log(JSON.stringify(result))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
