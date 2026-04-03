#!/usr/bin/env node
'use strict';

/**
 * Polymer Bot
 * Automated issue resolution pipeline for thepoly/polymer.
 */

const { spawnSync }                                   = require('child_process');
const { existsSync, mkdirSync, writeFileSync,
        readFileSync, unlinkSync, rmSync }             = require('fs');
const { join }                                        = require('path');

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

const NTFY_TOPIC = process.env.NTFY_TOPIC || 'designer-slick-fetch-lily-spherical-gout-chitchat-snorkel';
const NTFY_URL   = `https://ntfy.sh/${NTFY_TOPIC}`;
const GITHUB_REPO = process.env.GITHUB_REPO || 'thepoly/polymer';
const BOT_REPO    = process.env.BOT_REPO || '/home/poly/polymer-bot';
const GEMINI_MODELS = (process.env.GEMINI_MODELS || 'gemini-3.1-pro-preview,gemini-2.5-pro,gemini-3-flash-preview').split(',');

const LOCKFILE     = '/tmp/polymer-bot.lock';
const APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_CYCLES   = 5;
const ISSUE_IMAGE_ROOT = '/tmp/polymer-bot-issue-images';
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
  const githubToken = exec('gh auth token', { allowFailure: true });

  const images = [];
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    try {
      const response = await fetch(url, {
        headers: {
          ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
          Accept: 'application/octet-stream',
          'User-Agent': 'polymer-bot',
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

async function enrichIssuesWithImages(issues, stamp) {
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
          BOT_REPO
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
  const result = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    stdio: input !== undefined
      ? ['pipe', captureOutput ? 'pipe' : 'ignore', captureOutput ? 'pipe' : 'ignore']
      : ['ignore', captureOutput ? 'pipe' : 'ignore', captureOutput ? 'pipe' : 'ignore'],
    ...(input !== undefined ? { input } : {}),
    maxBuffer: AGENT_MAX_BUFFER,
    timeout: 45 * 60 * 1000,
    env: { ...process.env, HOME: '/home/poly' },
  });

  if (result.error) throw new Error(`[${label}] spawn error: ${result.error.message}`);
  if (result.status !== 0) throw new Error(formatAgentFailure(label, result));

  const out = captureOutput ? (result.stdout || '').trim() : '';
  log(`✓ [${label}] done (${out.length} chars output)`);
  return out;
}

async function runGemini(label, args, cwd) {
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

  log(`All Gemini models exhausted. Will retry on next timer tick.`);
  process.exit(0); 
}

async function ntfyPost(body, title, priority = 'default') {
  const headerSafeTitle = title.replace(/[\u2012-\u2015]/g, '-').replace(/[^\x20-\x7E]/g, '?');
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(NTFY_URL, {
        method: 'POST',
        headers: { 'Title': headerSafeTitle, 'Priority': priority, 'Tags': 'robot', 'User-Agent': 'polymer-bot' },
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

async function waitForApproval(since) {
  const url = `${NTFY_URL}/json?since=${since}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), APPROVAL_TIMEOUT_MS);
  let buffer = '';

  log('Waiting for approval on ntfy...');

  let reader;
  try {
    const response = await fetch(url, { signal: controller.signal });
    reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === 'keepalive') continue;
          const msg = (event.message || '').trim().toLowerCase();
          if (msg === 'merge' || msg === 'go') {
            await reader.cancel().catch(() => {});
            controller.abort();
            return 'merge';
          }
          if (msg === 'iterate' || msg === 'no' || msg === 'cancel') {
            await reader.cancel().catch(() => {});
            controller.abort();
            return 'iterate';
          }
          if (msg === 'stop') {
            await reader.cancel().catch(() => {});
            controller.abort();
            return 'stop';
          }
        } catch {}
      }
    }
    await reader.cancel().catch(() => {});
  } catch (err) {
    if (reader) await reader.cancel().catch(() => {});
    if (err.name === 'AbortError') return 'timeout';
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  return 'timeout';
}

// ─── Core ─────────────────────────────────────────────────────────────────────

async function run() {
  if (existsSync(LOCKFILE)) {
    const pid = readFileSync(LOCKFILE, 'utf8').trim();
    try {
      exec(`kill -0 ${pid}`);
      log(`Another instance (PID ${pid}) is running. Exiting.`);
      process.exit(0);
    } catch {
      log('Stale lockfile found. Removing.');
      unlinkSync(LOCKFILE);
    }
  }
  writeFileSync(LOCKFILE, String(process.pid));

  try {
    await pipeline();
  } finally {
    try { unlinkSync(LOCKFILE); } catch {}
  }
}

async function pipeline() {
  const openPRs = JSON.parse(exec(`gh pr list --repo ${GITHUB_REPO} --state open --json number,headRefName,body`));
  const botPRs = openPRs.filter(pr => pr.headRefName.startsWith('bot/'));
  
  let branch;
  let resumePR = null;
  let manualIssueNumbers = [];

  if (botPRs.length > 0) {
    resumePR = botPRs[0];
    branch = resumePR.headRefName;
    log(`Resuming existing bot PR #${resumePR.number} (${branch}).`);
    
    const match = resumePR.body.match(/Automated PR resolving: (#[0-9, #]+)/);
    if (match) {
      manualIssueNumbers = match[1].split(/[, ]+/).map(s => s.replace('#', '').trim()).filter(Boolean);
    }
  }

  let issues = [];
  if (manualIssueNumbers.length > 0) {
    for (const num of manualIssueNumbers) {
      try {
        issues.push(JSON.parse(exec(`gh issue view ${num} --repo ${GITHUB_REPO} --json number,title,body,labels,comments`)));
      } catch (e) {
        log(`Failed to fetch resumed issue #${num}: ${e.message}`);
      }
    }
  }

  if (issues.length === 0) {
    const issueStubs = JSON.parse(exec(`gh issue list --repo ${GITHUB_REPO} --state open --label auto --json number,title --limit 20`));
    issues = issueStubs.map(issue => JSON.parse(exec(`gh issue view ${issue.number} --repo ${GITHUB_REPO} --json number,title,body,labels,comments`)));
  }

  if (issues.length === 0) {
    log('No open issues. Exiting.');
    process.exit(0);
  }
  log(`Processing ${issues.length} issue(s): ${issues.map(i => '#' + i.number).join(', ')}`);

  if (!existsSync(BOT_REPO)) {
    const msg = `Bot repo not found at ${BOT_REPO}.`;
    await ntfyPost(msg, 'Polymer Bot — Setup Required', 'urgent');
    process.exit(1);
  }

  exec(`git -C ${BOT_REPO} fetch origin`);
  
  if (resumePR) {
    exec(`git -C ${BOT_REPO} checkout ${branch}`);
    exec(`git -C ${BOT_REPO} reset --hard origin/${branch}`);
  } else {
    exec(`git -C ${BOT_REPO} checkout main`);
    exec(`git -C ${BOT_REPO} reset --hard origin/main`);
    exec(`git -C ${BOT_REPO} clean -fd`);
  }
  
  log('Installing dependencies in bot repo...');
  exec(`pnpm -C ${BOT_REPO} install --no-frozen-lockfile`);

  if (!resumePR) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    branch = `bot/issues-${stamp}`;
    exec(`git -C ${BOT_REPO} checkout -b ${branch}`);
  }

  const stampForImages = branch.replace('bot/issues-', '');
  const enrichedIssues = await enrichIssuesWithImages(issues, stampForImages);
  const issueImageArgs = getIssueImageArgs(enrichedIssues);

  const issueText = enrichedIssues.map(i => {
    const labels = i.labels?.map(l => l.name).join(', ');
    const discussion = buildIssueDiscussion(i);
    return [`### Issue #${i.number}: ${i.title}`, labels ? `Labels: ${labels}` : null, '', discussion].filter(v => v !== null).join('\n');
  }).join('\n\n---\n\n');

  const codebaseCtx = [
    'Codebase: The Polytechnic student newspaper website (thepoly/polymer).',
    'Stack: Next.js 16, Payload CMS 3, PostgreSQL, TypeScript, Tailwind v4, pnpm.',
    `Repo path: ${BOT_REPO}`,
    'Git identity configured — commits as Ronan Hevenor. No AI attribution.',
    'Be precise — match existing production patterns.',
  ].join('\n');

  const issueRefs = enrichedIssues.map(i => `#${i.number}`).join(', ');
  const issueList  = enrichedIssues.map(i => `• #${i.number}: ${i.title}`).join('\n');
  const visualContext = buildVisualContextBlock(enrichedIssues);

  // ── 1: Plan 
  const planPrompt = `${codebaseCtx}\nAnalyze these issues and produce a thorough, step-by-step implementation plan.\n\n## Visual Context\n${visualContext}\n\n${issueText}`;
  const plan = await runGemini('Gemini:plan', [...issueImageArgs, '-p', planPrompt, '-y', '--output-format', 'text'], BOT_REPO);

  // ── 2: Implement (Skip if resuming)
  if (!resumePR) {
    const implPrompt = `${codebaseCtx}\nImplement the plan. Edit necessary files. Edits only.\n\n## Issues\n${issueText}\n\n## Plan\n${plan}`;
    await runGemini('Gemini:impl', [...issueImageArgs, '-p', implPrompt, '--approval-mode', 'yolo', '--output-format', 'text'], BOT_REPO);
  }

  let cycleCount = 0;
  while (cycleCount < MAX_CYCLES) {
    cycleCount += 1;

    // ── 3: Evaluate
    const fullDiff      = exec(`git -C ${BOT_REPO} diff origin/main`, { allowFailure: true });
    const untracked     = exec(`git -C ${BOT_REPO} ls-files --others --exclude-standard`, { allowFailure: true });
    const diffSection   = fullDiff  ? `\`\`\`diff\n${fullDiff}\n\`\`\`` : '(no changes)';
    const newFiles      = untracked ? `\n## New Files\n${untracked}` : '';

    const evalPrompt = `${codebaseCtx}\nReview these changes. Identify bugs, regressions, or type errors.\n\n## Issues\n${issueText}\n\n## Plan\n${plan}\n\n## Changes\n${diffSection}${newFiles}`;
    const evaluation = await runGemini(`Gemini:eval:c${cycleCount}`, [...issueImageArgs, '-p', evalPrompt, '-y', '--output-format', 'text'], BOT_REPO);

    // ── 4: Fix
    const fixPrompt = `${codebaseCtx}\nFix issues Gemini identified.\n\n## Review\n${evaluation}\n\n## Changes\n${diffSection}\n\nInstructions:\n- If you modified package.json or collections, run \`pnpm install\` and \`pnpm generate:types\`.\n- BEFORE COMMITTING: run \`pnpm lint\` and \`pnpm typecheck\`.\n- Commit referencing ${issueRefs}. No push.`;
    await runGemini(`Gemini:fix:c${cycleCount}`, [...issueImageArgs, '-p', fixPrompt, '--approval-mode', 'yolo', '--output-format', 'text'], BOT_REPO);

    const commits = exec(`git -C ${BOT_REPO} log origin/main..HEAD --format="• %s"`, { allowFailure: true });
    if (!commits) break;

    exec(`git -C ${BOT_REPO} push -f -u origin ${branch}`);

    let prUrl;
    try { prUrl = exec(`gh pr view ${branch} --repo ${GITHUB_REPO} --json url -q .url`, { allowFailure: true }); } catch {}

    if (!prUrl) {
      const titlePrompt = `Write a PR title for these changes.\n\nIssues:\n${issueRefs}\n\nCommits:\n${commits}`;
      const prTitleRaw = await runGemini('Gemini:title', ['-p', titlePrompt, '-y', '--output-format', 'text'], BOT_REPO);
      const prTitle = prTitleRaw.split('\n')[0].trim().slice(0, 72);
      const prBodyFile = `/tmp/polymer-bot-pr-body-${Date.now()}.txt`;
      writeFileSync(prBodyFile, `Automated PR resolving: ${issueRefs}\n\n## Gemini Review\n${evaluation}`);
      try { prUrl = exec(`gh pr create --repo ${GITHUB_REPO} --title ${JSON.stringify(prTitle)} --body-file ${prBodyFile} --head ${branch} --base main`); } finally { try { unlinkSync(prBodyFile); } catch {} }
    }

    const proposal = [`${enrichedIssues.length} issue(s) resolved. Cycle ${cycleCount} complete.`, `PR: ${prUrl}`, '', 'Reply:', '• "merge" to deploy', '• "iterate" to review again', '• "stop" to shutdown timer'].join('\n');
    const since = Math.floor(Date.now() / 1000);
    await ntfyPost(proposal, `Polymer Bot — Approval (C${cycleCount})`, 'high');

    const decision = await waitForApproval(since);
    if (decision === 'merge') {
      exec(`gh pr merge ${prUrl} --squash --delete-branch --admin --repo ${GITHUB_REPO}`);
      await ntfyPost(`Merged!`, 'Polymer Bot — Deployed', 'high');
      break;
    } else if (decision === 'iterate') {
      continue;
    } else if (decision === 'stop') {
      exec('systemctl --user stop polymer-bot.timer');
      await ntfyPost('Stopped.', 'Polymer Bot — Stopped');
      break;
    } else {
      break;
    }
  }

  try { if (existsSync(`${ISSUE_IMAGE_ROOT}/${stampForImages}`)) rmSync(`${ISSUE_IMAGE_ROOT}/${stampForImages}`, { recursive: true, force: true }); } catch {}
}

const __dirname = new URL('.', import.meta.url).pathname;
mkdirSync('/home/poly/.gemini', { recursive: true });
run().catch(async err => {
  log(`Fatal: ${err.message}`);
  try { await ntfyPost(err.message.slice(0, 500), 'Polymer Bot - Crash', 'urgent'); } catch {}
  try { unlinkSync(LOCKFILE); } catch {}
  process.exit(1);
});
