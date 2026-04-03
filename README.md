# forest

An automated issue resolution and continuous integration pipeline powered by AI.

## Overview

forest automatically fetches open GitHub issues, generates a technical implementation plan, applies the necessary code changes directly to your repository, reviews them for quality, and opens a Pull Request for human approval.

## Features

- **Autonomous Resolution**: Translates GitHub issues into applied code changes.
- **Iterative Quality Control**: Self-evaluates its own changes to fix regressions, bugs, and type errors.
- **Visual Context Support**: Parses image attachments in issues to inform the implementation process using vision models.
- **Push Notifications**: Integrated with `ntfy` for real-time status updates and human-in-the-loop approvals.

## Agent Pipeline

1.  **Planning**: An AI model (Gemini) analyzes the issues and produces a step-by-step implementation plan.
2.  **Implementation**: The plan is applied directly to the target codebase.
3.  **Review (Iterative)**: Evaluates the new changes for logic bugs and type errors.
4.  **Fix & Commit (Iterative)**: Fixes any identified issues, runs workspace checks, and commits the final patch.
5.  **Approval**: A Pull Request is opened and a notification is dispatched for final review.

## Commands

Respond directly to the PR with the following comments:
- **/merge** or **merge**: Approve and merge the PR, closing the corresponding issues.
- **/iterate** or **iterate**: Request changes and run another review/fix cycle.
- **/stop** or **stop**: Stop the current execution and gracefully exit.

## Setup & Execution

forest can be configured to run continuously via a cron job, systemd timer, or manually executed:

```bash
# Run the pipeline
node run.cjs
```

If managed by systemd:
```bash
# View logs
journalctl --user -u forest.service -f
```
