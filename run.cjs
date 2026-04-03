#!/usr/bin/env node
'use strict';

/**
 * forest
 * Automated issue resolution agent.
 */

const { spawnSync }                                   = require('child_process');
const { existsSync, mkdirSync, writeFileSync,
        readFileSync, unlinkSync, rmSync }             = require('fs');
const { join }                                        = require('path');

// __dirname is global in CJS

// ─── Env Loader ───────────────────────────────────────────────────────────────

const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      process.env[key.trim()] = valueParts.join('=').trim();
    }
  });
}

// ─── Config ───────────────────────────────────────────────────────────────────

const NTFY_TOPIC = process.env.NTFY_TOPIC || 'forest-agent-notifications';
const NTFY_URL   = `https://ntfy.sh/${NTFY_TOPIC}`;
const TARGET_REPOS = (process.env.GITHUB_REPO || 'thepoly/polymer').split(',');
const BOT_REPO_BASE = process.env.BOT_REPO_BASE || '/home/poly/forest-workspaces';
const GEMINI_MODELS = (process.env.GEMINI_MODELS || 'gemini-3.1-pro-preview,gemini-3-flash-preview').split(',');

const GIT_NAME = process.env.GIT_NAME || 'forest-agent';
const GIT_EMAIL = process.env.GIT_EMAIL || 'forest@example.com';

const LOCKFILE     = '/tmp/forest.lock';
const QUOTA_NOTIF_FILE = '/tmp/forest-quota-notified.json';
const NO_PROGRESS_FILE = '/tmp/forest-no-progress.json';
const TRANSCRIPT_DIR = join(__dirname, 'transcripts');
const MAX_CYCLES   = 5;
const ISSUE_IMAGE_ROOT = '/tmp/forest-issue-images';
const MAX_ISSUE_IMAGES = 6;
const AGENT_MAX_BUFFER = 100 * 1024 * 1024;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function exec(cmd, opts = {}) {
  const result = spawnSync('bash', ['-c', cmd], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  if (result.status !== 0 && !opts.allowFailure) {
    const msg = (result.stderr || '').trim() || `exit ${result.status}`;
    throw new Error(`Command failed: ${cmd}\n${msg}`);
  }
  return (result.stdout || '').trim();
}

function execArgs(bin, args, opts = {}) {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  if (result.status !== 0 && !opts.allowFailure) {
    const msg = (result.stderr || '').trim() || `exit ${result.status}`;
    throw new Error(`Command failed: ${bin} ${args.join(' ')}\n${msg}`);
  }
  return (result.stdout || '').trim();
}

function formatAgentFailure(label, result) {
  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  const details = stderr || stdout;
  return `[${label}] exited ${result.status}${details ? ':\n' + details : ''}`;
}

function isGeminiLimitMessage(text) {
  const t = text.toLowerCase();
  return (
    t.includes('usage limit') ||
    t.includes('quota') ||
    t.includes('429') ||
    t.includes('rate limit') ||
    t.includes('too many requests')
  );
}

function isGeminiMissingModelMessage(text) {
  const t = text.toLowerCase();
  return t.includes('modelnotfounderror') || t.includes('requested entity was not found');
}

function isPrCreatePermissionError(text) {
  return (
    text.includes('resource not accessible by personal access token') &&
    text.includes('createpullrequest')
  );
}

function stripModelArg(args) {
  const nextArgs = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-m' || args[i] === '--model') {
      i += 1;
      continue;
    }
    nextArgs.push(args[i]);
  }
  return nextArgs;
}

function normalizeCapturedUrl(rawUrl) {
  return rawUrl
    .trim()
    .replace(/^['"<([]+/g, '')
    .replace(/[>"')\].,]+$/g, '');
}

function isLikelyIssueImageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    return (
      /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(pathname) ||
      host.endsWith('githubusercontent.com') ||
      (host === 'github.com' && pathname.includes('/user-attachments/assets/'))
    );
  } catch {
    return false;
  }
}

function extractIssueImageUrls(body = '') {
  const urls = new Set();
  for (const match of body.matchAll(/!\[[^\]]*]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    urls.add(normalizeCapturedUrl(match[1]));
  }
  for (const match of body.matchAll(/<img\b[^>]*\bsrc="(https?:\/\/[^"]+)"/gi)) {
    urls.add(normalizeCapturedUrl(match[1]));
  }
  for (const match of body.matchAll(/https?:\/\/\S+/g)) {
    const url = normalizeCapturedUrl(match[0]);
    if (isLikelyIssueImageUrl(url)) urls.add(url);
  }
  return Array.from(urls).slice(0, MAX_ISSUE_IMAGES);
}

function extractIssueImageUrlsFromIssue(issue) {
  const urls = new Set();
  const texts = [
    issue.body || '',
    ...(issue.comments || []).map(comment => comment.body || ''),
  ];
  for (const text of texts) {
    for (const url of extractIssueImageUrls(text)) {
      if (urls.size >= MAX_ISSUE_IMAGES) break;
      urls.add(url);
    }
    if (urls.size >= MAX_ISSUE_IMAGES) break;
  }
  return Array.from(urls);
}

function buildIssueDiscussion(issue) {
  const cleanText = (text = '') => text
    .replace(/<img\b[^>]*>/gi, '[attached image]')
    .replace(/!\[[^\]]*]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g, '[attached image]')
    .trim();

  const body = cleanText(issue.body) || '(no description)';
  const comments = (issue.comments || [])
    .map((comment, index) => {
      const commentBody = cleanText(comment.body);
      if (!commentBody) return null;
      return [
        `Comment ${index + 1}:`,
        commentBody,
      ].join('\n');
    })
    .filter(Boolean);

  return [body, ...comments].join('\n\n');
}

function guessImageExtension(url, contentType = '') {
  const type = contentType.toLowerCase();
  if (type.includes('png')) return '.png';
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  if (type.includes('gif')) return '.gif';
  if (type.includes('webp')) return '.webp';
  if (type.includes('bmp')) return '.bmp';
  if (type.includes('svg')) return '.svg';
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(png|jpe?g|gif|webp|bmp|svg)$/i);
    if (match) return `.${match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()}`;
  } catch {}
  return '.img';
}

async function downloadIssueImages(issue, stamp) {
  const urls = extractIssueImageUrlsFromIssue(issue);
  if (urls.length === 0) return [];

  const issueDir = `${ISSUE_IMAGE_ROOT}/${stamp}/issue-${issue.number}`;
  mkdirSync(issueDir, { recursive: true });
  const githubToken = execArgs('gh', ['auth', 'token'], { allowFailure: true });

  const images = [];
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    try {
      const response = await fetch(url, {
        headers: {
          ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
          Accept: 'application/octet-stream',
          'User-Agent': 'forest',
        },
      });
      if (!response.ok) continue;

      const contentType = response.headers.get('content-type') || '';
      if (contentType && !contentType.toLowerCase().startsWith('image/')) continue;

      const filePath = `${issueDir}/${String(index + 1).padStart(2, '0')}${guessImageExtension(url, contentType)}`;
      writeFileSync(filePath, Buffer.from(await response.arrayBuffer()));
      images.push({ url, path: filePath, contentType });
    } catch (error) {
      console.error(`Issue #${issue.number} image download failed: ${url}\n${error.message}`);
    }
  }
  return images;
}

function buildIssueImageSummaryPrompt(issue) {
  return [
    `Summarize the attached GitHub issue image(s) for issue #${issue.number}: ${issue.title}`,
    '',
    'Focus only on concrete visual details that matter for implementation.',
    'Keep the result under 220 words.',
    '',
    'Issue discussion:',
    buildIssueDiscussion(issue).slice(0, 5000),
  ].join('\n');
}

async function enrichIssuesWithImages(issues, stamp, workspace) {
  const enriched = [];
  for (const issue of issues) {
    const imageAttachments = await downloadIssueImages(issue, stamp);
    let imageAnalysis = '';

    if (imageAttachments.length > 0) {
      const imageArgs = imageAttachments.flatMap(img => ['--image', img.path]);
      try {
        imageAnalysis = await runGemini(
          `Gemini:vision:#${issue.number}`,
          [...imageArgs, '-p', buildIssueImageSummaryPrompt(issue), '-y', '--output-format', 'text'],
          workspace
        );
      } catch (error) {
        console.error(`Issue #${issue.number} image analysis failed: ${error.message}`);
      }
    }
    enriched.push({ ...issue, imageAttachments, imageAnalysis });
  }
  return enriched;
}

function buildVisualContextBlock(issues) {
  const blocks = issues
    .map(issue => {
      if (!issue.imageAttachments?.length) return null;
      return [
        `### Visual Context For Issue #${issue.number}: ${issue.title}`,
        `Attached images (${issue.imageAttachments.length}):`,
        ...issue.imageAttachments.map((image, index) => `- image ${index + 1}: ${image.path}`),
        issue.imageAnalysis ? `\nAnalysis:\n${issue.imageAnalysis}` : null,
      ].filter(Boolean).join('\n');
    })
    .filter(Boolean);

  return blocks.length === 0 ? 'No issue images were attached.' : blocks.join('\n\n---\n\n');
}

function getIssueImageArgs(issues) {
  return issues.flatMap(issue => (issue.imageAttachments || []).flatMap(image => ['--image', image.path]));
}

function runAgent(label, bin, args, cwd, { input, captureOutput = true } = {}) {
  log(`▶ [${label}] starting...`);
  
  if (!existsSync(TRANSCRIPT_DIR)) mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = join(TRANSCRIPT_DIR, `${label.replace(/[:/]/g, '-')}-${Date.now()}.txt`);

  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    stdio: input !== undefined
      ? ['pipe', 'pipe', 'pipe']
      : ['ignore', 'pipe', 'pipe'],
    ...(input !== undefined ? { input } : {}),
    maxBuffer: AGENT_MAX_BUFFER,
    timeout: 45 * 60 * 1000,
    env: { ...process.env, HOME: '/home/poly' },
  });

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  
  // Save full transcript (reasoning + tools + output)
  writeFileSync(transcriptPath, `--- STDOUT ---\n${stdout}\n\n--- STDERR ---\n${stderr}`);

  if (result.error) throw new Error(`[${label}] spawn error: ${result.error.message}`);
  if (result.status !== 0) throw new Error(formatAgentFailure(label, result));

  const out = captureOutput ? stdout : '';
  log(`✓ [${label}] done (transcript: ${transcriptPath})`);
  return out;
}

async function runGemini(label, args, cwd, options = {}) {
  const baseArgs = stripModelArg(args);

  for (const model of GEMINI_MODELS) {
    try {
      return runAgent(`${label}:${model}`, 'gemini', ['-m', model, ...baseArgs], cwd);
    } catch (error) {
      const message = String(error.message || '');
      const isLimit = isGeminiLimitMessage(message);
      const isMissing = isGeminiMissingModelMessage(message);

      if (isLimit || isMissing) {
        log(`⚠ [${label}] Gemini model ${model} ${isLimit ? 'limit reached' : 'unavailable'} — trying next model.`);
        continue;
      }
      throw error;
    }
  }

  if (options.onAllExhausted) {
    await options.onAllExhausted();
  } else {
    log(`All Gemini models exhausted. Will retry on next timer tick.`);
  }
  process.exit(0); 
}

async function ntfyPost(body, title, priority = 'default') {
  const headerSafeTitle = title.replace(/[\u2012-\u2015]/g, '-').replace(/[^\x20-\x7E]/g, '?');
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(NTFY_URL, {
        method: 'POST',
        headers: { 'Title': headerSafeTitle, 'Priority': priority, 'Tags': 'robot', 'User-Agent': 'forest' },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) return;
    } catch (e) {
      console.error(`ntfy post failed (attempt ${attempt}/${attempts}):`, e.message);
    }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
  }
}

function getPRFeedback(prUrl, repo) {
  try {
    const data = JSON.parse(execArgs('gh', ['pr', 'view', prUrl, '--repo', repo, '--json', 'reviews,comments']));
    const feedback = [];
    for (const c of (data.comments || [])) {
      if (c.author.login === GIT_NAME) feedback.push(`Comment from ${GIT_NAME}: ${c.body}`);
    }
    for (const r of (data.reviews || [])) {
      if (r.author.login === GIT_NAME) {
        if (r.body) feedback.push(`Review from ${GIT_NAME} (${r.state}): ${r.body}`);
        for (const lc of (r.comments || [])) feedback.push(`Code comment from ${GIT_NAME} on ${lc.path}:${lc.line}: ${lc.body}`);
      }
    }
    return feedback.length > 0 ? feedback.join('\n\n---\n\n') : null;
  } catch (e) {
    log(`Warning: Failed to fetch PR feedback: ${e.message}`);
    return null;
  }
}

async function waitForApproval(prUrl, repo) {
  log(`Waiting for ${GIT_NAME} to review/approve PR: ${prUrl}`);
  while (true) {
    try {
      const data = JSON.parse(execArgs('gh', ['pr', 'view', prUrl, '--repo', repo, '--json', 'reviews,comments,state']));
      const approval = (data.reviews || []).find(r => r.author.login === GIT_NAME && r.state === 'APPROVED');
      if (approval) return 'merge';
      const changesRequested = (data.reviews || []).find(r => r.author.login === GIT_NAME && r.state === 'CHANGES_REQUESTED');
      if (changesRequested) return 'iterate';
      const allComments = [...(data.comments || []), ...(data.reviews || []).map(r => ({ body: r.body, author: r.author })), ...(data.reviews || []).flatMap(r => r.comments || [])];
      for (const c of allComments) {
        if (!c || !c.author || c.author.login !== GIT_NAME) continue;
        const msg = (c.body || '').trim().toLowerCase();
        if (msg.includes('/merge')) return 'merge';
        if (msg.includes('/iterate')) return 'iterate';
        if (msg.includes('/stop')) return 'stop';
      }
      if (data.state === 'MERGED' || data.state === 'CLOSED') return 'stop';
    } catch (e) { log(`Error polling PR: ${e.message}`); }
    await new Promise(r => setTimeout(r, 30000)); 
  }
}

// ─── Core ─────────────────────────────────────────────────────────────────────

async function run() {
  if (existsSync(LOCKFILE)) {
    const pid = readFileSync(LOCKFILE, 'utf8').trim();
    try {
      execArgs('kill', ['-0', pid]);
      log(`Another instance (PID ${pid}) is running. Exiting.`);
      process.exit(0);
    } catch {
      log('Stale lockfile found. Removing.');
      unlinkSync(LOCKFILE);
    }
  }
  writeFileSync(LOCKFILE, String(process.pid));

  try {
    for (const repo of TARGET_REPOS) {
      try {
        await pipeline(repo);
      } catch (err) {
        log(`Error in pipeline for ${repo}: ${err.message}`);
      }
    }
  } finally {
    try { unlinkSync(LOCKFILE); } catch {}
  }
}

async function pipeline(repo) {
  const openPRs = JSON.parse(execArgs('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,headRefName,body']));
  const botPRs = openPRs.filter(pr => pr.headRefName.startsWith('bot/'));
  
  let branch;
  let resumePR = null;
  let manualIssueNumbers = [];

  if (botPRs.length > 0) {
    resumePR = botPRs[0];
    branch = resumePR.headRefName;
    log(`[${repo}] Resuming existing bot PR #${resumePR.number} (${branch}).`);
    const bodyText = resumePR.body || '';
    const issueMatches = bodyText.match(/#[0-9]+/g);
    if (issueMatches) manualIssueNumbers = Array.from(new Set(issueMatches.map(s => s.replace('#', ''))));
  }

  let issues = [];
  if (manualIssueNumbers.length > 0) {
    for (const num of manualIssueNumbers) {
      try { issues.push(JSON.parse(execArgs('gh', ['issue', 'view', num, '--repo', repo, '--json', 'number,title,body,labels,comments']))); } catch (e) { log(`Failed to fetch resumed issue #${num}: ${e.message}`); }
    }
  }

  if (issues.length === 0) {
    const issueStubs = JSON.parse(execArgs('gh', ['issue', 'list', '--repo', repo, '--state', 'open', '--label', 'auto', '--json', 'number,title', '--limit', '20']));
    issues = issueStubs.map(issue => JSON.parse(execArgs('gh', ['issue', 'view', String(issue.number), '--repo', repo, '--json', 'number,title,body,labels,comments'])));
  }

  if (issues.length === 0) {
    log(`[${repo}] No open issues. Skipping.`);
    return;
  }

  const issueList = issues.map(i => `• #${i.number}: ${i.title}`).join('\n');
  const issueRefs = issues.map(i => `#${i.number}`).join(', ');

  if (!resumePR) {
    if (existsSync(NO_PROGRESS_FILE)) {
      const state = JSON.parse(readFileSync(NO_PROGRESS_FILE, 'utf8'));
      if (state[repo] === issueRefs) {
        log(`[${repo}] Already reported no progress for these issues. Skipping notification.`);
      } else {
        await ntfyPost(`[${repo}] Starting work on ${issues.length} issue(s):\n\n${issueList}`, `forest — Working on ${issueRefs}`);
      }
    } else {
      await ntfyPost(`[${repo}] Starting work on ${issues.length} issue(s):\n\n${issueList}`, `forest — Working on ${issueRefs}`);
    }

    if (existsSync(QUOTA_NOTIF_FILE)) {
      const state = JSON.parse(readFileSync(QUOTA_NOTIF_FILE, 'utf8'));
      if (state[repo] === issueRefs) { delete state[repo]; writeFileSync(QUOTA_NOTIF_FILE, JSON.stringify(state)); }
    }
  }

  log(`[${repo}] Processing ${issues.length} issue(s): ${issues.map(i => '#' + i.number).join(', ')}`);

  const workspace = join(BOT_REPO_BASE, repo.replace('/', '-'));
  if (!existsSync(workspace)) {
    mkdirSync(workspace, { recursive: true });
    execArgs('gh', ['repo', 'clone', repo, workspace]);
  }

  execArgs('git', ['-C', workspace, 'fetch', 'origin']);
  
  // Ensure correct identity in workspace
  execArgs('git', ['-C', workspace, 'config', 'user.name', GIT_NAME]);
  execArgs('git', ['-C', workspace, 'config', 'user.email', GIT_EMAIL]);
  
  if (resumePR) {
    execArgs('git', ['-C', workspace, 'checkout', branch]);
    execArgs('git', ['-C', workspace, 'reset', '--hard', `origin/${branch}`]);
  } else {
    execArgs('git', ['-C', workspace, 'checkout', 'main']);
    execArgs('git', ['-C', workspace, 'reset', '--hard', 'origin/main']);
    execArgs('git', ['-C', workspace, 'clean', '-fd']);
  }
  
  if (existsSync(join(workspace, 'package.json'))) {
    log(`[${repo}] Installing dependencies...`);
    execArgs('pnpm', ['-C', workspace, 'install', '--no-frozen-lockfile'], { allowFailure: true });
  }

  if (!resumePR) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    branch = `bot/issues-${stamp}`;
    execArgs('git', ['-C', workspace, 'checkout', '-b', branch]);
  }

  const stampForImages = branch.replace('bot/issues-', '');
  const enrichedIssues = await enrichIssuesWithImages(issues, stampForImages, workspace);
  const issueImageArgs = getIssueImageArgs(enrichedIssues);

  const issueText = enrichedIssues.map(i => {
    const labels = i.labels?.map(l => l.name).join(', ');
    const discussion = buildIssueDiscussion(i);
    return [`### Issue #${i.number}: ${i.title}`, labels ? `Labels: ${labels}` : null, '', discussion].filter(v => v !== null).join('\n');
  }).join('\n\n---\n\n');

  const codebaseCtx = [
    `Codebase: ${repo}`,
    `Repo path: ${workspace}`,
    `Git identity configured — commits as ${GIT_NAME}. No AI attribution.`,
    'Be precise — match existing production patterns.',
  ].join('\n');

  const visualContext = buildVisualContextBlock(enrichedIssues);

  const exhaustedHandler = async () => {
    let alreadyNotified = false;
    const state = existsSync(QUOTA_NOTIF_FILE) ? JSON.parse(readFileSync(QUOTA_NOTIF_FILE, 'utf8')) : {};
    if (state[repo] === issueRefs) alreadyNotified = true;
    if (!alreadyNotified) {
      const msg = `[${repo}] Found new issues but all Gemini models are exhausted.\n\nIssues:\n${issueList}\n\nforest will automatically retry every 60 seconds.`;
      await ntfyPost(msg, `forest — Quota Exhausted (${repo})`, 'default');
      state[repo] = issueRefs;
      writeFileSync(QUOTA_NOTIF_FILE, JSON.stringify(state));
    }
    log(`All Gemini models exhausted for ${repo}.`);
  };

  // ── Stage 1: Draft & Implement
  if (!resumePR) {
    const draftPrompt = `${codebaseCtx}\nAnalyze these issues and implement a solution. First, write a technical plan, then apply the code changes autonomously. You MUST actually edit files using the provided tools.\n\n## Visual Context\n${visualContext}\n\n${issueText}`;
    await runGemini(`${repo}:draft`, [...issueImageArgs, '-p', draftPrompt, '--approval-mode', 'yolo', '--output-format', 'text'], workspace, { onAllExhausted: exhaustedHandler });
  }

  let cycleCount = 0;
  while (cycleCount < MAX_CYCLES) {
    cycleCount += 1;

    let prUrl;
    try { prUrl = execArgs('gh', ['pr', 'view', branch, '--repo', repo, '--json', 'url', '-q', '.url'], { allowFailure: true }); } catch {}

    const userFeedback = prUrl ? getPRFeedback(prUrl, repo) : null;
    const feedbackCtx = userFeedback ? `\n\n## Human Review Feedback (HIGH PRIORITY)\n${userFeedback}` : '';

    // ── Stage 2: Verify & Fix
    const fullDiff      = execArgs('git', ['-C', workspace, 'diff', 'origin/main'], { allowFailure: true });
    const untracked     = execArgs('git', ['-C', workspace, 'ls-files', '--others', '--exclude-standard'], { allowFailure: true });
    const diffSection   = fullDiff  ? `\`\`\`diff\n${fullDiff}\n\`\`\`` : '(no changes)';
    const newFiles      = untracked ? `\n## New Files\n${untracked}` : '';

    const verifyPrompt = `${codebaseCtx}\nReview the current changes and fix any remaining issues, bugs, or type errors.${feedbackCtx}\n\n## Issues\n${issueText}\n\n## Changes to Review\n${diffSection}${newFiles}\n\nInstructions:\n- Read code carefully to match existing patterns.\n- If you modified package.json or collections, run \`pnpm install\` and \`pnpm generate:types\`.\n- BEFORE COMMITTING: you MUST run existing lint/typecheck scripts.\n- If you made changes, stage all and commit referencing ${issueRefs}.\n- If no more changes are needed, explicitly state that you are done.`;
    await runGemini(`${repo}:verify:c${cycleCount}`, [...issueImageArgs, '-p', verifyPrompt, '--approval-mode', 'yolo', '--output-format', 'text'], workspace, { onAllExhausted: exhaustedHandler });

    const commits = execArgs('git', ['-C', workspace, 'log', 'origin/main..HEAD', '--format=• %s'], { allowFailure: true });
    
    if (!commits) {
      log(`[${repo}] No changes made in cycle ${cycleCount}.`);
      const noProgressState = existsSync(NO_PROGRESS_FILE) ? JSON.parse(readFileSync(NO_PROGRESS_FILE, 'utf8')) : {};
      noProgressState[repo] = issueRefs;
      writeFileSync(NO_PROGRESS_FILE, JSON.stringify(noProgressState));
      break;
    }

    if (existsSync(NO_PROGRESS_FILE)) {
      const noProgressState = JSON.parse(readFileSync(NO_PROGRESS_FILE, 'utf8'));
      if (noProgressState[repo] === issueRefs) { delete noProgressState[repo]; writeFileSync(NO_PROGRESS_FILE, JSON.stringify(noProgressState)); }
    }

    execArgs('git', ['-C', workspace, 'push', '-f', '-u', 'origin', branch]);

    if (!prUrl) {
      const titlePrompt = `Write a concise PR title summarizing these changes: ${issueRefs}. Return ONLY the title string, without any preamble, explanation, or quotes.`;
      const prTitleRaw = await runGemini(`${repo}:title`, ['-p', titlePrompt, '-y', '--output-format', 'text'], workspace);
      const titleLines = prTitleRaw.split('\n').map(line => line.trim()).filter(line => line.length > 0);
      let prTitle = titleLines.find(line => !/^(?:sure|here is|proposed|below is|i have|this is)/i.test(line)) || titleLines[0] || 'Update';
      prTitle = prTitle.replace(/^["']|["']$/g, '').trim().slice(0, 72);
      const resolvesList = issues.map(i => `Resolves #${i.number}`).join('\n');
      const prBodyFile = `/tmp/forest-pr-body-${Date.now()}.txt`;
      writeFileSync(prBodyFile, `${resolvesList}\n\n${issueList}`);
      try { prUrl = execArgs('gh', ['pr', 'create', '--repo', repo, '--title', prTitle, '--body-file', prBodyFile, '--head', branch, '--base', 'main']); } finally { try { unlinkSync(prBodyFile); } catch {} }
    }

    const proposal = [`[${repo}] Issue resolved. Cycle ${cycleCount} complete.`, `PR: ${prUrl}`, '', `Review on GitHub:`, '• APPROVE to merge', '• REQUEST CHANGES to fix', '• Comment "/stop" to quit'].join('\n');
    await ntfyPost(proposal, `forest — Approval (${repo})`, 'high');

    const decision = await waitForApproval(prUrl, repo);
    if (decision === 'merge') {
      execArgs('gh', ['pr', 'merge', prUrl, '--squash', '--delete-branch', '--admin', '--repo', repo]);
      for (const issue of issues) execArgs('gh', ['issue', 'close', String(issue.number), '--repo', repo, '--comment', `Resolved by ${prUrl}`], { allowFailure: true });
      await ntfyPost(`[${repo}] Merged!`, `forest — Deployed (${repo})`, 'high');
      break;
    } else if (decision === 'iterate') continue;
    else if (decision === 'stop') { execArgs('systemctl', ['--user', 'stop', 'forest.timer']); process.exit(0); }
    else break;
  }
  try { if (existsSync(`${ISSUE_IMAGE_ROOT}/${stampForImages}`)) rmSync(`${ISSUE_IMAGE_ROOT}/${stampForImages}`, { recursive: true, force: true }); } catch {}
}

run().catch(async err => {
  log(`Fatal: ${err.message}`);
  try { await ntfyPost(err.message.slice(0, 500), 'forest - Crash', 'urgent'); } catch {}
  try { unlinkSync(LOCKFILE); } catch {}
  process.exit(1);
});
