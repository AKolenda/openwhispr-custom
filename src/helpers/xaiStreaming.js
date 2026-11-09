const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

// xAI's streaming transcription. 16 kHz 16-bit PCM goes up while the user
// speaks and the server settles the text every few seconds of speech, so on
// stop only the last stretch is left to transcribe: 0.1-0.17 s from the end of
// the audio to the text, against 0.3-0.9 s for the batch upload of the same
// clip (measured for the Recorder app, which uses the same protocol).
const STT_URL = "wss://api.x.ai/v1/stt";
const SAMPLE_RATE = 16000;
const CONNECT_TIMEOUT_MS = 10000;
// After audio.done the server answers within a few hundred ms. Past this, the
// batch upload of the fallback recording is the faster way to the text.
const FINISH_TIMEOUT_MS = 2500;
const PING_INTERVAL_MS = 10000;
// Audio held while the socket opens: 60 s of 16 kHz 16-bit mono.
const MAX_HELD_BYTES = SAMPLE_RATE * 2 * 60;
const MAX_KEYTERMS = 100;
const MAX_KEYTERM_CHARS = 50;
const AUDIO_DONE = JSON.stringify({ type: "audio.done" });

/**
 * The text of a stream so far. A `speech_final` event carries a whole
 * utterance; the `is_final` chunks before it are pieces of the same utterance
 * and give way to it. Chunks with no utterance after them yet are kept, so the
 * text is whole even if the stream ends before the last utterance arrives. An
 * event that isn't final is the server's current guess at what follows.
 */
class LiveText {
  constructor() {
    this.utterances = [];
    this.chunks = [];
    this.guess = "";
  }

  /** Returns "utterance" when an utterance settled, "partial" otherwise. */
  add(event) {
    const said = typeof event.text === "string" ? event.text.trim() : "";
    if (event.is_final !== true) {
      this.guess = said;
      return "partial";
    }
    this.guess = "";
    if (event.speech_final === true) {
      this.chunks = [];
      if (said) this.utterances.push(said);
      return "utterance";
    }
    if (said) this.chunks.push(said);
    return "partial";
  }

  settled() {
    return this.utterances.join(" ");
  }

  /** The words after the settled utterances, guess included: for showing, not inserting. */
  pending() {
    return [...this.chunks, ...(this.guess ? [this.guess] : [])].join(" ");
  }

  text() {
    return [...this.utterances, ...this.chunks].join(" ");
  }
}

class XaiStreaming {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.ready = false;
    this.ended = false;
    this.held = [];
    this.heldBytes = 0;
    this.text = new LiveText();
    this.audioBytesSent = 0;
    this.finishWaiters = [];
    this.done = false;
    this.failed = null;
    this.pingTimer = null;
    this.connectTimer = null;
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
  }

  static buildUrl({ language, keyterms } = {}) {
    const params = new URLSearchParams({ encoding: "pcm", sample_rate: String(SAMPLE_RATE) });
    if (language) {
      params.set("language", language);
      params.set("format", "true");
    }
    for (const term of (keyterms || [])
      .filter((t) => typeof t === "string" && t && t.length <= MAX_KEYTERM_CHARS)
      .slice(0, MAX_KEYTERMS)) {
      params.append("keyterm", term);
    }
    return `${STT_URL}?${params.toString()}`;
  }

  /**
   * Opens the session and returns at once: audio sent before the server is
   * ready is held and goes up as soon as it is, so the mic never waits on the
   * handshake. Failures arrive through onError.
   */
  connect({ apiKey, language, keyterms }) {
    if (!apiKey) throw new Error("No xAI API key configured. Add your key in Settings.");
    this.reset();
    const ws = new WebSocket(XaiStreaming.buildUrl({ language, keyterms }), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    this.ws = ws;
    this.isConnected = true;

    this.connectTimer = setTimeout(() => {
      if (!this.ready) this.fail(new Error("xAI streaming did not start in time"));
    }, CONNECT_TIMEOUT_MS);

    ws.on("unexpected-response", (_req, res) => {
      const status = res?.statusCode;
      this.fail(
        new Error(
          status === 401 || status === 403
            ? `xAI ${status}: check the API key`
            : `xAI streaming refused the connection (${status})`
        )
      );
    });
    ws.on("message", (data) => this.handleMessage(ws, data));
    ws.on("error", (error) => this.fail(error));
    ws.on("close", (code) => {
      // The server drops the socket after transcript.done, which has completed
      // the text by then. An end before it may have lost the last utterance.
      if (!this.done) this.fail(new Error(`xAI streaming ended early (code: ${code})`));
    });
  }

  handleMessage(ws, data) {
    if (ws !== this.ws) return;
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (event.type) {
      case "transcript.created":
        this.onReady();
        break;
      case "transcript.partial": {
        const kind = this.text.add(event);
        if (kind === "utterance") this.onFinalTranscript?.(this.text.settled());
        const pending = this.text.pending();
        if (pending || kind === "utterance") this.onPartialTranscript?.(pending);
        break;
      }
      case "transcript.done":
        this.complete();
        break;
      case "error":
        this.fail(new Error(`xAI: ${event.message || "streaming failed"}`));
        break;
      default:
        break;
    }
  }

  onReady() {
    if (this.ready || !this.ws) return;
    this.ready = true;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (this.heldBytes > 0) this.sendNow(Buffer.concat(this.held, this.heldBytes));
    this.held = [];
    this.heldBytes = 0;
    if (this.ended) this.ws.send(AUDIO_DONE);
    // A ping lets a dead socket show itself while the user is still speaking.
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
    }, PING_INTERVAL_MS);
    debugLogger.debug("xAI streaming session ready", {}, "streaming");
  }

  sendAudio(pcm) {
    if (!this.ws || this.ended || this.done || this.failed) return false;
    if (!this.ready) {
      if (this.heldBytes + pcm.length <= MAX_HELD_BYTES) {
        this.held.push(pcm);
        this.heldBytes += pcm.length;
      }
      return true;
    }
    this.sendNow(pcm);
    return true;
  }

  sendNow(pcm) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(pcm);
    this.audioBytesSent += pcm.length;
  }

  /**
   * No more audio: the server transcribes what is left and answers. Resolves
   * with the whole text once it has, or with what had settled when the stream
   * failed or took longer than FINISH_TIMEOUT_MS.
   */
  finish() {
    if (!this.ws) return Promise.resolve(this.result());
    if (!this.ended) {
      this.ended = true;
      if (this.ready && this.ws.readyState === WebSocket.OPEN) this.ws.send(AUDIO_DONE);
    }
    if (this.done || this.failed) return Promise.resolve(this.result());
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        debugLogger.debug("xAI streaming finish timed out", {}, "streaming");
        this.finishWaiters = this.finishWaiters.filter((w) => w !== waiter);
        resolve(this.result());
      }, FINISH_TIMEOUT_MS);
      const waiter = () => {
        clearTimeout(timer);
        resolve(this.result());
      };
      this.finishWaiters.push(waiter);
    });
  }

  result() {
    return {
      text: this.done ? this.text.text() : this.text.settled(),
      complete: this.done,
      model: "grok-stt",
      audioBytesSent: this.audioBytesSent,
      error: this.failed?.message,
    };
  }

  complete() {
    if (this.done) return;
    this.done = true;
    const text = this.text.text();
    this.onFinalTranscript?.(text);
    this.onSessionEnd?.({ text });
    this.settleWaiters();
    // Nothing more comes after transcript.done.
    this.closeSocket();
  }

  fail(error) {
    if (this.done || this.failed) return;
    this.failed = error;
    debugLogger.debug("xAI streaming failed", { error: error.message }, "streaming");
    // Once audio has ended a failure only means the stop falls back to what
    // settled (or to the batch upload); during speech the user must hear of it.
    if (!this.ended) this.onError?.(error);
    this.settleWaiters();
    this.closeSocket();
  }

  settleWaiters() {
    const waiters = this.finishWaiters;
    this.finishWaiters = [];
    waiters.forEach((w) => w());
  }

  closeSocket() {
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.isConnected = false;
    if (ws) {
      ws.removeAllListeners("close");
      ws.on("error", () => {});
      try {
        ws.terminate();
      } catch {
        // Ignore
      }
    }
  }

  reset() {
    this.closeSocket();
    this.ready = false;
    this.ended = false;
    this.held = [];
    this.heldBytes = 0;
    this.text = new LiveText();
    this.audioBytesSent = 0;
    this.finishWaiters = [];
    this.done = false;
    this.failed = null;
  }

  /** Drops the session. Returns what had settled. */
  disconnect() {
    const result = this.result();
    this.settleWaiters();
    this.closeSocket();
    return result;
  }

  getStatus() {
    return { isConnected: this.isConnected, ready: this.ready, hasWarmConnection: false };
  }
}

module.exports = XaiStreaming;
module.exports.LiveText = LiveText;
