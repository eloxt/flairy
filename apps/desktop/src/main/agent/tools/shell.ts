import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Minimal shell helpers for the bash tool. pi-coding-agent keeps these in
 * utils/shell.ts + utils/child-process.ts + utils/ansi.ts with extra features
 * (detached-pid tracking, login-shell detection). Flairy inlines the parts the
 * bash tool actually needs.
 */

export function getShellEnv(): NodeJS.ProcessEnv {
  return { ...process.env }
}

export function getShellConfig(shellPath?: string): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    return { shell: shellPath || process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'] }
  }
  return { shell: shellPath || process.env.SHELL || '/bin/bash', args: ['-c'] }
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
