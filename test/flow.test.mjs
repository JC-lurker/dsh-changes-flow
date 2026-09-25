import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../lib/index.js'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

test('flow routes keep merges within recorded session PRs and preserve dirty work on branch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'changes-flow-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const cwd = join(dir, 'repo')
  try {
    execFileSync('mkdir', ['-p', cwd])
    git(cwd, 'init', '-b', 'main')
    git(cwd, 'config', 'user.name', 'Flow Test')
    git(cwd, 'config', 'user.email', 'flow@example.test')
    await writeFile(join(cwd, 'base.txt'), 'base\n')
    git(cwd, 'add', '.')
    git(cwd, 'commit', '-m', 'base')
    git(cwd, 'checkout', '-b', 'feature/test')
    await writeFile(join(cwd, 'feature.txt'), 'feature\n')
    git(cwd, 'add', '.')
    git(cwd, 'commit', '-m', 'feature')
    git(cwd, 'checkout', 'main')

    let handler
    const llmCalls = []
    apply({
      webServer: { register(route) { handler = route.handler; return () => {} } },
      sessions: { get(id) { return id === 'test-session' ? { header: { cwd }, requestHeader: () => ({ config: { provider: 'test', model: 'commit-title' } }) } : undefined } },
      webRuntime: { trustedHosts: [] },
      llm: { async *stream(options) {
        llmCalls.push(options)
        yield { type: 'text-delta', index: 0, text: 'feat: describe linked work' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } },
      effect(fn) { fn() },
    }, { changesTab: false, composerSwitcher: true })
    async function post(op, payload) {
      const request = Readable.from([JSON.stringify({ sessionId: 'test-session', ...payload })])
      Object.assign(request, { method: 'POST', url: `/changes-flow/api/${op}`, headers: { host: 'localhost:3000' } })
      let status = 200
      let body = ''
      await handler(request, {
        writeHead(code) { status = code },
        end(value) { body = value },
      })
      return { status, ...JSON.parse(body) }
    }

    const url = 'https://github.com/example/repo/pull/1'
    const prefs = await post('preferences', {})
    assert.deepEqual(prefs.value, { changesTab: false, composerSwitcher: true })
    const initialWorktrees = await post('worktree-list', { sessionId: '', cwd })
    assert.deepEqual(initialWorktrees.value.worktrees, [{ path: await realpath(cwd), branch: 'main', current: true }])
    const refused = await post('flow-merge', { url, squash: false })
    assert.equal(refused.ok, false)
    assert.equal(git(cwd, 'branch', '--show-current'), 'main')

    const saved = await post('record-pr', { url, branch: 'feature/test' })
    assert.equal(saved.ok, true)
    assert.equal(saved.value.prs[0].branch, 'feature/test')
    git(cwd, 'checkout', 'feature/test')
    const wrongDestination = await post('flow-merge', { url, squash: false })
    assert.equal(wrongDestination.ok, false)
    assert.match(wrongDestination.error.message, /switch to main/)
    git(cwd, 'checkout', 'main')
    const merged = await post('flow-merge', { url, squash: false })
    assert.equal(merged.ok, true)
    assert.equal(await readFile(join(cwd, 'feature.txt'), 'utf8'), 'feature\n')

    await writeFile(join(cwd, 'dirty.txt'), 'uncommitted\n')
    const branched = await post('flow-branch', { name: 'flow/test' })
    assert.equal(branched.ok, true)
    assert.equal(git(cwd, 'branch', '--show-current'), 'flow/test')
    assert.equal(await readFile(join(cwd, 'dirty.txt'), 'utf8'), 'uncommitted\n')

    const before = await post('worktree-context', {})
    assert.equal(before.value.main, await realpath(cwd))
    assert.equal(before.value.linked, false)
    const created = await post('flow-worktree', { base: 'main' })
    assert.equal(created.ok, true)
    assert.match(created.value.branch, /^flow\/main-[a-f0-9]{8}$/)
    assert.equal(git(created.value.path, 'branch', '--show-current'), created.value.branch)
    const linked = git(cwd, 'worktree', 'list', '--porcelain')
    assert.match(linked, new RegExp('branch refs/heads/' + created.value.branch))
    const listed = await post('worktree-list', {})
    assert.deepEqual(listed.value.worktrees, [
      { path: await realpath(cwd), branch: 'flow/test', current: true },
      { path: created.value.path, branch: created.value.branch, current: false },
    ])
    assert.equal(git(cwd, 'branch', '--show-current'), 'flow/test')

    await writeFile(join(created.value.path, 'linked-dirty.txt'), 'linked work\n')
    const suggested = await post('commit-message', { worktree: created.value.path })
    assert.equal(suggested.value.message, 'feat: describe linked work')
    assert.equal(llmCalls[0].provider, 'test')
    const modelInput = JSON.parse(llmCalls[0].messages[0].content[0].text)
    assert.match(modelInput.status, /linked-dirty\.txt/)
    assert.doesNotMatch(modelInput.status, /(?:^|\n)\?\? dirty\.txt/)
    const selectedBranch = await post('flow-branch', { name: 'flow/selected-worktree', worktree: created.value.path })
    assert.equal(selectedBranch.ok, true)
    assert.equal(git(created.value.path, 'branch', '--show-current'), 'flow/selected-worktree')
    assert.equal(git(cwd, 'branch', '--show-current'), 'flow/test')
    assert.equal(await readFile(join(created.value.path, 'linked-dirty.txt'), 'utf8'), 'linked work\n')
    const rejectedWorktree = await post('flow-branch', { name: 'flow/invalid-target', worktree: dir })
    assert.equal(rejectedWorktree.ok, false)
    assert.match(rejectedWorktree.error.message, /selected worktree is no longer available/)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(dir, { recursive: true, force: true })
  }
})

test('an empty Git repository has no selectable branches or worktree base', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'changes-flow-empty-'))
  try {
    git(cwd, 'init', '-b', 'main')
    let handler
    apply({
      webServer: { register(route) { handler = route.handler; return () => {} } },
      sessions: { get() { return undefined } },
      webRuntime: { trustedHosts: [] },
      effect(fn) { fn() },
    })
    async function post(op, payload = {}) {
      const request = Readable.from([JSON.stringify({ cwd, ...payload })])
      Object.assign(request, { method: 'POST', url: `/changes-flow/api/${op}`, headers: { host: 'localhost:3000' } })
      let body = ''
      await handler(request, { writeHead() {}, end(value) { body = value } })
      return JSON.parse(body)
    }
    const worktrees = await post('worktree-list')
    assert.deepEqual(worktrees.value.worktrees, [{ path: await realpath(cwd), branch: 'main', current: true }])
    const context = await post('worktree-context')
    assert.equal(context.value.branch, '')
    assert.equal(context.value.hasCommits, false)
    const worktree = await post('flow-worktree', { base: 'main' })
    assert.equal(worktree.ok, false)
    assert.match(worktree.error.message, /initial commit/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
