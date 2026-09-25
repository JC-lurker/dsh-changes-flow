/**
 * dsh-changes-flow: wrapper plugin for DSH better-sidebar.
 * Injects a flow-action dropdown INSIDE the existing Changes tab (id 'git'):
 * wraps the git tab descriptor's component with <FlowBar/> + original.
 * No new tab, left panel untouched.
 *
 * 5 actions:
 * 1. Branch this worktree (checkout -b carrying uncommitted changes)
 * 2. Rebase from main (injects prompt into conversation composer for the AI)
 * 3. Commit all changes (ask AI for message / stage-all + commit)
 * 4. Create PR (ask AI to run `gh pr create` / record session PR URL)
 * 5. Merge session PR (squash/merge recorded session PRs or branch)
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from 'cordis'

export const name = 'dsh-changes-flow'
export const inject = ['slots', 'locale']

interface PrRecord {
  url: string
  branch?: string
  createdAt: string
}

type FlowAction = 'commit' | 'pr' | 'branch' | 'rebase' | 'merge'

const ACTIONS: Array<{ id: FlowAction; label: string; description: string }> = [
  { id: 'commit', label: 'Commit or push', description: 'Stage and commit your changes, or ask the assistant to push.' },
  { id: 'pr', label: 'Create PR', description: 'Ask the assistant to create a pull request and save its URL here.' },
  { id: 'branch', label: 'Branch this worktree', description: 'Create a branch while keeping your current changes.' },
  { id: 'rebase', label: 'Rebase from main', description: 'Ask the assistant to rebase and resolve conflicts.' },
  { id: 'merge', label: 'Merge session PR', description: 'Merge a pull request recorded in this session.' },
]

function FlowIcon({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2 8h3m6 0h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.2" />
  </svg>
}

function Chevron() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

function CloseIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
}

function ActionIcon({ action }: { action: FlowAction }) {
  const common = { stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" {...common}>
    {action === 'commit' && <><circle cx="8" cy="8" r="3" /><path d="M1.5 8h3.5m6 0h3.5" /></>}
    {action === 'pr' && <><circle cx="4" cy="3" r="1.4" /><circle cx="4" cy="13" r="1.4" /><circle cx="12" cy="12" r="1.4" /><path d="M4 4.5v7M12 10.5V7a4 4 0 0 0-4-4H6" /></>}
    {action === 'branch' && <><circle cx="4" cy="3" r="1.4" /><circle cx="4" cy="13" r="1.4" /><circle cx="12" cy="5" r="1.4" /><path d="M4 4.5v7M4 9c0-2.2 1.8-4 4-4h2.5" /></>}
    {action === 'rebase' && <><path d="M3 4.5h9M3 11.5h9M5.5 2 3 4.5 5.5 7M10.5 9 13 11.5 10.5 14" /></>}
    {action === 'merge' && <><circle cx="4" cy="3" r="1.4" /><circle cx="4" cy="13" r="1.4" /><circle cx="12" cy="3" r="1.4" /><path d="M4 4.5v7M12 4.5v1A6 6 0 0 1 6 11.5H4" /></>}
  </svg>
}

function CheckIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3.2 3.2L13 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function SearchIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.3" /><path d="m10.3 10.3 3.2 3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
}

async function apiPost<T = any>(path: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({ ok: false, error: { message: `HTTP ${res.status} from ${path}` } }))
  if (!res.ok || data.ok === false) {
    const msg = data.error?.message || data.message || `Request failed (${res.status})`
    throw new Error(msg)
  }
  return data.value !== undefined ? data.value : data
}

interface WorktreeContext { main: string; current: string; branch: string; hasCommits: boolean; linked: boolean }
interface ExistingWorktree { path: string; branch: string; current: boolean }
interface PluginPreferences { changesTab: boolean; composerSwitcher: boolean }

function gitLoadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/not a git repository/i.test(message)) return 'No Git repository'
  if (/HTTP 404|unknown op/i.test(message)) return 'Changes Flow is not loaded. Restart DSH.'
  return message || 'Could not load Git branches'
}

function usePluginPreferences(): PluginPreferences {
  const [prefs, setPrefs] = useState<PluginPreferences>({ changesTab: true, composerSwitcher: true })
  useEffect(() => {
    let alive = true
    const refresh = () => { void apiPost<PluginPreferences>('/changes-flow/api/preferences', {}).then(value => {
      if (alive) setPrefs(current => current.changesTab === value.changesTab && current.composerSwitcher === value.composerSwitcher ? current : value)
    }).catch(() => {}) }
    refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])
  return prefs
}

function WorktreeSwitcher({ ctx, cwd }: { ctx: any; cwd: string }) {
  const [context, setContext] = useState<WorktreeContext | null>(null)
  const [worktrees, setWorktrees] = useState<ExistingWorktree[]>([])
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [worktreeStatus, setWorktreeStatus] = useState('')
  const [switchStatus, setSwitchStatus] = useState('')
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    const payload = { cwd }
    const [worktree, list] = await Promise.all([
      apiPost<WorktreeContext>('/changes-flow/api/worktree-context', payload),
      apiPost<{ worktrees: ExistingWorktree[] }>('/changes-flow/api/worktree-list', payload),
    ])
    setContext(worktree)
    setWorktrees(Array.isArray(list.worktrees) ? list.worktrees : [])
    setError('')
  }, [cwd])

  useEffect(() => { setContext(null); setError(''); void refresh().catch(e => setError(gitLoadError(e))) }, [refresh])
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    requestAnimationFrame(() => searchInput.current?.focus())
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [open])

  const switchToWorktree = async (worktree: ExistingWorktree) => {
    setOpen(false)
    if (worktree.path === context?.current) return
    setBusy(true); setError(''); setSwitchStatus('Opening workspace…')
    try {
      await openWorkspace(worktree.path)
    } catch (e) { setError(gitLoadError(e)) }
    finally { setBusy(false); setSwitchStatus('') }
  }

  const openWorkspace = async (path: string) => {
    const workspaces = ctx.get?.('workspaces') ?? ctx.workspaces
    const uiWorkspace = ctx.get?.('uiWorkspace') ?? ctx.uiWorkspace
    if (!workspaces?.create || !uiWorkspace?.openWorkspace) throw new Error('DSH workspace navigation is unavailable')
    const workspace = await workspaces.create({ path })
    await uiWorkspace.openWorkspace(workspace.workspaceId)
  }

  const toggleWorktree = async () => {
    if (!context || !context.hasCommits || !context.branch || busy) return
    setBusy(true); setError(''); setOpen(false)
    setWorktreeStatus(context.linked ? 'Opening main workspace…' : 'Creating worktree…')
    try {
      const workspaces = ctx.get?.('workspaces') ?? ctx.workspaces
      const uiWorkspace = ctx.get?.('uiWorkspace') ?? ctx.uiWorkspace
      if (!workspaces?.create || !uiWorkspace?.openWorkspace) throw new Error('DSH workspace navigation is unavailable')
      if (context.linked) await openWorkspace(context.main)
      else {
        const created = await apiPost<{ path: string; branch: string }>('/changes-flow/api/flow-worktree', { cwd, base: context.branch })
        setWorktreeStatus('Opening worktree…')
        await openWorkspace(created.path)
      }
    } catch (e) { setError(gitLoadError(e)) }
    finally { setBusy(false); setWorktreeStatus('') }
  }

  if (!context) return <div title={error || 'Loading Git branch'} style={{ marginLeft: 8, padding: '4px 7px', borderRadius: 7, background: '#303030', color: '#888', fontSize: 12 }}>{error || 'Loading branch…'}</div>
  const filtered = worktrees.filter(worktree => `${worktree.branch} ${worktree.path}`.toLowerCase().includes(search.toLowerCase()))
  return <div ref={root} style={{ display: 'inline-flex', position: 'relative', alignItems: 'center', flex: 'none', marginLeft: 8, height: 26, padding: '0 5px', gap: 2, borderRadius: 7, background: '#303030', color: '#c7c7c7', fontSize: 12 }}>
    <button type="button" aria-label={context.branch ? `Switch worktree, current branch: ${context.branch}` : context.hasCommits ? 'Switch worktree, detached HEAD' : 'No branches yet'} aria-haspopup="listbox" aria-expanded={open} disabled={busy || !context.hasCommits} onClick={() => { setSearch(''); setOpen(value => !value); void refresh().catch(e => setError(gitLoadError(e))) }} style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: 180, padding: '2px 3px', border: 0, background: 'transparent', color: 'inherit', cursor: context.hasCommits ? 'pointer' : 'default', fontSize: 12 }}>
      <ActionIcon action="branch" /><span role={switchStatus ? 'status' : undefined} aria-live="polite" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{switchStatus || context.branch || (context.hasCommits ? 'Detached HEAD' : 'No branches yet')}</span>
    </button>
    <label title={worktreeStatus || (!context.hasCommits ? 'Create an initial commit to enable worktrees' : context.linked ? 'Open main workspace' : 'Create a worktree')} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 3px', cursor: busy ? 'wait' : context.hasCommits ? 'pointer' : 'default', whiteSpace: 'nowrap', opacity: context.hasCommits ? 1 : .5 }}>
      <input type="checkbox" checked={context.linked} disabled={busy || !context.hasCommits || !context.branch} onChange={() => void toggleWorktree()} style={{ width: 12, height: 12, margin: 0, accentColor: '#468fff', cursor: 'inherit' }} /><span role="status" aria-live="polite">{worktreeStatus || 'worktree'}</span>
    </label>
    {open && <div role="listbox" aria-label="Existing worktrees" style={{ position: 'absolute', left: 0, bottom: 31, width: 300, maxWidth: 'calc(100vw - 24px)', padding: 4, border: '1px solid #484848', borderRadius: 10, background: '#292929', boxShadow: '0 12px 32px rgba(0,0,0,.48)', zIndex: 1000 }}>
      <div style={{ maxHeight: 290, overflowY: 'auto' }}>
        {filtered.map(worktree => <button key={worktree.path} type="button" role="option" aria-selected={worktree.path === context.current} title={worktree.path} onClick={() => void switchToWorktree(worktree)} style={{ width: '100%', height: 27, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, padding: '0 7px', border: 0, borderRadius: 5, background: worktree.path === context.current ? '#373737' : 'transparent', color: '#dedede', textAlign: 'left', fontSize: 12, cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.background = '#3b3b3b' }} onMouseLeave={e => { e.currentTarget.style.background = worktree.path === context.current ? '#373737' : 'transparent' }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{worktree.branch || 'Detached HEAD'} · {worktree.path.split(/[\\/]/).pop()}</span>{worktree.path === context.current && <span style={{ color: '#4b91ff' }}><CheckIcon /></span>}</button>)}
        {filtered.length === 0 && <div style={{ padding: '8px', color: '#999' }}>No worktrees found</div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, height: 27, marginTop: 4, padding: '0 7px', border: '1px solid #4b8fff', borderRadius: 5, color: '#aaa' }}><SearchIcon /><input ref={searchInput} value={search} onChange={e => setSearch(e.target.value)} placeholder="Search worktrees..." aria-label="Search worktrees" style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: '#eee', fontSize: 12 }} /></div>
    </div>}
    {error && <div role="alert" title={error} style={{ position: 'absolute', left: 0, top: 31, zIndex: 1000, width: 300, padding: '8px 10px', border: '1px solid #844', borderRadius: 6, background: '#372323', color: '#ffb9b9', fontSize: 12 }}>{error}</div>}
  </div>
}

function ComposerAnchor({ ctx }: { ctx: any }) {
  const marker = useRef<HTMLSpanElement>(null)
  const [target, setTarget] = useState<Element | null>(null)
  const [cwd, setCwd] = useState('')
  const prefs = usePluginPreferences()
  useEffect(() => {
    const workspaces = ctx.get?.('workspaces') ?? ctx.workspaces
    const sync = () => {
      const root = marker.current?.closest('[data-phase="hero"]')
      const row = root?.querySelector('[class*="heroWorkspaceRow"]') ?? null
      const label = row?.querySelector('button')?.textContent?.trim()
      const items = workspaces?.list?.getSnapshot?.()?.items ?? []
      const workspace = items.find((item: any) => item.title === label)
      setTarget(row)
      setCwd(workspace?.path ?? '')
    }
    sync()
    const observer = new MutationObserver(sync)
    if (marker.current) observer.observe(marker.current.closest('[data-phase]') ?? document.body, { childList: true, subtree: true, characterData: true })
    const unsubscribe = workspaces?.list?.subscribe?.(sync)
    return () => { observer.disconnect(); unsubscribe?.() }
  }, [ctx])
  return <><span ref={marker} style={{ display: 'none' }} />{prefs.composerSwitcher && target && createPortal(cwd
    ? <WorktreeSwitcher ctx={ctx} cwd={cwd} />
    : <div title="Select a workspace containing a Git repository" style={{ marginLeft: 8, padding: '4px 7px', borderRadius: 7, background: '#303030', color: '#888', fontSize: 12 }}>Select Git workspace</div>, target)}</>
}

function appendToDraft(ctx: any, sessionId: string, text: string): boolean {
  try {
    const actx = ctx.sessions?.scope ? ctx.sessions.scope(sessionId) : undefined
    const conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : ctx.conversation
    if (conversation?.input && actx) {
      const input = conversation.input.for(actx)
      if (input?.setDraft) {
        const cur = input.state?.getSnapshot?.()?.draft ?? ''
        const next = cur.trim() === '' ? text : `${cur}\n\n${text}`
        input.setDraft(next)
        return true
      }
    }
  } catch (e) {
    console.warn('[dsh-changes-flow] conversation input failed:', e)
  }
  // DOM fallback: direct textarea insert
  try {
    const ta = document.querySelector<HTMLTextAreaElement>('#root textarea[data-phase], #root textarea')
    if (ta) {
      const cur = ta.value
      const next = cur.trim() === '' ? text : `${cur}\n\n${text}`
      ta.value = next
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.focus()
      return true
    }
  } catch (e) {
    console.warn('[dsh-changes-flow] DOM fallback failed:', e)
  }
  return false
}

function formatDateTag(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${m}${day}-${h}${min}`
}

const BAR: React.CSSProperties = {
  flex: 'none',
  padding: '8px 12px',
  borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12))',
  background: '#1c1c1c',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  fontSize: '13px',
  color: '#a1a1a1',
}

const INPUT: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: '32px',
  padding: '4px 10px',
  borderRadius: '7px',
  background: '#303030',
  border: '1px solid #484848',
  color: '#e8e8e8',
  fontSize: '13px',
}

const PRIMARY_BTN: React.CSSProperties = {
  minHeight: '32px',
  padding: '0 12px',
  borderRadius: '7px',
  background: '#e8e8e8',
  color: '#202020',
  border: '1px solid #e8e8e8',
  fontSize: '13px',
  fontWeight: 500,
  cursor: 'pointer',
}

const GHOST_BTN: React.CSSProperties = {
  minHeight: '32px',
  padding: '0 12px',
  borderRadius: '7px',
  background: '#303030',
  border: '1px solid #484848',
  color: '#ddd',
  fontSize: '13px',
  cursor: 'pointer',
}

function FlowBar({ ctx, scope, visible, worktree }: { ctx: any; scope: { sessionId: string; cwd?: string }; visible: boolean; worktree?: string }) {
  const [action, setAction] = useState<FlowAction | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [currentBranch, setCurrentBranch] = useState('')
  const [allBranches, setAllBranches] = useState<string[]>([])
  const [changedCount, setChangedCount] = useState(0)
  const [sessionPrs, setSessionPrs] = useState<PrRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const [newBranchName, setNewBranchName] = useState(() => `flow/${formatDateTag()}-work`)
  const [baseBranch, setBaseBranch] = useState('')
  const [rebaseTarget, setRebaseTarget] = useState('main')
  const [commitMsg, setCommitMsg] = useState('')
  const [prUrl, setPrUrl] = useState('')
  const [mergePrUrl, setMergePrUrl] = useState('')
  const [prMenuOpen, setPrMenuOpen] = useState(false)
  const prMenuRef = useRef<HTMLDivElement>(null)
  const [squashMerge, setSquashMerge] = useState(true)
  const refreshGeneration = useRef(0)

  const refreshGit = useCallback(async () => {
    if (!scope?.sessionId) return
    const generation = ++refreshGeneration.current
    try {
      const [branchRes, statusRes, prsRes] = await Promise.allSettled([
        apiPost<{ current: string; names: string[] }>('/sidebar/api/git.branch', {
          sessionId: scope.sessionId,
          cwd: scope.cwd,
          worktree,
        }),
        apiPost<{ branch: string; entries: Array<{ path: string; xy: string }> }>('/sidebar/api/git.status', {
          sessionId: scope.sessionId,
          cwd: scope.cwd,
          worktree,
        }),
        apiPost<{ prs: PrRecord[] }>('/changes-flow/api/session-prs', { sessionId: scope.sessionId }),
      ])
      if (generation !== refreshGeneration.current) return
      if (branchRes.status === 'fulfilled') {
        setCurrentBranch(branchRes.value.current || '')
        setAllBranches(branchRes.value.names || [])
      }
      if (statusRes.status === 'fulfilled') {
        setChangedCount((statusRes.value.entries || []).length)
      }
      if (prsRes.status === 'fulfilled') {
        const prs = prsRes.value.prs || []
        setSessionPrs(prs)
        setMergePrUrl((prev) => prs.some(p => p.url === prev) ? prev : (prs[prs.length - 1]?.url || ''))
      }
    } catch {
      // silent: bar degrades to manual inputs
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.sessionId, scope?.cwd, worktree])

  useEffect(() => {
    if (!visible) return
    setCurrentBranch('')
    setAllBranches([])
    setChangedCount(0)
    void refreshGit()
    const timer = window.setInterval(() => { void refreshGit() }, 2_000)
    return () => { window.clearInterval(timer); refreshGeneration.current += 1 }
  }, [visible, refreshGit])

  useEffect(() => {
    if (!menuOpen) return
    const closeOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => document.removeEventListener('mousedown', closeOutside)
  }, [menuOpen])

  useEffect(() => {
    if (!prMenuOpen) return
    const closeOutside = (event: MouseEvent) => { if (!prMenuRef.current?.contains(event.target as Node)) setPrMenuOpen(false) }
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPrMenuOpen(false) }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape) }
  }, [prMenuOpen])

  useEffect(() => {
    if (!action && !menuOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        if (!loading) setAction(null)
        triggerRef.current?.focus()
      }
      if (event.key !== 'Tab' || !action || !dialogRef.current) return
      const elements = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])'))
      if (elements.length === 0) return
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    if (action) requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>('input, select, button')?.focus())
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [action, menuOpen, loading])

  const say = (type: 'ok' | 'err', text: string) => setFeedback({ type, text })

  const handleBranch = async () => {
    if (!newBranchName.trim()) return say('err', 'Branch name cannot be empty')
    setLoading(true)
    setFeedback(null)
    try {
      const res = await apiPost<{ branch: string }>('/changes-flow/api/flow-branch', {
        sessionId: scope.sessionId,
        cwd: scope.cwd,
        worktree,
        name: newBranchName.trim(),
        base: baseBranch.trim() || undefined,
      })
      say('ok', `Switched to "${res.branch}" with current changes.`)
      setNewBranchName(`flow/${formatDateTag()}-work`)
      await refreshGit()
    } catch (e: any) {
      say('err', e.message || 'Branch failed')
    } finally {
      setLoading(false)
    }
  }

  const handleRebasePrompt = () => {
    const target = rebaseTarget.trim() || 'main'
    const ok = appendToDraft(
      ctx,
      scope.sessionId,
      `In the Git worktree at ${JSON.stringify(worktree || scope.cwd)}, please rebase the current branch onto "${target}". Carefully resolve any conflicts, keep our local changes, and run checks to verify everything works.`,
    )
    say(ok ? 'ok' : 'err', ok ? 'Rebase instruction inserted into composer draft.' : 'Failed to insert draft.')
  }

  const handleCommitPrompt = () => {
    const ok = appendToDraft(
      ctx,
      scope.sessionId,
      `Please review the unstaged and staged git changes in the worktree at ${JSON.stringify(worktree || scope.cwd)} and propose a concise Conventional Commit message (e.g. feat: ..., fix: ..., chore: ...).`,
    )
    say(ok ? 'ok' : 'err', ok ? 'Commit-message request inserted into composer draft.' : 'Failed to insert draft.')
  }

  const handlePushPrompt = () => {
    const ok = appendToDraft(ctx, scope.sessionId, `In the Git worktree at ${JSON.stringify(worktree || scope.cwd)}, please push the current branch to its remote, setting the upstream if needed. Report the remote and branch you pushed.`)
    say(ok ? 'ok' : 'err', ok ? 'Push instruction inserted into the composer.' : 'Failed to insert draft.')
  }

  const handleCommitAll = async () => {
    if (!commitMsg.trim()) return say('err', 'Please enter a commit message.')
    setLoading(true)
    setFeedback(null)
    try {
      await apiPost('/sidebar/api/git.stage', { sessionId: scope.sessionId, cwd: scope.cwd, worktree })
      await apiPost('/sidebar/api/git.commit', {
        sessionId: scope.sessionId,
        cwd: scope.cwd,
        worktree,
        message: commitMsg.trim(),
      })
      say('ok', 'Staged and committed.')
      setCommitMsg('')
      await refreshGit()
    } catch (e: any) {
      say('err', e.message || 'Commit failed')
    } finally {
      setLoading(false)
    }
  }

  const handlePrPrompt = () => {
    const ok = appendToDraft(
      ctx,
      scope.sessionId,
      `In the Git worktree at ${JSON.stringify(worktree || scope.cwd)}, please inspect the commits and diff on the current branch against main, compose a clear PR title and description, and run \`gh pr create\` there.`,
    )
    say(ok ? 'ok' : 'err', ok ? 'PR prompt inserted into composer draft.' : 'Failed to insert draft.')
  }

  const handleSavePr = async () => {
    if (!prUrl.trim() || !/^https?:\/\/[^/]+\/.+\/pull\/\d+\/?$/.test(prUrl.trim())) return say('err', 'Enter a valid PR URL.')
    if (!currentBranch) return say('err', 'Current branch is unknown; refresh Git status first.')
    setLoading(true)
    setFeedback(null)
    try {
      const res = await apiPost<{ prs: PrRecord[] }>('/changes-flow/api/record-pr', {
        sessionId: scope.sessionId,
        url: prUrl.trim(),
        branch: currentBranch,
      })
      setSessionPrs(res.prs || [])
      setMergePrUrl(prUrl.trim())
      say('ok', 'PR saved to this session.')
      setPrUrl('')
    } catch (e: any) {
      say('err', e.message || 'Save PR failed')
    } finally {
      setLoading(false)
    }
  }

  const handleMerge = async () => {
    const pr = sessionPrs.find(p => p.url === mergePrUrl)
    if (!pr?.branch) return say('err', 'Select a recorded PR with a local branch.')
    if (currentBranch !== 'main') return say('err', 'Switch to main before merging this PR.')
    if (pr.branch === currentBranch) return say('err', 'Cannot merge main into itself.')
    setLoading(true)
    setFeedback(null)
    try {
      const res = await apiPost<{ output: string }>('/changes-flow/api/flow-merge', {
        sessionId: scope.sessionId,
        cwd: scope.cwd,
        worktree,
        url: pr.url,
        squash: squashMerge,
      })
      say('ok', `Merge complete: ${res.output.trim() || 'done.'}`)
      await refreshGit()
    } catch (e: any) {
      say('err', e.message || 'Merge failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div style={BAR}>
        <div title={`${currentBranch || 'No branch'} · ${changedCount} changed files`} style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, fontSize: 12 }}>
          <ActionIcon action="branch" />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentBranch || 'Changes'}</span>
          {changedCount > 0 && <span style={{ color: '#777' }}>· {changedCount}</span>}
        </div>
        <div ref={menuRef} style={{ position: 'relative', display: 'flex', flex: 'none' }}>
          <button type="button" onClick={() => { setAction('commit'); setMenuOpen(false); setFeedback(null) }} style={{ display: 'flex', alignItems: 'center', gap: 7, height: 29, padding: '0 9px', border: '1px solid #414141', borderRight: 0, borderRadius: '8px 0 0 8px', background: '#282828', color: '#aaa', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <FlowIcon /> Commit or push
          </button>
          <button ref={triggerRef} type="button" aria-label="More flow actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)} style={{ display: 'grid', placeItems: 'center', width: 25, height: 29, border: '1px solid #414141', borderRadius: '0 8px 8px 0', background: '#282828', color: '#999', cursor: 'pointer' }}>
            <Chevron />
          </button>
          {menuOpen && <div role="menu" aria-label="Flow actions" style={{ position: 'absolute', right: 0, top: 34, width: 222, padding: 4, border: '1px solid #383838', borderRadius: 12, background: '#292929', boxShadow: '0 12px 30px rgba(0,0,0,.42)', zIndex: 100 }}>
            {ACTIONS.map(item => <button key={item.id} type="button" role="menuitem" onClick={() => { setAction(item.id); setMenuOpen(false); setFeedback(null) }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 32, padding: '5px 9px', border: 0, borderRadius: 7, background: 'transparent', color: '#b8b8b8', textAlign: 'left', fontSize: 13, cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.background = '#373737' }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
              <ActionIcon action={item.id} /><span>{item.label}</span>
            </button>)}
          </div>}
        </div>
      </div>

      {action && <div role="presentation" onMouseDown={e => { if (e.target === e.currentTarget && !loading) setAction(null) }} style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', padding: 20, background: 'rgba(0,0,0,.62)', zIndex: 10000 }}>
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="flow-dialog-title" style={{ width: 'min(420px, 100%)', maxHeight: 'min(650px, calc(100vh - 40px))', overflowY: 'auto', padding: 20, border: '1px solid #484848', borderRadius: 14, background: '#242424', color: '#e7e7e7', boxShadow: '0 24px 70px rgba(0,0,0,.5)', fontSize: 13 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 20 }}>
            <div>
              <div id="flow-dialog-title" style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 16, fontWeight: 600, color: '#f2f2f2' }}><ActionIcon action={action} />{ACTIONS.find(item => item.id === action)?.label}</div>
              <div style={{ marginTop: 5, color: '#999', lineHeight: 1.4 }}>{ACTIONS.find(item => item.id === action)?.description}</div>
            </div>
            <button type="button" aria-label="Close dialog" onClick={() => setAction(null)} disabled={loading} style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, border: 0, background: 'transparent', color: '#aaa', cursor: 'pointer' }}><CloseIcon /></button>
          </div>

          {action === 'branch' && <div style={{ display: 'grid', gap: 12 }}>
            <label style={{ display: 'grid', gap: 6 }}>Branch name<input value={newBranchName} onChange={e => setNewBranchName(e.target.value)} placeholder="flow/name" style={INPUT} /></label>
            <label style={{ display: 'grid', gap: 6 }}>Start from<select value={baseBranch} onChange={e => setBaseBranch(e.target.value)} style={INPUT}>
              <option value="">HEAD ({currentBranch || 'current'})</option>
              {allBranches.map(b => <option key={b} value={b}>{b}</option>)}
            </select></label>
            <button type="button" onClick={() => void handleBranch()} disabled={loading} style={PRIMARY_BTN}>{loading ? 'Working…' : 'Create and switch'}</button>
          </div>}

          {action === 'rebase' && <div style={{ display: 'grid', gap: 12 }}>
            <label style={{ display: 'grid', gap: 6 }}>Rebase from<input value={rebaseTarget} onChange={e => setRebaseTarget(e.target.value)} placeholder="main" style={INPUT} /></label>
            <button type="button" onClick={handleRebasePrompt} style={PRIMARY_BTN}>Ask assistant to rebase</button>
          </div>}

          {action === 'commit' && <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8 }}><button type="button" onClick={handleCommitPrompt} style={GHOST_BTN}>Ask for a message</button><button type="button" onClick={handlePushPrompt} style={GHOST_BTN}>Ask to push</button></div>
            <label style={{ display: 'grid', gap: 6 }}>Commit message<input value={commitMsg} onChange={e => setCommitMsg(e.target.value)} placeholder="feat: describe the change" style={INPUT} /></label>
            <button type="button" onClick={() => void handleCommitAll()} disabled={loading} style={PRIMARY_BTN}>{loading ? 'Working…' : 'Stage and commit'}</button>
          </div>}

          {action === 'pr' && <div style={{ display: 'grid', gap: 12 }}>
            <button type="button" onClick={handlePrPrompt} style={PRIMARY_BTN}>Ask assistant to create PR</button>
            <div style={{ borderTop: '1px solid #3c3c3c', margin: '2px 0' }} />
            <label style={{ display: 'grid', gap: 6 }}>Record a created PR<input value={prUrl} onChange={e => setPrUrl(e.target.value)} placeholder="https://github.com/owner/repo/pull/123" style={INPUT} /></label>
            <button type="button" onClick={() => void handleSavePr()} disabled={loading} style={GHOST_BTN}>Save PR to this session</button>
            {sessionPrs.length > 0 && <span style={{ color: '#999' }}>{sessionPrs.length} PR{sessionPrs.length === 1 ? '' : 's'} recorded in this session</span>}
          </div>}

          {action === 'merge' && <div style={{ display: 'grid', gap: 12 }}>
            <div ref={prMenuRef} style={{ display: 'grid', gap: 6, position: 'relative' }}>
              <span>Recorded PR</span>
              <button type="button" aria-haspopup="listbox" aria-expanded={prMenuOpen} onClick={() => setPrMenuOpen(open => !open)} style={{ ...INPUT, width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, textAlign: 'left', cursor: 'pointer', background: '#303030' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sessionPrs.find(p => p.url === mergePrUrl)?.branch || 'Select a PR…'}</span><Chevron />
              </button>
              {prMenuOpen && <div role="listbox" aria-label="Recorded PRs" style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, maxHeight: 220, overflowY: 'auto', padding: 4, border: '1px solid #383838', borderRadius: 10, background: '#292929', boxShadow: '0 12px 30px rgba(0,0,0,.42)', zIndex: 100 }}>
                {sessionPrs.filter(p => p.branch).length === 0 && <div style={{ padding: '8px 9px', color: '#999' }}>No recorded PRs</div>}
                {sessionPrs.filter(p => p.branch).map(p => <button key={p.url} type="button" role="option" aria-selected={p.url === mergePrUrl} onClick={() => { setMergePrUrl(p.url); setPrMenuOpen(false) }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', minHeight: 34, padding: '5px 9px', border: 0, borderRadius: 7, background: p.url === mergePrUrl ? '#373737' : 'transparent', color: '#d8d8d8', textAlign: 'left', fontSize: 13, cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.background = '#373737' }} onMouseLeave={e => { e.currentTarget.style.background = p.url === mergePrUrl ? '#373737' : 'transparent' }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.url}>{p.branch}</span>{p.url === mergePrUrl && <CheckIcon />}</button>)}
              </div>}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}><input type="checkbox" checked={squashMerge} onChange={e => setSquashMerge(e.target.checked)} />Squash changes</label>
            <button type="button" onClick={() => void handleMerge()} disabled={loading || !mergePrUrl} style={{ ...PRIMARY_BTN, opacity: loading || !mergePrUrl ? .55 : 1 }}>{loading ? 'Working…' : 'Merge into main'}</button>
          </div>}

          {feedback && <div role="status" style={{ marginTop: 16, padding: '9px 11px', borderRadius: 7, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: feedback.type === 'ok' ? '#21362b' : '#3a2525', color: feedback.type === 'ok' ? '#a9dfb7' : '#f4b6b6' }}>{feedback.text}</div>}
        </div>
      </div>}
    </>
  )
}

/** Wrap the git descriptor's component once; returns a restore fn. */
function WrappedGitTab({ Orig, props }: { Orig: any; props: any }) {
  const prefs = usePluginPreferences()
  const rootRef = useRef<HTMLDivElement>(null)
  const [worktree, setWorktree] = useState<string | undefined>()
  useEffect(() => {
    if (!prefs.changesTab || !rootRef.current) return
    const root = rootRef.current
    const syncWorktree = () => {
      const select = root.querySelector<HTMLSelectElement>('[class*="gitWorktreeRow"] select')
      const selected = select?.value || undefined
      setWorktree(previous => previous === selected ? previous : selected)
    }
    const observer = new MutationObserver(syncWorktree)
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['value', 'selected', 'title'] })
    root.addEventListener('change', syncWorktree, true)
    const timer = window.setInterval(syncWorktree, 2_000)
    syncWorktree()
    return () => {
      observer.disconnect()
      root.removeEventListener('change', syncWorktree, true)
      window.clearInterval(timer)
    }
  }, [prefs.changesTab, props.scope?.sessionId, props.scope?.cwd])
  if (!prefs.changesTab) return <Orig {...props} />
  return <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
    <FlowBar ctx={props.ctx} scope={props.scope} visible={props.visible} worktree={worktree} />
    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}><Orig {...props} /></div>
  </div>
}

function wrapGitTab(sidebar: any): (() => void) | undefined {
  try {
    const d = typeof sidebar.getTab === 'function'
      ? sidebar.getTab('git')
      : (sidebar.getTabs?.() || []).find((t: any) => t.id === 'git')
    if (!d || typeof d.component !== 'function') return undefined
    if ((d as any)._flowWrapped) return undefined
    const Orig = d.component
    ;(d as any)._flowWrapped = true
    d.component = (props: any) => <WrappedGitTab Orig={Orig} props={props} />
    return () => {
      if ((d as any)._flowWrapped) {
        d.component = Orig
        delete (d as any)._flowWrapped
      }
    }
  } catch (e) {
    console.warn('[dsh-changes-flow] wrap failed:', e)
    return undefined
  }
}

export function apply(ctx: Context): void {
  const c: any = ctx as any
  c.slots.inject('conversation.header.leading', () => c.slots.register(
    { name: 'conversation.header.leading' },
    () => <ComposerAnchor ctx={c} />,
  ))
  // Fast path: sidebar already present (ego-browser pattern)
  try {
    const svc = typeof c.get === 'function' ? c.get('betterSidebar') : undefined
    if (svc) {
      c.effect(() => {
        let restore = wrapGitTab(svc)
        let unsub: (() => void) | undefined
        if (!restore && typeof svc.subscribe === 'function') {
          unsub = svc.subscribe(() => {
            if (!restore) restore = wrapGitTab(svc)
            if (restore && unsub) { unsub(); unsub = undefined }
          })
        }
        return () => { unsub?.(); restore?.(); restore = undefined }
      }, 'dsh-changes-flow: wrap git tab')
      return
    }
  } catch { /* fall through to inject */ }
  // Deferred path: wait for betterSidebar (static inject stays clean)
  if (typeof c.inject === 'function') {
    c.inject(['betterSidebar'], (sctx: any) => {
      const svc = typeof sctx.get === 'function' ? sctx.get('betterSidebar') : sctx.betterSidebar
      if (!svc) return
      sctx.effect(() => {
        let restore = wrapGitTab(svc)
        let unsub: (() => void) | undefined
        if (!restore && typeof svc.subscribe === 'function') {
          unsub = svc.subscribe(() => {
            if (!restore) restore = wrapGitTab(svc)
            if (restore && unsub) { unsub(); unsub = undefined }
          })
        }
        return () => { unsub?.(); restore?.(); restore = undefined }
      }, 'dsh-changes-flow: wrap git tab')
    })
  }
}
