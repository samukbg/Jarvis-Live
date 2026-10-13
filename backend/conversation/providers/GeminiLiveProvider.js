import { Modality } from '@google/genai';
import { PHONE_ACTION_PROMPT, PHONE_ACTION_TOOL } from '../../device/phoneActions.js';
import { BUSINESS_PROMPT, BUSINESS_TOOL } from '../../business/card.js';
import { SHOW_CARD_PROMPT, SHOW_CARD_TOOL, showCard } from '../../cards/showCard.js';
import { TranscriptBuffer } from '../transcript.js';
import { acknowledgement } from '../acknowledge.js';

const AGENT_LABELS = { agy: 'Antigravity', gemini: 'Antigravity', claude: 'Claude', hermes: 'Hermes', codex: 'Codex' };
// How long Gemini gets to speak its own acknowledgement before Jarvis writes one.
export const ACK_GRACE_MS = 2500;

/** The Live session's rules: search answers itself, computer tasks go to the agent — said out loud first. */
export function liveInstruction(agent) {
  const tool = `delegate_to_${agent}`;
  const name = AGENT_LABELS[agent] || agent.toUpperCase();
  return `You are Jarvis, a concise and helpful AI assistant. Respond naturally and briefly, in the language the user speaks.

Questions a web search can answer (weather, news, events, opening hours, prices, sports, facts, places): use Google Search and answer yourself, right away. Do not delegate them.

Tasks that need the user's computer (open or control apps such as Spotify, files, folders, scripts, downloads, coding, creating apps, browsing websites, long multi-step research): never say you cannot do it — call the \`${tool}\` tool. It runs in the background on the user's computer with the ${name} agent.
ALWAYS speak first: as you call it, tell the user in one short sentence, in their language, that you are on it (e.g. "I'm on it, I'm asking ${name}." / "Je m'en occupe, je demande à ${name}." / "Estou nisso, vou pedir ao ${name}."). Never stay silent and never say the task is done before its result comes back. When the result comes back, tell the user what it says, briefly and naturally.

${PHONE_ACTION_PROMPT}

${BUSINESS_PROMPT}

${SHOW_CARD_PROMPT}`;
}

/** Google Search (answers in ~2 s) plus the agent (non-blocking: Gemini keeps talking while it works). */
export function liveTools(agent) {
  return [
    { googleSearch: {} },
    {
      functionDeclarations: [{
        name: `delegate_to_${agent}`,
        description: `Runs a task on the user's computer with the ${AGENT_LABELS[agent] || agent.toUpperCase()} agent, in the background: apps, files, scripts, browsing, coding. Say a short acknowledgement as you call it; the result arrives later.`,
        behavior: 'NON_BLOCKING',
        parameters: {
          type: 'OBJECT',
          properties: { task: { type: 'STRING', description: 'The detailed task instruction to send to the agent' } },
          required: ['task'],
        },
      }, PHONE_ACTION_TOOL, BUSINESS_TOOL, SHOW_CARD_TOOL],
    },
  ];
}

export class GeminiLiveProvider {
  constructor(options) {
    this.createClient = options.createClient;
    this.broadcast = options.broadcast;
    this.broadcastAudioChunk = options.broadcastAudioChunk || (() => {});
    this.broadcastLog = options.broadcastLog;
    this.broadcastNotification = options.broadcastNotification;
    this.broadcastAgentStatus = options.broadcastAgentStatus;
    this.delegateToAgent = options.delegateToAgent;
    this.phoneBridge = options.phoneBridge;
    // Business Dashboard (business/service.js): show_business_dashboard opens the card.
    this.business = options.business || null;
    // show_card (cards/showCard.js): a live card from the answer's facts.
    this.showCard = options.showCard || showCard;
    this.speak = options.speak;
    
    this.session = null;
    this.connecting = false;
    this.geminiState = 'IDLE';
    // Live transcribes in fragments: one line per utterance, not one per fragment.
    this.userSpeech = new TranscriptBuffer();
    this.jarvisSpeech = new TranscriptBuffer();
    // Has Jarvis said anything since the user's last utterance? (else acknowledge a delegation)
    this.saidThisTurn = false;
    this.lastUserUtterance = '';
  }

  /** The user's utterance is over (Jarvis answers, calls a tool, or the turn ends): log it once. */
  flushUserSpeech() {
    const text = this.userSpeech.flush();
    if (!text) return;
    this.lastUserUtterance = text;
    this.saidThisTurn = false;
    this.broadcast({ type: 'voice_transcript', text, role: 'user', is_final: true });
  }

  /** Delegating without a word from Gemini first: Jarvis acknowledges in writing (it can't speak into this session). */
  acknowledgeIfSilent(agentId) {
    if (this.saidThisTurn) return;
    const ack = acknowledgement(agentId, this.lastUserUtterance);
    this.broadcastLog(`JARVIS: ${ack}`);
    this.broadcast({ type: 'voice_transcript', text: ack, role: 'assistant', is_final: true });
    this.saidThisTurn = true;
  }

  async connect(targetAgent = 'agy') {
    if (this.connecting) return;
    
    if (this.session) {
      if (this.targetAgent === targetAgent) return;
      
      // Target agent changed, disconnect first
      this.disconnect();
    }
    
    this.connecting = true;
    this.targetAgent = targetAgent;

    try {
      console.log('[GEMINI] Connecting to Live API...');
      this.broadcastLog('[GEMINI] Initializing Live Session...');
      
      const client = this.createClient();
      
      this.session = await client.live.connect({
        // gemini-3.1-flash-live-preview stopped answering audio on 2026-10-01 (1011 errors).
        model: process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-latest',
        config: {
          responseModalities: [Modality.AUDIO],
          // Native-audio models think before answering; a conversation doesn't need it
          // (first audio ~0.5-1 s sooner).
          thinkingConfig: { thinkingBudget: 0 },
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Kore',
              }
            }
          },
          systemInstruction: liveInstruction(this.targetAgent),
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          tools: liveTools(this.targetAgent),
        },
        callbacks: {
          onopen: () => {
            console.log('[GEMINI] Live connected');
            this.broadcastLog('[GEMINI] Live Session Active ●');
            this.broadcastNotification({ label: 'GEMINI LIVE', msg: 'Live voice session connected', kind: 'success' });
          },
          onmessage: async (message) => {
            const sc = message.serverContent;
            // What the user says, as it is recognised (the live caption), then once in full.
            if (sc?.inputTranscription?.text) {
              const text = this.userSpeech.add(sc.inputTranscription.text);
              if (text) this.broadcast({ type: 'voice_transcript', text, role: 'user', is_final: false });
            }
            if (sc?.inputTranscription?.finished) this.flushUserSpeech();
            if (sc?.modelTurn || sc?.outputTranscription || message.toolCall) this.flushUserSpeech();
            if (sc) {
              // Clear audio on interruptions
              if (sc.interrupted) {
                this.jarvisSpeech.flush(); // cut off: the next answer starts a new line
                this.broadcast({ type: 'gemini_live_interrupt' });
                return;
              }
              
              // Stream raw PCM audio to frontend
              if (sc.modelTurn?.parts) {
                if (this.geminiState !== 'THINKING' && this.broadcastAgentStatus) {
                  this.geminiState = 'THINKING';
                  this.broadcastAgentStatus(this.targetAgent, 'THINKING');
                }
                for (const part of sc.modelTurn.parts) {
                  if (part.inlineData?.data) {
                    this.saidThisTurn = true; // Jarvis is speaking
                    try {
                      const rawPcm = Buffer.from(part.inlineData.data, 'base64');
                      this.broadcastAudioChunk(rawPcm);
                    } catch (e) {}
                    this.broadcast({
                      type: 'tts_chunk',
                      content: part.inlineData.data,
                      isPcm: true,
                      format: 'pcm'
                    });
                  }
                }
              }
              
              // Show Gemini's spoken transcript in the UI
              if (sc.outputTranscription?.text) {
                this.saidThisTurn = true;
                const text = this.jarvisSpeech.add(sc.outputTranscription.text);
                if (text) this.broadcast({ type: 'voice_transcript', text, role: 'assistant', is_final: false });
              }
            }

            if (message.toolCall) {
              const fc = message.toolCall.functionCalls?.[0];
              if (fc && fc.name === PHONE_ACTION_TOOL.name) {
                // Runs on the phone; Gemini speaks the result.
                (async () => {
                  const result = this.phoneBridge
                    ? await this.phoneBridge.run(fc.args || {})
                    : 'Phone actions are not available.';
                  try {
                    this.session?.sendToolResponse({
                      functionResponses: [{ id: fc.id, name: fc.name, response: { result } }],
                    });
                  } catch (e) {
                    this.broadcastLog(`[GEMINI ERROR] Phone action response failed: ${e.message}`);
                  }
                })();
              } else if (fc && fc.name === BUSINESS_TOOL.name) {
                // Local data, answered at once: the card opens and Gemini speaks the overview it gets back.
                let result;
                try {
                  result = this.business
                    ? this.business.show({ focus: fc.args?.name || undefined }).spoken
                    : 'The business dashboard is not available on this Jarvis server.';
                } catch (e) {
                  result = `The business dashboard could not be opened: ${e.message}`;
                }
                try {
                  this.session?.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { result } }] });
                } catch (e) {
                  this.broadcastLog(`[GEMINI ERROR] Business dashboard response failed: ${e.message}`);
                }
              } else if (fc && fc.name === SHOW_CARD_TOOL.name) {
                // The card opens on the device talking (forSpeaker origin); Gemini speaks the answer.
                const session = this.session;
                (async () => {
                  let result;
                  try {
                    result = (await this.showCard(fc.args || {}, { broadcast: this.broadcast })).result;
                  } catch (e) {
                    result = `The card could not be shown (${e.message}). Tell the user the answer in words.`;
                  }
                  try {
                    session?.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { result } }] });
                  } catch (e) {
                    this.broadcastLog(`[GEMINI ERROR] Card response failed: ${e.message}`);
                  }
                })();
              } else if (fc && fc.name === `delegate_to_${this.targetAgent}`) {
                const task = fc.args.task;
                // Non-blocking: Gemini goes on talking ("I'm on it…") while the agent works. The
                // written acknowledgement is only a fallback, when it stays silent.
                setTimeout(() => this.acknowledgeIfSilent(this.targetAgent), ACK_GRACE_MS);
                this.broadcastLog(`[GEMINI LIVE] Delegating to ${this.targetAgent.toUpperCase()}: ${task}`);
                const session = this.session;
                (async () => {
                  const raw = await this.delegateToAgent(task, this.targetAgent, true);
                  const resultText = raw && raw.length > 5000 ? `${raw.substring(0, 5000)}... [TRUNCATED DUE TO LENGTH]` : raw;
                  this.deliverResult(session, fc, task, resultText);
                })();
              }
            }

            if (sc?.turnComplete) {
              this.flushUserSpeech();
              const said = this.jarvisSpeech.flush();
              if (said) this.broadcast({ type: 'voice_transcript', text: said, role: 'assistant', is_final: true });
              if (this.broadcastAgentStatus) {
                this.geminiState = 'IDLE';
                this.broadcastAgentStatus(this.targetAgent, 'IDLE');
              }
            }
          },
          onerror: (e) => {
            console.error('[GEMINI] Error:', e.message);
            this.broadcastLog(`[GEMINI ERROR] ${e.message}`);
            this.broadcastNotification({ label: 'GEMINI LIVE', msg: `Error: ${e.message}`, kind: 'warn' });
            this.session = null;
          },
          onclose: (e) => {
            const closeMsg = `[GEMINI] Live Session Closed — code:${e.code} reason:${e.reason || 'none'}`;
            console.log(closeMsg);
            this.broadcastLog(closeMsg);
            this.session = null;
          }
        }
      });
    } catch (err) {
      console.error('[GEMINI] Connection failed:', err.message);
      this.broadcastLog(`[GEMINI] Connection failed: ${err.message}`);
      this.broadcastNotification({ label: 'GEMINI LIVE', msg: `Connection failed: ${err.message}`, kind: 'warn' });
      if (this.broadcastAgentStatus) this.broadcastAgentStatus(this.targetAgent || 'gemini', 'IDLE');
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Hands an agent's answer back to Gemini, which tells the user once it is quiet. When the
   * session was replaced meanwhile (1011 drops, reconnects), the old call id means nothing to
   * the new one: the answer goes in as a text turn instead of being lost.
   */
  deliverResult(session, fc, task, resultText) {
    const result = `Task finished. Agent answer:\n${resultText || 'Done.'}`;
    try {
      if (session && session === this.session) {
        console.log(`[GEMINI LIVE] Sending tool response for ${fc.name}... length: ${resultText?.length || 0}`);
        session.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, scheduling: 'WHEN_IDLE', response: { result } }] });
      } else if (this.session?.sendClientContent) {
        console.log(`[GEMINI LIVE] Session changed during ${fc.name}: sending the answer as a text turn`);
        this.session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: `(The task you handed to the agent earlier — "${task}" — is finished. Tell me what it says.)\n${result}` }] }],
          turnComplete: true,
        });
      } else {
        console.log(`[GEMINI LIVE] No Live session for the ${fc.name} answer (shown on screen only)`);
        return;
      }
      console.log('[GEMINI LIVE] Tool response sent successfully.');
    } catch (e) {
      console.error('[GEMINI LIVE] Failed to send tool response:', e);
      this.broadcastLog(`[GEMINI ERROR] Tool Response Failed: ${e.message}`);
    }
  }

  disconnect() {
    if (this.session) {
      console.log('[GEMINI] Closing Live session');
      this.broadcastLog('[GEMINI] Live Session Closing...');
      if (typeof this.session.close === 'function') {
        try { this.session.close(); } catch(e) {}
      }
      this.session = null;
      if (this.broadcastAgentStatus) this.broadcastAgentStatus(this.targetAgent || 'gemini', 'IDLE');
    }
    this.connecting = false;
  }
}
