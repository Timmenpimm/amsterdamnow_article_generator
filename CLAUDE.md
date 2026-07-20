# amsterdamnow-artikel-tool

## Concurrent Claude Code sessions

This repo is regularly worked on by more than one Claude Code session at the
same time. The primary checkout (`~/Claude/amsterdamnow-artikel-tool`) is
**shared, mutable state** — never assume you're the only session touching it.

On 2026-07-20 two concurrent sessions both edited `app/lib/writer.ts`,
`queue.ts`, `db.ts` and `types.ts` directly in the primary checkout. One
session's `git checkout`/`git pull` silently discarded the other's
uncommitted work mid-edit, and a stale local branch nearly got merged in a
way that would have deleted an already-shipped feature. Don't repeat this:

- **Always work in an isolated git worktree** for any non-trivial change —
  use the `EnterWorktree` tool (or the `superpowers:using-git-worktrees`
  skill as a fallback). Only edit files directly in the primary checkout if
  the user explicitly asks you to work in place.
- **Land finished work through a PR into `main`**
  (`gh pr create` + `gh pr merge`), matching this repo's existing history.
  Don't force-push, `reset --hard`, or otherwise rewrite `main` or shared
  branches.
- **Before merging or rebasing any branch**, check `git merge-base` against
  current `origin/main` first. A branch whose merge-base predates a recent
  merge (e.g. it's missing a feature that's already on `main`) will look
  like it "deletes" that feature in the diff — that's staleness, not
  intentional removal. Rebase onto current `main` before merging.
