import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { getBundledBinDir, resolveBundledShell } from './binaries'

/**
 * Minimal shell helpers for the bash tool. pi-coding-agent keeps these in
 * utils/shell.ts + utils/child-process.ts + utils/ansi.ts with extra features
 * (detached-pid tracking, login-shell detection). Flairy inlines the parts the
 * bash tool actually needs.
 */

export function getShellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // Prepend the bundled bin dir so commands run via the bash tool can invoke
  // shipped CLIs (rg, fd, …) out of the box. Prepending (not appending) means
  // the bundled versions win over any the user happens to have installed,
  // keeping behaviour reproducible regardless of the host environment.
  const binDir = getBundledBinDir()
  env.PATH = env.PATH ? `${binDir}${path.delimiter}${env.PATH}` : binDir
  return env
}

export interface ShellInvocation {
  shell: string
  args: string[]
  /**
   * Windows only: pass the command line to CreateProcess verbatim instead of
   * letting Node re-quote it. Always undefined off Windows.
   */
  windowsVerbatimArguments?: boolean
}

/**
 * Build the spawn invocation for running `command` through the platform shell.
 *
 * The agent emits POSIX/bash-style commands, so we run them on a real POSIX
 * shell on every platform:
 *   - Unix: bash (or $SHELL), `-c command`.
 *   - Windows: the bundled busybox-w32 `ash` (see `resolveBundledShell`), which
 *     understands bash syntax and ships coreutils applets — no Git Bash install
 *     needed. Node's default argument escaping is correct here because busybox
 *     parses its command line with the same MSVC backslash-quote convention Node
 *     escapes for, and the Unicode build preserves CJK via wide CreateProcessW.
 *
 * If no bundled shell is present (dev machine without it / unsupported arch) we
 * degrade to cmd.exe. cmd does NOT understand Node's `\"` escaping, so for that
 * path we wrap the command in one quote pair that cmd's `/s` flag strips cleanly
 * and hand the line over verbatim, letting cmd parse with its own quoting rules.
 */
export function getShellConfig(command: string, shellPath?: string): ShellInvocation {
  if (process.platform === 'win32') {
    if (shellPath) return { shell: shellPath, args: ['-c', command] }

    const busybox = resolveBundledShell()
    if (busybox) return { shell: busybox, args: ['ash', '-c', command] }

    return {
      shell: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${command}"`],
      windowsVerbatimArguments: true
    }
  }
  return { shell: shellPath || process.env.SHELL || '/bin/bash', args: ['-c', command] }
}

/** Kill a process and (on POSIX) its whole detached process group. */
export function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      return
    }
    // The child is spawned detached, so -pid targets the whole process group.
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      process.kill(pid, 'SIGTERM')
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }, 2000).unref()
  } catch {
    /* already gone */
  }
}

// Built with new RegExp + \u escapes so the source contains no raw control bytes.
// Matches ANSI/VT escape sequences (ESC = U+001B, CSI = U+009B).
const ANSI_RE = new RegExp(
  '[\\u001b\\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]',
  'g'
)

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

// C0 control bytes except tab/newline/carriage-return.
const BINARY_RE = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]', 'g')

/** Replace non-printable control bytes so binary noise can't corrupt the UI. */
export function sanitizeBinaryOutput(text: string): string {
  return text.replace(BINARY_RE, '�')
}

/**
 * Resolve when the child process exits. Uses "exit" rather than "close" so a
 * detached descendant holding the stdout/stderr pipe can't hang the await.
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })
}
