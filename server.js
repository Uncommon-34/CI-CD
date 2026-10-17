const http = require('http');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO_URL = process.env.REPO_URL;
const BRANCH = process.env.BRANCH || 'main';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || '9000', 10);
const WORKSPACE = '/workspace/repo';

let appProcess = null;
let lastCommitSha = null;
let lastDeployTime = null;
let deployStatus = 'idle'; // idle, deploying, failed
let deployInProgress = false;
let pendingDeploy = false;

const log = (prefix, msg) => {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} [${prefix}] ${msg}`);
};

const scrubToken = (str) => {
  if (!GITHUB_TOKEN) return str;
  return str.replace(new RegExp(GITHUB_TOKEN, 'g'), '***REDACTED***');
};

const verifySignature = (body, signature) => {
  if (!signature || !WEBHOOK_SECRET) return false;

  const [algorithm, hash] = signature.split('=');
  if (algorithm !== 'sha256') return false;

  const computed = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(computed));
};

const stopApp = async () => {
  return new Promise((resolve) => {
    if (!appProcess || appProcess.killed) {
      resolve();
      return;
    }

    log('app', `Stopping PID ${appProcess.pid} with SIGTERM`);
    appProcess.kill('SIGTERM');

    const timeout = setTimeout(() => {
      if (!appProcess.killed) {
        log('app', `SIGTERM timeout, sending SIGKILL to PID ${appProcess.pid}`);
        appProcess.kill('SIGKILL');
      }
      resolve();
    }, 10000);

    appProcess.on('exit', () => {
      clearTimeout(timeout);
      appProcess = null;
      resolve();
    });
  });
};

const startApp = () => {
  log('app', 'Starting app with npm run start');
  appProcess = spawn('npm', ['run', 'start'], {
    cwd: WORKSPACE,
    stdio: 'inherit',
    shell: true,
  });

  appProcess.on('error', (err) => {
    log('app', `Error starting app: ${err.message}`);
  });

  appProcess.on('exit', (code, signal) => {
    if (!appProcess.killed) {
      log('app', `App exited with code ${code}, signal ${signal}`);
      appProcess = null;
      if (deployStatus !== 'deploying') {
        log('app', 'Restarting in 5 seconds...');
        setTimeout(startApp, 5000);
      }
    }
  });
};

const runCommand = (cmd, args, cwd) => {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${cmd} failed: ${scrubToken(stderr || stdout)}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run ${cmd}: ${err.message}`));
    });
  });
};

const deployRepo = async () => {
  if (deployInProgress) {
    log('deploy', 'Deploy already in progress, queuing follow-up');
    pendingDeploy = true;
    return;
  }

  deployInProgress = true;
  pendingDeploy = false;
  deployStatus = 'deploying';
  log('deploy', 'Starting deploy');

  try {
    // Fetch and reset to latest commit
    log('deploy', `Fetching from origin ${BRANCH}`);
    await runCommand('git', ['fetch', 'origin', BRANCH], WORKSPACE);
    await runCommand('git', ['reset', '--hard', `origin/${BRANCH}`], WORKSPACE);

    // Get commit SHA
    const shaOutput = await runCommand('git', ['rev-parse', 'HEAD'], WORKSPACE);
    lastCommitSha = shaOutput.trim();
    log('deploy', `Checked out commit ${lastCommitSha}`);

    // Check for lockfile
    const lockfilePath = path.join(WORKSPACE, 'package-lock.json');
    const hasLockfile = fs.existsSync(lockfilePath);

    if (hasLockfile) {
      log('deploy', 'Running npm ci');
      await runCommand('npm', ['ci'], WORKSPACE);
    } else {
      log('deploy', 'No lockfile found, running npm install');
      await runCommand('npm', ['install'], WORKSPACE);
    }

    log('deploy', 'Running npm run build');
    await runCommand('npm', ['run', 'build'], WORKSPACE);

    log('deploy', 'Build succeeded, restarting app');
    await stopApp();
    lastDeployTime = new Date().toISOString();
    deployStatus = 'idle';
    startApp();

    if (pendingDeploy) {
      log('deploy', 'Deploying queued follow-up');
      deployInProgress = false;
      setTimeout(deployRepo, 1000);
    } else {
      deployInProgress = false;
    }
  } catch (err) {
    log('deploy', `Build failed: ${err.message}`);
    deployStatus = 'failed';
    deployInProgress = false;

    if (pendingDeploy) {
      log('deploy', 'Retrying queued follow-up after failure');
      setTimeout(deployRepo, 5000);
    }
  }
};

const webhookHandler = (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const health = {
      status: deployStatus,
      commitSha: lastCommitSha,
      lastDeployTime: lastDeployTime,
      uptime: process.uptime(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health, null, 2));
    return;
  }

  if (req.url === '/webhook' && req.method === 'POST') {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', async () => {
      const signature = req.headers['x-hub-signature-256'];

      if (!verifySignature(body, signature)) {
        log('webhook', 'Invalid or missing signature');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch (err) {
        log('webhook', `Invalid JSON: ${err.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      // Handle ping
      if (payload.action === 'ping' || req.headers['x-github-event'] === 'ping') {
        log('webhook', 'Received ping event');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Handle push events
      if (req.headers['x-github-event'] === 'push') {
        const refBranch = payload.ref?.replace('refs/heads/', '');
        if (refBranch !== BRANCH) {
          log('webhook', `Ignoring push to branch ${refBranch} (configured: ${BRANCH})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        log('webhook', `Received push to ${BRANCH}`);

        // Respond immediately
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ queued: true }));

        // Deploy asynchronously
        deployRepo();
        return;
      }

      // Ignore other events
      log('webhook', `Ignoring event type ${req.headers['x-github-event']}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
};

const initializeRepo = async () => {
  log('init', `Initializing with repo ${REPO_URL}`);

  try {
    if (!fs.existsSync(WORKSPACE)) {
      log('init', `Cloning repo to ${WORKSPACE}`);
      let cloneUrl = REPO_URL;

      if (GITHUB_TOKEN) {
        cloneUrl = REPO_URL.replace('https://', `https://${GITHUB_TOKEN}@`);
      }

      await runCommand('git', ['clone', '--branch', BRANCH, cloneUrl, WORKSPACE], '/');
    } else {
      log('init', 'Repository already exists, fetching updates');
      await runCommand('git', ['fetch', 'origin', BRANCH], WORKSPACE);
      await runCommand('git', ['reset', '--hard', `origin/${BRANCH}`], WORKSPACE);
    }

    const shaOutput = await runCommand('git', ['rev-parse', 'HEAD'], WORKSPACE);
    lastCommitSha = shaOutput.trim();
    log('init', `Repository at commit ${lastCommitSha}`);

    log('init', 'Running initial npm ci/install');
    const lockfilePath = path.join(WORKSPACE, 'package-lock.json');
    if (fs.existsSync(lockfilePath)) {
      await runCommand('npm', ['ci'], WORKSPACE);
    } else {
      await runCommand('npm', ['install'], WORKSPACE);
    }

    log('init', 'Running initial npm run build');
    await runCommand('npm', ['run', 'build'], WORKSPACE);

    log('init', 'Starting app');
    lastDeployTime = new Date().toISOString();
    startApp();

    log('init', 'Starting webhook server on port ' + WEBHOOK_PORT);
    const server = http.createServer(webhookHandler);
    server.listen(WEBHOOK_PORT, () => {
      log('webhook', `Server listening on port ${WEBHOOK_PORT}`);
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      log('shutdown', 'SIGTERM received, shutting down gracefully');
      await stopApp();
      server.close();
      process.exit(0);
    });
  } catch (err) {
    log('init', `Initialization failed: ${err.message}`);
    process.exit(1);
  }
};

if (!REPO_URL) {
  log('init', 'Error: REPO_URL environment variable is required');
  process.exit(1);
}

if (!WEBHOOK_SECRET) {
  log('init', 'Error: WEBHOOK_SECRET environment variable is required');
  process.exit(1);
}

initializeRepo();
