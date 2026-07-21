import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const root = process.cwd();
const scenariosDir = path.join(root, 'demo', 'scenarios');
const outputRoot = path.join(root, 'demo-output');

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function listScenarios() {
  const files = (await fs.readdir(scenariosDir)).filter((name) => name.endsWith('.json'));
  for (const file of files) console.log(path.basename(file, '.json'));
}

async function readScenario(name) {
  const file = path.join(scenariosDir, `${name}.json`);
  const raw = await fs.readFile(file, 'utf8');
  const scenario = JSON.parse(raw);
  scenario.__file = file;
  return scenario;
}

async function waitForStableFrame(page, milliseconds = 350) {
  await page.waitForTimeout(milliseconds);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function runStep(page, step) {
  const holdAfter = step.holdAfter ?? 500;

  switch (step.action) {
    case 'goto':
      await page.goto(step.url, { waitUntil: step.waitUntil ?? 'networkidle' });
      break;
    case 'click':
      await page.locator(step.selector).click({ timeout: step.timeout ?? 10_000 });
      break;
    case 'fill':
      await page.locator(step.selector).fill(step.value, { timeout: step.timeout ?? 10_000 });
      break;
    case 'press':
      await page.locator(step.selector ?? 'body').press(step.key);
      break;
    case 'waitFor':
      await page.locator(step.selector).waitFor({ state: step.state ?? 'visible', timeout: step.timeout ?? 10_000 });
      break;
    case 'pause':
      await page.waitForTimeout(step.duration ?? 1000);
      return;
    case 'evaluate':
      await page.evaluate(step.script);
      break;
    case 'screenshot':
      await page.screenshot({ path: step.path, fullPage: Boolean(step.fullPage) });
      break;
    default:
      throw new Error(`Unsupported demo action: ${step.action}`);
  }

  await waitForStableFrame(page, holdAfter);
}

async function main() {
  if (process.argv.includes('--list')) {
    await listScenarios();
    return;
  }

  const scenarioName = argValue('--scenario') ?? process.argv[2] ?? 'smoke-home';
  const scenario = await readScenario(scenarioName);
  const baseUrl = process.env.DEMO_BASE_URL ?? scenario.baseUrl ?? 'http://127.0.0.1:5173';
  const runId = `${scenarioName}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDir = path.join(outputRoot, runId);
  const videoDir = path.join(outputDir, 'video');
  await fs.mkdir(videoDir, { recursive: true });

  const browser = await chromium.launch({ headless: scenario.headless ?? true });
  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport: scenario.viewport ?? { width: 390, height: 844 },
    deviceScaleFactor: scenario.deviceScaleFactor ?? 1,
    locale: scenario.locale ?? 'en-NZ',
    timezoneId: scenario.timezoneId ?? 'Pacific/Auckland',
    colorScheme: scenario.colorScheme ?? 'light',
    reducedMotion: scenario.reducedMotion ?? 'no-preference',
    recordVideo: {
      dir: videoDir,
      size: scenario.videoSize ?? scenario.viewport ?? { width: 390, height: 844 }
    }
  });

  if (scenario.storageState) {
    await context.addInitScript((state) => {
      for (const [key, value] of Object.entries(state.localStorage ?? {})) {
        localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }, scenario.storageState);
  }

  const page = await context.newPage();
  const failures = [];
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));

  try {
    for (const step of scenario.steps) {
      const resolved = {
        ...step,
        url: step.url?.replace('{{baseUrl}}', baseUrl),
        path: step.path ? path.join(outputDir, step.path) : undefined
      };
      await runStep(page, resolved);
    }

    await page.screenshot({ path: path.join(outputDir, 'final-frame.png'), fullPage: false });
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  const report = {
    scenario: scenarioName,
    source: scenario.__file,
    baseUrl,
    outputDir,
    completedAt: new Date().toISOString(),
    failures
  };
  await fs.writeFile(path.join(outputDir, 'run-report.json'), JSON.stringify(report, null, 2));

  if (failures.length) {
    console.warn(`Capture completed with ${failures.length} browser error(s). See run-report.json.`);
  }
  console.log(outputDir);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
