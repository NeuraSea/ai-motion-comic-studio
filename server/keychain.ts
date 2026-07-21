import { execFile } from 'node:child_process'

/**
 * Keep this value stable: provider_connections persists the service/account pair,
 * while the secret itself lives only in macOS Keychain.
 */
export const KEYCHAIN_SERVICE = 'com.manju-studio.aigc-credentials.v1'

const DEFAULT_CREDENTIAL_KIND = 'api-key'
const MAX_SECRET_BYTES = 64 * 1024
const SECURITY_TIMEOUT_MS = 30_000
const SECURITY_MAX_BUFFER_BYTES = 1024 * 1024
const SECURITY_EXECUTABLE = '/usr/bin/security'
const SYSTEM_PYTHON = '/usr/bin/python3'
const SLOT_COMPONENT = /^[a-z0-9][a-z0-9._-]{0,127}$/

export type KeychainOperation = 'reference' | 'get' | 'set' | 'delete' | 'exists'

export type KeychainErrorCode =
  | 'KEYCHAIN_UNSUPPORTED_PLATFORM'
  | 'KEYCHAIN_SECURITY_NOT_FOUND'
  | 'KEYCHAIN_INVALID_REFERENCE'
  | 'KEYCHAIN_INVALID_SECRET'
  | 'KEYCHAIN_COMMAND_FAILED'

/** A serializable, secret-free error suitable for API error mapping. */
export class KeychainError extends Error {
  readonly name = 'KeychainError'

  constructor(
    readonly code: KeychainErrorCode,
    readonly operation: KeychainOperation,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }

  toJSON(): {
    code: KeychainErrorCode
    operation: KeychainOperation
    message: string
    retryable: boolean
  } {
    return {
      code: this.code,
      operation: this.operation,
      message: this.message,
      retryable: this.retryable,
    }
  }
}

export interface KeychainCredentialSlot {
  /** Stable provider id, for example `minimax` or a custom-provider UUID. */
  providerId: string
  /** Stable credential type; defaults to `api-key`. */
  credentialKind?: string
}

export interface KeychainReference {
  service: typeof KEYCHAIN_SERVICE
  account: string
}

export interface SecurityCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Injectable boundary used by tests. `stdin` is sensitive whenever it is set and
 * must never be logged or copied into an error by an implementation.
 */
export type SecurityCommandRunner = (
  args: readonly string[],
  stdin?: string,
) => Promise<SecurityCommandResult>

export interface MacOSKeychainOptions {
  runner?: SecurityCommandRunner
  /** Injectable solely for platform-independent tests. */
  platform?: NodeJS.Platform
}

function invalidReference(message: string): KeychainError {
  return new KeychainError('KEYCHAIN_INVALID_REFERENCE', 'reference', message)
}

function normalizeSlotComponent(value: string, label: string): string {
  if (typeof value !== 'string') throw invalidReference(`${label} 必须是字符串`)
  const normalized = value.trim().toLowerCase()
  if (!SLOT_COMPONENT.test(normalized)) {
    throw invalidReference(`${label} 只能包含小写字母、数字、点、下划线和连字符，长度为 1 到 128`)
  }
  return normalized
}

/** Produces the one canonical service/account pair for a provider credential. */
export function keychainReference(slot: KeychainCredentialSlot): KeychainReference {
  if (!slot || typeof slot !== 'object') throw invalidReference('Keychain 凭据槽无效')
  const providerId = normalizeSlotComponent(slot.providerId, 'providerId')
  const credentialKind = normalizeSlotComponent(
    slot.credentialKind ?? DEFAULT_CREDENTIAL_KIND,
    'credentialKind',
  )
  return {
    service: KEYCHAIN_SERVICE,
    account: `provider:${providerId}:${credentialKind}`,
  }
}

function exitCode(error: Error & { code?: string | number }): number {
  return typeof error.code === 'number' ? error.code : 1
}

/**
 * Uses execFile rather than a shell. In particular, the secret is never part of
 * argv or an environment variable: add-generic-password receives it on stdin.
 */
const SECURITY_FRAMEWORK_WRITE_SCRIPT = String.raw`
import ctypes
import sys

service = sys.argv[1].encode('utf-8')
account = sys.argv[2].encode('utf-8')
secret = sys.stdin.buffer.read()
if secret.endswith(b'\n'):
    secret = secret[:-1]

security = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
core = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')

c_void_p = ctypes.c_void_p
c_uint32 = ctypes.c_uint32
security.SecKeychainFindGenericPassword.argtypes = [
    c_void_p, c_uint32, c_void_p, c_uint32, c_void_p,
    ctypes.POINTER(c_uint32), ctypes.POINTER(c_void_p), ctypes.POINTER(c_void_p),
]
security.SecKeychainFindGenericPassword.restype = ctypes.c_int32
security.SecKeychainAddGenericPassword.argtypes = [
    c_void_p, c_uint32, c_void_p, c_uint32, c_void_p,
    c_uint32, c_void_p, ctypes.POINTER(c_void_p),
]
security.SecKeychainAddGenericPassword.restype = ctypes.c_int32
security.SecKeychainItemModifyAttributesAndData.argtypes = [
    c_void_p, c_void_p, c_uint32, c_void_p,
]
security.SecKeychainItemModifyAttributesAndData.restype = ctypes.c_int32
security.SecKeychainItemFreeContent.argtypes = [c_void_p, c_void_p]
security.SecKeychainItemFreeContent.restype = ctypes.c_int32
core.CFRelease.argtypes = [c_void_p]

password_length = c_uint32()
password_data = c_void_p()
item = c_void_p()
service_buffer = ctypes.create_string_buffer(service)
account_buffer = ctypes.create_string_buffer(account)
secret_buffer = ctypes.create_string_buffer(secret)

status = security.SecKeychainFindGenericPassword(
    None,
    len(service), ctypes.cast(service_buffer, c_void_p),
    len(account), ctypes.cast(account_buffer, c_void_p),
    ctypes.byref(password_length), ctypes.byref(password_data), ctypes.byref(item),
)
if password_data:
    security.SecKeychainItemFreeContent(None, password_data)

if status == 0:
    status = security.SecKeychainItemModifyAttributesAndData(
        item, None, len(secret), ctypes.cast(secret_buffer, c_void_p),
    )
    if item:
        core.CFRelease(item)
elif status == -25300:
    status = security.SecKeychainAddGenericPassword(
        None,
        len(service), ctypes.cast(service_buffer, c_void_p),
        len(account), ctypes.cast(account_buffer, c_void_p),
        len(secret), ctypes.cast(secret_buffer, c_void_p),
        None,
    )

sys.exit(0 if status == 0 else 1)
`

function optionValue(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option)
  return index >= 0 ? args[index + 1] : undefined
}

function runExecutable(
  executable: string,
  args: readonly string[],
  stdin?: string,
): Promise<SecurityCommandResult> {
  return new Promise((resolve, reject) => {
  const child = execFile(
    executable,
    [...args],
    {
      encoding: 'utf8',
      maxBuffer: SECURITY_MAX_BUFFER_BYTES,
      timeout: SECURITY_TIMEOUT_MS,
      windowsHide: true,
    },
    (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(Object.assign(new Error('security executable unavailable'), { code: 'ENOENT' }))
          return
        }
        resolve({
          exitCode: exitCode(error),
          stdout,
          stderr,
        })
        return
      }
      resolve({
        exitCode: 0,
        stdout,
        stderr,
      })
    },
  )

  // A failed spawn can destroy stdin before end(); swallowing only this stream
  // error prevents an unhandled event without exposing its sensitive contents.
  child.stdin?.on('error', () => undefined)
  child.stdin?.end(stdin)
})
}

export const runSecurityCommand: SecurityCommandRunner = (args, stdin) => {
  if (args[0] === 'add-generic-password' && stdin !== undefined) {
    const service = optionValue(args, '-s')
    const account = optionValue(args, '-a')
    if (!service || !account) {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' })
    }
    // security(1) cannot safely receive a new generic-password value from a
    // non-TTY stdin pipe. Call the native Security.framework through the system
    // Python runtime instead; the secret remains stdin-only and never enters
    // argv, environment variables, temporary files, stdout, or stderr.
    return runExecutable(
      SYSTEM_PYTHON,
      ['-c', SECURITY_FRAMEWORK_WRITE_SCRIPT, service, account],
      stdin,
    )
  }
  return runExecutable(SECURITY_EXECUTABLE, args, stdin)
}

function isExecutableMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isItemNotFound(result: SecurityCommandResult): boolean {
  // errSecItemNotFound is -25300, observed as process status 44 by security(1).
  if (result.exitCode === 44 || result.exitCode === -25300) return true
  return /(?:errSecItemNotFound|-25300|could not be found)/i.test(result.stderr)
}

function withoutSecurityLineEnding(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2)
  if (value.endsWith('\n')) return value.slice(0, -1)
  return value
}

function validateSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new KeychainError('KEYCHAIN_INVALID_SECRET', 'set', '凭据不能为空')
  }
  if (secret.includes('\0') || secret.includes('\r') || secret.includes('\n')) {
    throw new KeychainError('KEYCHAIN_INVALID_SECRET', 'set', '凭据必须是单行文本')
  }
  if (Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES) {
    throw new KeychainError('KEYCHAIN_INVALID_SECRET', 'set', '凭据不能超过 64KB')
  }
}

export class MacOSKeychain {
  private readonly runner: SecurityCommandRunner
  private readonly platform: NodeJS.Platform

  constructor(options: MacOSKeychainOptions = {}) {
    this.runner = options.runner ?? runSecurityCommand
    this.platform = options.platform ?? process.platform
  }

  async get(slot: KeychainCredentialSlot): Promise<string | null> {
    const reference = keychainReference(slot)
    const result = await this.run(
      'get',
      ['find-generic-password', '-a', reference.account, '-s', reference.service, '-w'],
    )
    if (isItemNotFound(result)) return null
    this.requireSuccess('get', result)
    return withoutSecurityLineEnding(result.stdout)
  }

  async set(slot: KeychainCredentialSlot, secret: string): Promise<KeychainReference> {
    validateSecret(secret)
    const reference = keychainReference(slot)
    const result = await this.run(
      'set',
      ['add-generic-password', '-U', '-a', reference.account, '-s', reference.service, '-w'],
      // The default runner routes this stdin-only write through Security.framework.
      `${secret}\n`,
    )
    this.requireSuccess('set', result)
    return reference
  }

  async delete(slot: KeychainCredentialSlot): Promise<boolean> {
    const reference = keychainReference(slot)
    const result = await this.run(
      'delete',
      ['delete-generic-password', '-a', reference.account, '-s', reference.service],
    )
    if (isItemNotFound(result)) return false
    this.requireSuccess('delete', result)
    return true
  }

  async exists(slot: KeychainCredentialSlot): Promise<boolean> {
    const reference = keychainReference(slot)
    const result = await this.run(
      'exists',
      // Deliberately omit -w so this probe never materializes the secret.
      ['find-generic-password', '-a', reference.account, '-s', reference.service],
    )
    if (isItemNotFound(result)) return false
    this.requireSuccess('exists', result)
    return true
  }

  private async run(
    operation: Exclude<KeychainOperation, 'reference'>,
    args: readonly string[],
    stdin?: string,
  ): Promise<SecurityCommandResult> {
    if (this.platform !== 'darwin') {
      throw new KeychainError(
        'KEYCHAIN_UNSUPPORTED_PLATFORM',
        operation,
        '本地凭据存储仅支持 macOS Keychain',
      )
    }

    try {
      return await this.runner(args, stdin)
    } catch (error) {
      if (isExecutableMissing(error)) {
        throw new KeychainError(
          'KEYCHAIN_SECURITY_NOT_FOUND',
          operation,
          '找不到 macOS security 命令，无法访问 Keychain',
        )
      }
      // Never attach or interpolate the runner error: it could contain captured
      // stdout, stderr, or sensitive stdin supplied by a third-party runner.
      throw new KeychainError(
        'KEYCHAIN_COMMAND_FAILED',
        operation,
        'macOS Keychain 命令执行失败',
        true,
      )
    }
  }

  private requireSuccess(
    operation: Exclude<KeychainOperation, 'reference'>,
    result: SecurityCommandResult,
  ): void {
    if (result.exitCode === 0) return
    // Raw stdout/stderr are intentionally discarded so errors cannot leak a
    // retrieved secret into HTTP responses, application logs, or test output.
    throw new KeychainError(
      'KEYCHAIN_COMMAND_FAILED',
      operation,
      'macOS Keychain 操作失败，请检查钥匙串权限',
      false,
    )
  }
}
