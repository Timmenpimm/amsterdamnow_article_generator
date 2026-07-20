# amsterdamnow-artikel-tool

## Standard workflow — ALWAYS use branches + PRs

Never commit or push directly to `main`, and never edit in place on `main` in
the primary checkout. Every change — even a one-line fix or a docs tweak —
goes through this loop:

1. **Branch off current `main`.** First `git fetch` + confirm you're based on
   the latest `origin/main`, then create a `feat/…`, `fix/…`, `chore/…` or
   `docs/…` branch (ideally inside an isolated worktree — see below).
2. **Commit** your work on that branch with clear messages.
3. **Open a PR into `main`** with `gh pr create` (title + short body of what
   changed and why).
4. **Merge the PR** with `gh pr merge <n> --merge --delete-branch` once it's
   green. This is the only way work reaches `main`.
5. **Clean up**: `git checkout main && git pull`, delete the local branch. Keep
   the branch list short — a merged branch is a deletable branch.

Do **not** `reset --hard`, force-push, or otherwise rewrite `main` or any
shared branch. If a branch is based on a stale point, **rebase it onto current
`main`** before opening/merging the PR (see the merge-base note below).

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
