import { execSync } from 'node:child_process'

type Env = Record<string, string | undefined>

const runGit = (cmd: string) => {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return '' }
}

/**
 * Build data shown by the SiteFooter. Docker builds have no .git, so the deploy
 * passes APP_VERSION / APP_COMMIT / APP_COMMIT_DATE as build args; local builds
 * fall back to package.json and git.
 */
export function buildDefines(env: Env = process.env, pkgVersion = '0.0.0', git = runGit) {
  return {
    __APP_VERSION__: JSON.stringify(env.APP_VERSION || pkgVersion),
    __APP_COMMIT__: JSON.stringify(env.APP_COMMIT || git('git rev-parse --short HEAD')),
    __APP_COMMIT_DATE__: JSON.stringify(env.APP_COMMIT_DATE || git('git log -1 --format=%cs')),
  }
}
