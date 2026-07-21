import assert from 'node:assert/strict'
import test from 'node:test'

import {
  KEYCHAIN_SERVICE,
  KeychainError,
  MacOSKeychain,
  keychainReference,
  type SecurityCommandRunner,
} from './keychain.js'

interface RunnerCall {
  args: readonly string[]
  stdin?: string
}

function fakeRunner(
  handler: (call: RunnerCall) => { exitCode: number; stdout?: string; stderr?: string },
): { calls: RunnerCall[]; runner: SecurityCommandRunner } {
  const calls: RunnerCall[] = []
  return {
    calls,
    runner: async (args, stdin) => {
      const call = { args: [...args], ...(stdin === undefined ? {} : { stdin }) }
      calls.push(call)
      const result = handler(call)
      return {
        exitCode: result.exitCode,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      }
    },
  }
}

test('builds one canonical and stable service/account reference', () => {
  assert.deepEqual(
    keychainReference({ providerId: ' MiniMax ', credentialKind: ' API-Key ' }),
    {
      service: KEYCHAIN_SERVICE,
      account: 'provider:minimax:api-key',
    },
  )
  assert.deepEqual(
    keychainReference({ providerId: 'seedance' }),
    {
      service: KEYCHAIN_SERVICE,
      account: 'provider:seedance:api-key',
    },
  )
  assert.deepEqual(
    keychainReference({ providerId: 'custom-image', credentialKind: 'api-key-r12' }),
    {
      service: KEYCHAIN_SERVICE,
      account: 'provider:custom-image:api-key-r12',
    },
  )
})

test('versioned credential slots never overwrite secrets referenced by older revisions', async () => {
  const values = new Map<string, string>()
  const fake = fakeRunner((call) => {
    const accountIndex = call.args.indexOf('-a')
    const account = accountIndex >= 0 ? call.args[accountIndex + 1] : ''
    if (call.args[0] === 'add-generic-password') {
      values.set(account, call.stdin?.replace(/\n$/, '') ?? '')
      return { exitCode: 0 }
    }
    if (call.args[0] === 'find-generic-password') {
      const value = values.get(account)
      return value === undefined ? { exitCode: 44 } : { exitCode: 0, stdout: `${value}\n` }
    }
    return { exitCode: 1 }
  })
  const keychain = new MacOSKeychain({ runner: fake.runner, platform: 'darwin' })
  const revisionOne = { providerId: 'custom-image', credentialKind: 'api-key-r1' }
  const revisionTwo = { providerId: 'custom-image', credentialKind: 'api-key-r2' }

  await keychain.set(revisionOne, 'revision-one-secret')
  await keychain.set(revisionTwo, 'revision-two-secret')

  assert.equal(await keychain.get(revisionOne), 'revision-one-secret')
  assert.equal(await keychain.get(revisionTwo), 'revision-two-secret')
  assert.equal(values.size, 2)
})

test('set passes a secret only through stdin and keeps -w last', async () => {
  const fake = fakeRunner(() => ({ exitCode: 0 }))
  const keychain = new MacOSKeychain({ runner: fake.runner, platform: 'darwin' })
  const secret = ['fixture', 'credential'].join('-')

  const reference = await keychain.set({ providerId: 'minimax' }, secret)

  assert.deepEqual(reference, {
    service: KEYCHAIN_SERVICE,
    account: 'provider:minimax:api-key',
  })
  assert.equal(fake.calls.length, 1)
  assert.deepEqual(fake.calls[0].args, [
    'add-generic-password',
    '-U',
    '-a',
    'provider:minimax:api-key',
    '-s',
    KEYCHAIN_SERVICE,
    '-w',
  ])
  assert.equal(fake.calls[0].args.includes(secret), false)
  assert.equal(fake.calls[0].stdin, `${secret}\n`)
})

test('get returns the credential without security line ending and missing returns null', async () => {
  const secret = `  ${['fixture', 'with', 'spaces'].join('-')}  `
  let missing = false
  const fake = fakeRunner(() => missing
    ? { exitCode: 44, stderr: 'The specified item could not be found in the keychain.' }
    : { exitCode: 0, stdout: `${secret}\n` })
  const keychain = new MacOSKeychain({ runner: fake.runner, platform: 'darwin' })

  assert.equal(await keychain.get({ providerId: 'custom-123' }), secret)
  assert.deepEqual(fake.calls[0].args, [
    'find-generic-password',
    '-a',
    'provider:custom-123:api-key',
    '-s',
    KEYCHAIN_SERVICE,
    '-w',
  ])

  missing = true
  assert.equal(await keychain.get({ providerId: 'custom-123' }), null)
})

test('exists does not retrieve the secret and delete reports whether an item existed', async () => {
  let exists = true
  const fake = fakeRunner((call) => {
    if (call.args[0] === 'find-generic-password') {
      return exists ? { exitCode: 0, stdout: 'metadata only' } : { exitCode: 44 }
    }
    if (call.args[0] === 'delete-generic-password') {
      if (!exists) return { exitCode: 44 }
      exists = false
      return { exitCode: 0 }
    }
    return { exitCode: 1 }
  })
  const keychain = new MacOSKeychain({ runner: fake.runner, platform: 'darwin' })

  assert.equal(await keychain.exists({ providerId: 'seedance' }), true)
  assert.equal(fake.calls[0].args.includes('-w'), false)
  assert.equal(fake.calls[0].stdin, undefined)
  assert.equal(await keychain.delete({ providerId: 'seedance' }), true)
  assert.equal(await keychain.exists({ providerId: 'seedance' }), false)
  assert.equal(await keychain.delete({ providerId: 'seedance' }), false)
})

test('unsupported platforms fail structurally without invoking the runner', async () => {
  let invoked = false
  const runner: SecurityCommandRunner = async () => {
    invoked = true
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const keychain = new MacOSKeychain({ runner, platform: 'linux' })

  await assert.rejects(
    keychain.exists({ providerId: 'minimax' }),
    (error: unknown) => {
      assert.ok(error instanceof KeychainError)
      assert.deepEqual(error.toJSON(), {
        code: 'KEYCHAIN_UNSUPPORTED_PLATFORM',
        operation: 'exists',
        message: '本地凭据存储仅支持 macOS Keychain',
        retryable: false,
      })
      return true
    },
  )
  assert.equal(invoked, false)
})

test('a missing security executable is a structured, secret-free error', async () => {
  const secret = ['never', 'expose', 'this'].join('-')
  const runner: SecurityCommandRunner = async () => {
    throw Object.assign(new Error(`spawn failure ${secret}`), { code: 'ENOENT' })
  }
  const keychain = new MacOSKeychain({ runner, platform: 'darwin' })

  await assert.rejects(
    keychain.set({ providerId: 'minimax' }, secret),
    (error: unknown) => {
      assert.ok(error instanceof KeychainError)
      assert.equal(error.code, 'KEYCHAIN_SECURITY_NOT_FOUND')
      assert.equal(error.operation, 'set')
      assert.equal(JSON.stringify(error).includes(secret), false)
      return true
    },
  )
})

test('command failures discard stdout and stderr instead of leaking credentials', async () => {
  const secret = ['captured', 'fixture', 'secret'].join('-')
  const runner: SecurityCommandRunner = async () => ({
    exitCode: 1,
    stdout: secret,
    stderr: `provider rejected ${secret}`,
  })
  const keychain = new MacOSKeychain({ runner, platform: 'darwin' })

  await assert.rejects(
    keychain.get({ providerId: 'minimax' }),
    (error: unknown) => {
      assert.ok(error instanceof KeychainError)
      assert.equal(error.code, 'KEYCHAIN_COMMAND_FAILED')
      assert.equal(JSON.stringify(error).includes(secret), false)
      return true
    },
  )
})

test('invalid slots and multiline secrets fail before invoking the runner', async () => {
  const fake = fakeRunner(() => ({ exitCode: 0 }))
  const keychain = new MacOSKeychain({ runner: fake.runner, platform: 'darwin' })

  assert.throws(
    () => keychainReference({ providerId: '../minimax' }),
    (error: unknown) => error instanceof KeychainError && error.code === 'KEYCHAIN_INVALID_REFERENCE',
  )
  await assert.rejects(
    keychain.set({ providerId: 'minimax' }, 'line-one\nline-two'),
    (error: unknown) => error instanceof KeychainError && error.code === 'KEYCHAIN_INVALID_SECRET',
  )
  assert.equal(fake.calls.length, 0)
})
