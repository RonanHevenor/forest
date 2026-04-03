# Polybot

Automated issue resolution pipeline for The Polytechnic student newspaper.

## Overview

Polybot automatically fetches open GitHub issues with the `auto` label, generates an implementation plan, applies code changes, reviews them for quality, and opens a Pull Request for human approval.

## Agent Pipeline

1.  **Planning**: Gemini analyzes the issues and produces a step-by-step implementation plan.
2.  **Implementation**: Gemini applies the plan directly to the codebase.
3.  **Review (Iterative)**: Gemini evaluates the changes for bugs, regressions, and type errors.
4.  **Fix & Commit (Iterative)**: Gemini fixes identified issues, runs `pnpm lint`, `pnpm typecheck`, and commits the changes.
5.  **Approval**: PR is opened and a notification is sent to `ntfy`.

## Commands

- **merge**: Merge the PR and trigger a production deploy.
- **iterate**: Run another review/fix cycle.
- **stop**: Shutdown the bot timer.

## Setup

The bot is currently managed by a systemd timer on the production server.

```bash
# View logs
journalctl --user -u polymer-bot.service -f
```
