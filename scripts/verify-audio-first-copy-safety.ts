import {
  lstatSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from 'node:fs'
import { resolve } from 'node:path'

export interface GuardedDatabaseCopy {
  /** Canonical existing file path. This, rather than the user spelling, is opened. */
  databasePath: string
  realPath: string
  device: bigint
  inode: bigint
}

interface IsolatedDatabaseGuardOptions {
  /** Test seam only; production callers must retain the default runtime path. */
  productionPath?: string
}

interface StoryShotWithDialogue {
  dialogueLines: readonly unknown[]
}

/** Dynamic acceptance cardinality: any positive number is valid; zero is not. */
export function requireSpokenShotCount(
  shots: readonly StoryShotWithDialogue[],
): number {
  const count = shots.filter((shot) => shot.dialogueLines.length > 0).length
  if (count === 0) {
    throw new Error('audio-first acceptance requires at least 1 spoken Story shot; got 0')
  }
  return count
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function productionIdentity(productionPath: string): {
  realPath: string
  stats: BigIntStats
} | null {
  try {
    return {
      realPath: realpathSync.native(productionPath),
      stats: statSync(productionPath, { bigint: true }),
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw error
  }
}

/**
 * Fail closed before SQLite is initialized.
 *
 * Textual path inequality is not a safety boundary: `..`, directory symlinks,
 * final-component symlinks and hard links can all name the live database. The
 * verifier therefore requires an existing regular non-symlink file and checks
 * its canonical path plus device/inode identity against the production file.
 */
export function guardIsolatedDatabaseCopy(
  databaseArgument: string,
  options: IsolatedDatabaseGuardOptions = {},
): GuardedDatabaseCopy {
  const databasePath = resolve(databaseArgument)
  const livePath = resolve(options.productionPath ?? 'runtime/manju.sqlite')
  if (databasePath === livePath) {
    throw new Error('refusing to open runtime/manju.sqlite; pass an isolated copy')
  }

  let candidateLink: BigIntStats
  try {
    candidateLink = lstatSync(databasePath, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('isolated database copy must already exist; refusing to create it')
    }
    throw error
  }
  if (candidateLink.isSymbolicLink()) {
    throw new Error('isolated database copy must not be a symbolic link')
  }

  const realPath = realpathSync.native(databasePath)
  const candidate = statSync(realPath, { bigint: true })
  if (!candidate.isFile()) {
    throw new Error('isolated database copy must be a regular file')
  }

  const production = productionIdentity(livePath)
  if (production
    && (realPath === production.realPath || sameFile(candidate, production.stats))) {
    throw new Error('refusing production database realpath/device/inode alias; pass a real copy')
  }

  return {
    databasePath,
    realPath,
    device: candidate.dev,
    inode: candidate.ino,
  }
}

/** Re-check the held identity immediately before the first SQLite initialize/write. */
export function revalidateGuardedDatabaseCopy(
  guarded: GuardedDatabaseCopy,
  options: IsolatedDatabaseGuardOptions = {},
): void {
  const current = guardIsolatedDatabaseCopy(guarded.databasePath, options)
  if (current.realPath !== guarded.realPath
    || current.device !== guarded.device
    || current.inode !== guarded.inode) {
    throw new Error('isolated database copy changed after the safety check')
  }
}
