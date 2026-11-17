// Entry point for the github-core-clone-01 forge.
//
// The grader starts this file as `node /bot/main.ts` (Node 22, type stripping).
// It binds an ephemeral port, registers it with the suite environment, and
// stays alive until the environment reports the trial is done.
import { createForgeServer } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envUrl === '') {
  console.error('MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return;
      lastError = new Error(`register answered HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw lastError instanceof Error ? lastError : new Error('register failed');
}

async function waitUntilDone(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, { method: 'GET' });
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch {
      // The environment may not be ready yet; keep polling.
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const server = createForgeServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 0) {
    console.error('failed to bind a port');
    process.exit(1);
  }
  await register(port);
  await waitUntilDone();
  server.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
