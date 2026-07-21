export interface StandaloneRuntimeOptions {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly assertReleaseRuntime: () => unknown
  readonly startServer: () => Promise<void>
}

/** Keep the release audit gate observably before application/port startup. */
export async function startStandaloneRuntime(options: StandaloneRuntimeOptions): Promise<void> {
  if (options.environment.MANJU_FFMPEG_RELEASE_MODE === '1') {
    options.assertReleaseRuntime()
  }
  await options.startServer()
}
