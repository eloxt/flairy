import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { getGithubToken } from '../store/secrets'

/**
 * Local git plumbing for the GitHub tools + worker dispatch pipeline. Runs the
 * system `git` via execFile (never a shell). Authenticated operations feed the
 * OAuth token through an ephemeral GIT_ASKPASS helper + child-process env var —
 * the token never appears in argv (visible in `ps`), never touches a config
 * file, and never reaches worker agents (they only ever commit locally).
 */

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Resolve the git binary. GUI-launched Electron apps don't inherit the shell
 * PATH (Finder/Dock launches on macOS), so prefer the absolute macOS location —
 * /usr/bin/git always exists there (the Xcode CLT shim). Elsewhere rely on PATH.
 */
export function gitBinary(): string {
  if (process.platform === 'darwin' && existsSync('/usr/bin/git')) return '/usr/bin/git'
  return 'git'
}

/**
 * Materialize the askpass helper once per launch into userData. git invokes it
 * with the prompt as $1: we answer `x-access-token` for the username prompt and
 * the token (from env) for the password prompt.
 */
let askpassPath: string | null = null

function ensureAskpassHelper(): string {
  if (askpassPath && existsSync(askpassPath)) return askpassPath
  const dir = join(app.getPath('userData'), 'github')
  mkdirSync(dir, { recursive: true })
  if (process.platform === 'win32') {
    const p = join(dir, 'askpass.cmd')
    writeFileSync(
      p,
      '@echo off\r\n' +
        'echo %~1 | findstr /i "username" >nul\r\n' +
        'if %errorlevel%==0 (echo x-access-token) else (echo %FLAIRY_GIT_TOKEN%)\r\n'
    )
    askpassPath = p
  } else {
    const p = join(dir, 'askpass.sh')
    writeFileSync(
      p,
      '#!/bin/sh\ncase "$1" in\n  [Uu]sername*) echo "x-access-token" ;;\n  *) echo "$FLAIRY_GIT_TOKEN" ;;\nesac\n'
    )
    chmodSync(p, 0o700)
    askpassPath = p
  }
  return askpassPath
}

/** Env for authenticated git commands (push/fetch/clone over https). */
function authedEnv(): NodeJS.ProcessEnv {
  const token = getGithubToken()
  if (!token) {
    throw new Error('GitHub is not connected. Ask the user to connect GitHub in Settings first.')
  }
  return {
    ...process.env,
    GIT_ASKPASS: ensureAskpassHelper(),
    FLAIRY_GIT_TOKEN: token,
    // Never fall back to an interactive prompt (there is no terminal).
    GIT_TERMINAL_PROMPT: '0'
  }
}

export interface GitOptions {
  cwd: string
  /** Attach the askpass credential env (for push/fetch/clone against GitHub). */
  authed?: boolean
  timeoutMs?: number
}

/** Run a git command, resolving with trimmed stdout; throws with stderr on failure. */
export function git(args: string[], opts: GitOptions): Promise<string> {
  const env = opts.authed ? authedEnv() : { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  return new Promise((resolve, reject) => {
    execFile(
      gitBinary(),
      args,
      {
        cwd: opts.cwd,
        env,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message).toString().trim()
          reject(new Error(`git ${args[0]} failed: ${detail}`))
          return
        }
        resolve(stdout.toString().trim())
      }
    )
  })
}

/** Whether `cwd` is inside a git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(['rev-parse', '--is-inside-work-tree'], { cwd })) === 'true'
  } catch {
    return false
  }
}

/** Current branch name (or 'HEAD' when detached). */
export function currentBranch(cwd: string): Promise<string> {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
}
