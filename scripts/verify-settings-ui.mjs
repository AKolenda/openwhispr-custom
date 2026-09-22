import WebSocket from "ws";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const port = Number(process.argv[2] || 9431);
const preserveState = process.argv.includes("--preserve-state");
const outputArg = process.argv.find((argument) => argument.startsWith("--output-dir="));
const outputDirectory = outputArg ? path.resolve(outputArg.slice("--output-dir=".length)) : null;
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
  response.json()
);
const panel = targets.find((target) => target.type === "page" && target.url.includes("panel=true"));
if (!panel) throw new Error("The Electron control-panel renderer is not available.");

const socket = new WebSocket(panel.webSocketDebuggerUrl);
const pending = new Map();
const exceptions = [];
let nextId = 1;

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    const details = message.params.exceptionDetails;
    exceptions.push(
      details.exception?.description ||
        `${details.text} at ${details.url || "unknown"}:${details.lineNumber ?? "?"}`
    );
  }
});

await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

function send(method, params = {}, timeoutMs = 15000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for the renderer command ${method}.`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description || response.exceptionDetails.text
    );
  }
  return response.result.value;
}

async function waitFor(expression, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function requireText(text, expected, view) {
  for (const label of expected) {
    if (!text.includes(label)) throw new Error(`${view} is missing "${label}".`);
  }
}

async function captureScreenshot(name) {
  if (!outputDirectory) return;
  await mkdir(outputDirectory, { recursive: true });
  const result = await send(
    "Page.captureScreenshot",
    {
      format: "png",
      captureBeyondViewport: false,
    },
    60000
  );
  await writeFile(path.join(outputDirectory, name), result.data, "base64");
}

try {
  await send("Runtime.enable");
  await send("Page.enable");

  if (preserveState) {
    await evaluate(`(() => {
    localStorage.setItem("onboardingCompleted", "true");
    localStorage.setItem("authenticationSkipped", "true");
    localStorage.setItem("skipAuth", "true");
    location.reload();
    return true;
  })()`);
  } else {
    await evaluate(`(() => {
    const values = {
      onboardingCompleted: "true",
      authenticationSkipped: "true",
      skipAuth: "true",
      useLocalWhisper: "false",
      transcriptionMode: "providers",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "gemini",
      cloudTranscriptionModel: "gemini-3.5-transcribe",
      useCleanupModel: "true",
      cleanupMode: "providers",
      cleanupProvider: "openrouter",
      cleanupModel: "openai/gpt-4o-mini",
      reasoningMode: "providers",
      reasoningProvider: "openrouter",
      reasoningModel: "openai/gpt-4o-mini"
    };
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    location.reload();
    return true;
  })()`);
  }

  if (preserveState) {
    const state = await evaluate(`(async () => {
      const keys = [
        "transcriptionMode", "cloudTranscriptionMode", "useLocalWhisper",
        "cloudTranscriptionProvider", "_providerSettingsMigrated",
        "cleanupMode", "cleanupProvider", "cleanupModel",
        "reasoningMode", "reasoningProvider", "reasoningModel", "_llmScopeKeysMigrated",
        "transcriptionModelByProvider", "reasoningModelByProvider"
      ];
      const [geminiKey, openrouterKey] = await Promise.all([
        window.electronAPI?.getGeminiKey?.(),
        window.electronAPI?.getOpenrouterKey?.()
      ]);
      return {
        ...Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])),
        hasGeminiKey: Boolean(geminiKey),
        hasOpenrouterKey: Boolean(openrouterKey)
      };
    })()`);
    console.log(`PROFILE_STATE: ${JSON.stringify(state)}`);
  }

  await waitFor(`document.querySelector('[aria-label="Settings"]') !== null`, "the control panel");
  await evaluate(`document.querySelector('[aria-label="Settings"]').click()`);
  await waitFor(
    `[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Speech-to-Text')`,
    "the Settings dialog"
  );

  await evaluate(
    `[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Speech-to-Text').click()`
  );
  await waitFor(`document.body.innerText.includes('Cloud Providers')`, "Speech-to-Text settings");
  const speechText = await evaluate(`document.body.innerText`);
  await captureScreenshot("speech-to-text-settings.png");
  requireText(
    speechText,
    ["Cloud Providers", "OpenAI", "Groq", "Gemini", "API Key", "Model", "Gemini 3.5 Transcribe"],
    "Speech-to-Text"
  );

  await evaluate(
    `[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Language Models').click()`
  );
  await waitFor(
    `document.body.innerText.includes('Dictation Cleanup')`,
    "Language Models settings"
  );
  const cleanupText = await evaluate(`document.body.innerText`);
  requireText(
    cleanupText,
    ["Dictation Cleanup", "Cloud Providers", "OpenRouter", "API Key", "Available Models"],
    "Dictation Cleanup"
  );
  await captureScreenshot("dictation-cleanup-settings.png");

  if (exceptions.length) {
    throw new Error(`Renderer exceptions: ${exceptions.join(" | ")}`);
  }

  console.log("PASS: Speech-to-Text provider, API-key, and model controls are rendered.");
  console.log("PASS: Dictation Cleanup provider, API-key, and model controls are rendered.");
} finally {
  socket.close();
}
