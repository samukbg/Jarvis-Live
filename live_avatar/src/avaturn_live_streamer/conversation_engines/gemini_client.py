# SPDX-FileCopyrightText: 2026 Goodsize Inc.
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import asyncio
import time
import json
import os
import re
from pathlib import Path
from base64 import b64decode, b64encode
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

import attrs
import httpx
import websockets
from websockets.asyncio.client import ClientConnection
from websockets.protocol import State

from avaturn_live_streamer.core.logs import get_logger
from avaturn_live_streamer import constant
from avaturn_live_streamer.clocks import StreamClocks
from avaturn_live_streamer.conversation_engines.configs import GeminiConversationEngineConfig
from avaturn_live_streamer.event_bus import EventBus
from avaturn_live_streamer.events import (
    DiscardAvatarSpeechBuffer,
    InputTranscript,
    ResponseTranscript,
    SegmentChunkGenerated,
    SegmentGenerationCompleted,
    SegmentGenerationStarted,
    Shutdown,
    TextEchoEnqueueText,
    UserSpeechReceived,
)
from avaturn_live_streamer.management.types import SegmentId
from avaturn_live_streamer.speech.speech_buffer import SpeechBuffer
from avaturn_live_streamer.speech.voice_converter import VoiceConverter
from avaturn_live_streamer.speech.hybrid_voice_synthesizer import HybridVoiceSynthesizer
from avaturn_live_streamer.utils.async_utils import run_in_thread
from avaturn_live_streamer.utils.datetime import tzutcnow
from avaturn_live_streamer.utils.exceptions import async_log_entry_exit
from avaturn_live_streamer.utils.latency_probe import PROBE, USER_VOICE_MARK, VOICED_RMS
from avaturn_live_streamer.utils.input_tap import INPUT_TAP
from avaturn_live_streamer.vision import VISION

_LOGGER = get_logger()
_GEMINI_LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent"
_CACHED_JARVIS_HOST: str | None = None

def _get_candidate_host_bases(configured_url: str | None = None) -> list[str]:
    bases: list[str] = []
    if configured_url:
        u = configured_url.rstrip("/")
        if not u.startswith("http"):
            u = f"http://{u}"
        bases.append(u)

    env_url = os.environ.get("JARVIS_BACKEND_URL")
    if env_url:
        bases.append(env_url.rstrip("/"))

    global _CACHED_JARVIS_HOST
    if _CACHED_JARVIS_HOST:
        bases.append(f"http://{_CACHED_JARVIS_HOST}:4000")

    hosts = ["127.0.0.1", "localhost", "172.30.64.1", "10.255.255.254", "10.0.2.2"]
    try:
        import subprocess
        out = subprocess.check_output(["ip", "route"]).decode()
        for line in out.splitlines():
            if "default via" in line:
                gw = line.split()[2]
                if gw not in hosts:
                    hosts.insert(0, gw)
    except Exception:
        pass

    for h in hosts:
        bases.append(f"http://{h}:4000")

    seen: set[str] = set()
    deduped: list[str] = []
    for b in bases:
        if b not in seen:
            seen.add(b)
            deduped.append(b)
    return deduped
_GRACEFUL_CLOSE_CODE = 1000

# Delegation tool → the agent id the backend detects (GET /api/agents) and when to use it.
_DELEGATION_AGENTS = {
    "delegate_to_agy": ("gemini", "Antigravity (AGY)", "For computer-use, browser navigation, Antigravity coding tasks, file editing, web search, creating apps, and PC automation."),
    "delegate_to_claude": ("claude", "Claude", "For deep reasoning, architectural design, complex refactoring, and code review."),
    "delegate_to_hermes": ("hermes", "Hermes", "For quick terminal commands, shell scripts, CLI tools, and system administration."),
    "delegate_to_codex": ("codex", "Codex", "For coding tasks, writing and fixing code, and running repository changes with the OpenAI Codex CLI."),
}


def _delegation_rules(tool_names: list[str]) -> str:
    """The system rules for the delegation tools this server actually has."""
    names = ", ".join(_DELEGATION_AGENTS[t][1] for t in tool_names) or "no sub-agents"
    lines = "".join(f"- {t}: {_DELEGATION_AGENTS[t][2]}\n" for t in tool_names)
    return BASE_DELEGATION_RULES.replace("{AGENTS}", names).replace("{TOOLS}", lines)


BASE_DELEGATION_RULES = (
    "You are Jarvis, the central AI orchestrator for this machine, equipped with autonomous sub-agents: "
    "{AGENTS}.\n\n"
    "[CRITICAL CAPABILITY & TOOL USAGE RULES]\n"
    "You have real, direct access to execute tasks on this computer through your tools. "
    "When the user asks you to perform ANY computer task, coding task, browser action, script, app development, "
    "web search, file operation, command execution, or system analysis, NEVER say you cannot do it or that you lack tools.\n"
    "Instead, you MUST CALL the appropriate tool immediately:\n"
    "{TOOLS}\n"
    "MANDATORY PROTOCOL: Before calling any delegation tool, you MUST FIRST speak a short, natural acknowledgment "
    "to the user in the EXACT SAME LANGUAGE they used (e.g., if English: 'Let me check that for you.' or 'I\'m on it, executing that now.'; "
    "if Portuguese: 'Vou verificar isso agora.' or 'Estou nisso.'; if Spanish: 'Lo reviso de inmediato.'). "
    "Never respond in English if the user spoke another language. Do not skip this verbal acknowledgment.\n\n"
    "Once the tool execution returns the outcome result, summarize the findings naturally and concisely to the user in their language."
)

# Gemini Live drops sessions now and then (1011 "Internal error occurred", network 1006,
# or a planned close after goAway). The avatar session survives: reconnect with the
# session-resumption handle (same conversation), a few times per avatar session.
_TRANSIENT_CLOSE_CODES = {1001, 1006, 1011, 1012, 1013, 1014}
_MAX_RECONNECTS = 5


# Built-in AVTR-1 avatars: Gemini Live's native voice (instant). Avatars made from a real
# person's recording (created in the app, or reference_voices/<id>.ogg) use the XTTS cloned voice.
BUILTIN_GEMINI_VOICE_AVATARS = frozenset({
    "maria", "kate", "clara", "elena", "may", "camila", "caroline", "ben", "john", "oliver",
    "ming", "jack", "arnold", "gordon", "marcus", "mozart", "trevor",
})


class _SessionDropped(Exception):
    """Gemini closed the WebSocket cleanly although the avatar session goes on."""


def reconnectable(error: BaseException) -> bool:
    """Is this TaskGroup failure a Gemini-side drop worth reconnecting after?"""
    errors = error.exceptions if isinstance(error, BaseExceptionGroup) else (error,)
    def one(e: BaseException) -> bool:
        if isinstance(e, BaseExceptionGroup):
            return reconnectable(e)
        if isinstance(e, _SessionDropped):
            return True
        if isinstance(e, websockets.exceptions.ConnectionClosedError):
            code = e.rcvd.code if e.rcvd is not None else 1006
            return code in _TRANSIENT_CLOSE_CODES
        return False
    return bool(errors) and all(one(e) for e in errors)


_DEFAULT_LIVE_MODEL = "models/gemini-2.5-flash-native-audio-latest"
_JARVIS_API_KEY = os.environ.get("API_KEY", "")

DELEGATION_TOOLS = [
    {
        "functionDeclarations": [
            {
                "name": "delegate_to_agy",
                "description": "Delegate computer-use, browser-use, Antigravity agent tasks, coding, scripts, app creation, web search, or local file execution to the AGY (Antigravity) agent.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "task": {
                            "type": "STRING",
                            "description": "The detailed task instruction to send to the Antigravity agent",
                        }
                    },
                    "required": ["task"],
                },
            },
            {
                "name": "delegate_to_claude",
                "description": "Delegate complex reasoning, architectural design, code review, or file editing to the Claude agent.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "task": {
                            "type": "STRING",
                            "description": "The detailed task instruction to send to Claude",
                        }
                    },
                    "required": ["task"],
                },
            },
            {
                "name": "delegate_to_hermes",
                "description": "Delegate quick terminal commands, shell scripts, or local execution to the Hermes agent.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "task": {
                            "type": "STRING",
                            "description": "The detailed task instruction to send to Hermes",
                        }
                    },
                    "required": ["task"],
                },
            },
            {
                "name": "delegate_to_codex",
                "description": "Delegate coding tasks, code changes, or repository work to the OpenAI Codex agent.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "task": {
                            "type": "STRING",
                            "description": "The detailed task instruction to send to Codex",
                        }
                    },
                    "required": ["task"],
                },
            },
        ]
    }
]


def spoken_text(server_content: dict[str, Any]) -> str:
    """The words Jarvis says in one serverContent message.

    The transcription of Gemini's audio when present, else the reply's text parts —
    never its thinking: native-audio models (gemini-2.5-flash-native-audio) send their
    reasoning as text parts marked `thought: true`, and the avatar's cloned voice was
    reading it aloud ("**Confirming Immediate Response** I've registered...").
    """
    for key in ("outputTranscription", "outputAudioTranscription"):
        text = (server_content.get(key) or {}).get("text")
        if text:
            return text
    parts = (server_content.get("modelTurn") or {}).get("parts", [])
    return "".join(p["text"] for p in parts if p.get("text") and not p.get("thought"))


@attrs.define
class GeminiApiClient:
    _config: GeminiConversationEngineConfig
    stream_id: str
    _turn_counter: int = 0
    _current_segment_id: SegmentId | None = None
    _voice_converter: VoiceConverter = attrs.field(init=False)
    _hybrid_synthesizer: HybridVoiceSynthesizer = attrs.field(init=False)
    _is_hybrid_clone: bool = attrs.field(init=False)
    _first_chunk_sent: bool = attrs.field(init=False, default=False)
    _text_accumulator: str = attrs.field(init=False, default="")
    _turn_response_accumulator: str = attrs.field(init=False, default="")
    # What the user is saying, in Gemini's transcription fragments: sent to Jarvis as one line.
    _user_input_accumulator: str = attrs.field(init=False, default="")
    _tts_queue: asyncio.Queue = attrs.field(init=False)
    _backup_audio_chunks: list[SpeechBuffer] = attrs.field(init=False)
    # Bumped on interruption: a sentence still being synthesised is then dropped.
    _speech_generation: int = attrs.field(init=False, default=0)
    _tts_succeeded: bool = attrs.field(init=False, default=False)
    # Session resumption: the latest handle Gemini gave, so a reconnect keeps the conversation.
    _resume_handle: str | None = attrs.field(init=False, default=None)
    _shutting_down: bool = attrs.field(init=False, default=False)

    def _check_is_hybrid_clone(self, avatar_id: str) -> bool:
        av = (avatar_id or "").lower().strip()
        # The built-in AVTR-1 avatars speak with Gemini Live's own voice, streamed as it is
        # generated. (The voice server extracts latents for every reference voice, which made
        # them all go through XTTS: seconds of extra latency for a voice that isn't a person's.)
        if av in BUILTIN_GEMINI_VOICE_AVATARS:
            return False
        # Only treat an avatar as a hybrid GPU clone if explicit pre-extracted latents exist
        for d in [
            Path("reference_voices"),
            Path("live_avatar/reference_voices"),
            Path(__file__).resolve().parent.parent.parent.parent / "reference_voices",
            Path("/root/avtr-1/reference_voices"),
        ]:
            if d.exists() and (d / f"{av}_latents.pt").is_file():
                return True
        return False

    def __attrs_post_init__(self) -> None:
        self._current_segment_id = None
        current_av = (self._config.avatar_id or "maria").lower().strip()
        self._voice_converter = VoiceConverter(
            avatar_id=current_av,
            enabled=self._config.enable_voice_conversion,
        )
        self._hybrid_synthesizer = HybridVoiceSynthesizer(avatar_id=current_av, renderer_url=os.environ.get("RENDERER_URL"))
        self._is_hybrid_clone = self._check_is_hybrid_clone(current_av)
        self._first_chunk_sent = False
        self._text_accumulator = ""
        self._turn_response_accumulator = ""
        self._user_input_accumulator = ""
        self._tts_queue = asyncio.Queue()
        self._backup_audio_chunks = []
        self._speech_generation = 0
        self._tts_succeeded = False

    @asynccontextmanager
    async def _connect(self) -> AsyncGenerator[ClientConnection, None]:
        api_key = self._config.api_key
        if not api_key or api_key == "SERVER_MANAGED":
            api_key = os.environ.get("GEMINI_API_KEY", os.environ.get("GOOGLE_API_KEY", ""))
        url = f"{_GEMINI_LIVE_URL}?key={api_key}"
        
        # GEMINI_LIVE_MODEL on the server wins, so a broken model can be swapped without
        # rebuilding the apps. gemini-3.1-flash-live-preview stopped answering audio input
        # on 2026-10-01 (1011 "Internal error encountered"); old clients still ask for it.
        model_name = os.environ.get("GEMINI_LIVE_MODEL") or self._config.model or _DEFAULT_LIVE_MODEL
        if any(old in model_name for old in ("gemini-2.0-flash-exp", "gemini-3.1-flash-live-preview")):
            model_name = _DEFAULT_LIVE_MODEL
        if not model_name.startswith("models/"):
            model_name = f"models/{model_name}"

        # Only the agents installed on this server (the backend detects them); if it can't
        # be asked, offer the classic three.
        installed = await self._fetch_installed_agents()
        classic = ("delegate_to_agy", "delegate_to_claude", "delegate_to_hermes")
        declarations = [
            d for d in DELEGATION_TOOLS[0]["functionDeclarations"]
            if (d["name"] in classic if installed is None else _DELEGATION_AGENTS[d["name"]][0] in installed)
        ]
        rules = _delegation_rules([d["name"] for d in declarations])

        custom_prompt = (self._config.prompt or "").strip()
        if custom_prompt:
            full_system_instruction = f"{custom_prompt}\n\n{rules}"
        else:
            full_system_instruction = rules

        # The phone_action tool is defined once, in the backend (backend/device/phoneActions.js).
        phone = await self._fetch_phone_tool()
        if phone is not None:
            tool, prompt = phone
            declarations = [*declarations, tool]
            full_system_instruction = f"{full_system_instruction}\n\n{prompt}"
        tools = [{"functionDeclarations": declarations}] if declarations else []

        chosen_voice = self._config.voice or self._voice_converter.profile.gemini_base_voice or "Kore"

        gen_config = {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {
                        "voiceName": chosen_voice
                    }
                }
            }
        }
        if "native-audio" in model_name:
            # Native-audio models think before answering (~0.5-1 s later first audio,
            # and the thoughts used to be spoken). A conversation doesn't need it.
            gen_config["thinkingConfig"] = {"thinkingBudget": 0}

        PROBE.set_info("gemini.model", model_name)
        PROBE.set_info("avatar.id", self._voice_converter.avatar_id)
        PROBE.set_info("avatar.voice_path", "hybrid_xtts" if self._is_hybrid_clone else "gemini_direct")
        _LOGGER.info(
            "Connecting to Gemini Live API",
            model=model_name,
            stream_id=self.stream_id,
            voice=chosen_voice,
            avatar=self._voice_converter.avatar_id,
        )
        async with websockets.connect(
            url,
            ping_interval=60,
            ping_timeout=20,
        ) as ws:
            setup_msg = {
                "setup": {
                    "model": model_name,
                    "generationConfig": gen_config,
                    "systemInstruction": {
                        "parts": [{"text": full_system_instruction}]
                    },
                    "tools": tools,
                    "outputAudioTranscription": {},
                    "inputAudioTranscription": {},
                    "sessionResumption": {"handle": self._resume_handle} if self._resume_handle else {},
                }
            }
            await ws.send(json.dumps(setup_msg))
            yield ws

    def _convert_timed(self, raw: SpeechBuffer) -> SpeechBuffer:
        with PROBE.timed("voice_converter.chunk_ms"):
            return self._voice_converter.process_chunk(raw)

    async def _send_speech(self, ws: ClientConnection, buffer: SpeechBuffer) -> None:
        msg = await run_in_thread(self._encode_media_input, buffer)
        try:
            await ws.send(msg)
        except websockets.exceptions.ConnectionClosed:
            _LOGGER.debug("Gemini WS closed during speech send, ignoring")
            return

    def _encode_media_input(self, buffer: SpeechBuffer) -> str:
        # Gemini Multimodal Live API requires exactly 16000Hz PCM input
        if buffer.sample_rate != 16000:
            buffer = buffer.resample(16000)
        pcm = buffer.to_bytes()
        INPUT_TAP.add(self.stream_id, pcm)
        return json.dumps(
            {
                "realtimeInput": {
                    "audio": {
                        "mimeType": "audio/pcm;rate=16000",
                        "data": b64encode(pcm).decode("utf-8"),
                    }
                }
            }
        )

    async def _vision_sender(self, ws: ClientConnection) -> None:
        """Forwards the phone's camera / screen frames as realtime video (≤ 2 fps)."""
        while ws.state == State.OPEN:
            try:
                # Short waits so the task ends with the session instead of blocking its TaskGroup.
                mime_type, data = await asyncio.wait_for(VISION.next(), timeout=1.0)
            except TimeoutError:
                continue
            if ws.state != State.OPEN:
                return
            try:
                await ws.send(json.dumps({"realtimeInput": {"video": {"mimeType": mime_type, "data": data}}}))
            except websockets.exceptions.ConnectionClosed:
                return
            await asyncio.sleep(0.5)

    async def _send_user_text(self, ws: ClientConnection, text: str) -> None:
        msg = json.dumps(
            {
                "clientContent": {
                    "turns": [
                        {
                            "role": "user",
                            "parts": [{"text": text}],
                        }
                    ],
                    "turnComplete": True,
                }
            }
        )
        await ws.send(msg)

    @staticmethod
    def _decode_chunk(payload_base64: str) -> SpeechBuffer:
        return SpeechBuffer.from_bytes(
            b64decode(payload_base64), constant.NATIVE_SPEECH_SAMPLE_RATE
        )

    def _backend_targets(self) -> tuple[list[str], dict[str, str]]:
        """The Jarvis backend(s) to call back, and the key to call them with.

        A session started by a Jarvis backend on another machine (this GPU box only renders
        the avatar) comes with that backend's URL and key: it is the only target — never this
        GPU server's own backend, whose agents may belong to someone else.
        """
        url = getattr(self._config, "jarvis_backend_url", None)
        key = getattr(self._config, "jarvis_backend_key", None)
        if url and key:
            return [url.rstrip("/")], {"x-api-key": key}
        return _get_candidate_host_bases(url), {"x-api-key": _JARVIS_API_KEY}

    async def _fetch_installed_agents(self) -> set[str] | None:
        """Ids of the agents Jarvis can drive on this server (GET /api/agents), None if unknown."""
        bases, headers = self._backend_targets()
        async with httpx.AsyncClient(timeout=4.0) as client:
            for base in bases:
                try:
                    res = await client.get(f"{base}/api/agents", headers=headers)
                    if res.is_success:
                        return {a["id"] for a in res.json().get("agents", []) if a.get("driven")}
                except Exception as e:
                    _LOGGER.debug("agent list unavailable from candidate", base=base, error=str(e))
        return None

    async def _fetch_phone_tool(self) -> tuple[dict[str, Any], str] | None:
        bases, headers = self._backend_targets()
        async with httpx.AsyncClient(timeout=4.0) as client:
            for base in bases:
                try:
                    res = await client.get(f"{base}/api/device/tool", headers=headers)
                    if res.is_success:
                        data = res.json()
                        return data["tool"], data.get("prompt", "")
                except Exception as e:
                    _LOGGER.debug("phone tool unavailable from candidate", base=base, error=str(e))
        _LOGGER.warning("phone_action tool unavailable: Jarvis backend not reachable")
        return None

    async def _execute_phone_action(self, args: dict[str, Any]) -> str:
        bases, headers = self._backend_targets()
        async with httpx.AsyncClient(timeout=40.0) as client:
            for base in bases:
                try:
                    res = await client.post(f"{base}/api/device/action", json=args, headers=headers)
                    if res.is_success:
                        return str(res.json().get("result", "Done."))
                except Exception as e:
                    _LOGGER.debug("phone action failed via candidate", base=base, error=str(e))
        return "Could not reach the Jarvis backend to act on the phone."

    async def _execute_delegation(self, agent: str, task: str) -> str:
        global _CACHED_JARVIS_HOST
        _LOGGER.info("Executing delegation to Jarvis backend", agent=agent, task=task)
        bases, headers = self._backend_targets()
        urls = [f"{b}/api/avatar/delegate" for b in bases]
        
        async with httpx.AsyncClient(timeout=120.0) as client:
            for url in urls:
                try:
                    res = await client.post(
                        url,
                        json={"task": task, "agent": agent},
                        headers=headers
                    )
                    if res.is_success:
                        data = res.json()
                        result = data.get("result", "Task executed successfully.")
                        host = url.split("://")[1].split(":")[0]
                        if not getattr(self._config, "jarvis_backend_key", None):
                            _CACHED_JARVIS_HOST = host
                        _LOGGER.info("Delegation succeeded via URL", url=url, host=host)
                        return result
                    else:
                        _LOGGER.warning("Delegation endpoint returned error status", url=url, status=res.status_code)
                except Exception as e:
                    _LOGGER.debug("Failed reaching delegation url, trying candidate", url=url, error=str(e))
                    continue
        
        _LOGGER.error("All Jarvis backend delegation endpoints unreachable")
        return "Failed to reach Jarvis local backend to execute the task."

    def _flush_user_transcript(self) -> None:
        """The user's utterance is over (Jarvis answers, calls a tool, or the turn ends): one line
        in Jarvis's activity, not one per transcription fragment ("C'est", " quo", "i la"…)."""
        text = " ".join(self._user_input_accumulator.split())
        self._user_input_accumulator = ""
        if text:
            asyncio.create_task(self._send_transcript_to_jarvis(text, role="user", is_final=True))

    async def _send_transcript_to_jarvis(self, text: str, role: str = "assistant", is_final: bool = True) -> bool:
        if not text.strip():
            return False
        bases, headers = self._backend_targets()
        async with httpx.AsyncClient(timeout=10.0) as client:
            for b in bases:
                url = f"{b}/api/avatar/transcript"
                try:
                    res = await client.post(
                        url,
                        json={"text": text.strip(), "role": role, "is_final": is_final},
                        headers=headers
                    )
                    if res.is_success:
                        return True
                except Exception:
                    continue
        return False

    async def _listener(self, bus: EventBus, ws: ClientConnection) -> None:
        bus.ready()
        try:
            async for data in ws:
                if isinstance(data, bytes):
                    data = data.decode("utf-8")
                msg = await run_in_thread(json.loads, data)
                await self._dispatch_server_event(bus, ws, msg)
            if not self._shutting_down:
                raise _SessionDropped(f"closed {ws.close_code} {ws.close_reason!r}")
        finally:
            _LOGGER.info(
                "Gemini Live WebSocket closed",
                stream_id=self.stream_id,
                close_code=ws.close_code,
                close_reason=ws.close_reason,
            )

    async def _dispatch_server_event(self, bus: EventBus, ws: ClientConnection, msg: dict[str, Any]) -> None:
        if "setupComplete" in msg:
            _LOGGER.info("Gemini Live setup complete with delegation tools", resumed=bool(self._resume_handle))
            return
        update = msg.get("sessionResumptionUpdate")
        if update is not None:
            if update.get("newHandle") and update.get("resumable", True):
                self._resume_handle = update["newHandle"]
            return
        if "goAway" in msg:
            _LOGGER.info("Gemini Live will close the session soon", time_left=msg["goAway"].get("timeLeft"))
            return

        # Handle Tool Calls (Task Delegation)
        tool_call = msg.get("toolCall")
        if tool_call:
            self._flush_user_transcript()
            # Complete any speech segment so the avatar gracefully transitions to active idle rendering
            if self._current_segment_id:
                await bus.publish(SegmentGenerationCompleted(segment_id=self._current_segment_id))
                self._current_segment_id = None
            if self._is_hybrid_clone:
                # Play the acknowledgment ("Je regarde ça pour toi.") now, while the agent works.
                rem = self._text_accumulator.strip()
                self._text_accumulator = ""
                self._first_chunk_sent = False
                await self._tts_queue.put((rem, True))

            function_calls = tool_call.get("functionCalls", [])
            
            async def _run_delegation(fc_list: list[dict[str, Any]]) -> None:
                function_responses = []
                for fc in fc_list:
                    name = fc.get("name", "")
                    args = fc.get("args", {})
                    task = args.get("task", "")
                    call_id = fc.get("id", "")
                    if name == "phone_action":
                        _LOGGER.info("Gemini Live phone action", action=args.get("action"))
                        result_text = await self._execute_phone_action(args)
                        function_responses.append({"id": call_id, "name": name, "response": {"result": result_text}})
                        continue
                    agent = name.removeprefix("delegate_to_") if name in _DELEGATION_AGENTS else "agy"
                    
                    _LOGGER.info("Gemini Live Tool Call detected -> Executing Agent Task", agent=agent, task=task)
                    result_text = await self._execute_delegation(agent, task)
                    function_responses.append({
                        "id": call_id,
                        "name": name,
                        "response": {"result": result_text}
                    })
                
                tool_response_msg = {
                    "toolResponse": {
                        "functionResponses": function_responses
                    }
                }
                if ws.state == State.OPEN:
                    await ws.send(json.dumps(tool_response_msg))

            asyncio.create_task(_run_delegation(function_calls))
            return

        sc = msg.get("serverContent")
        if sc:
            heard = sc.get("inputTranscription") or sc.get("inputAudioTranscription") or {}
            self._user_input_accumulator += heard.get("text") or ""  # fragments carry their own spaces
            if heard.get("finished"):
                self._flush_user_transcript()
            if sc.get("interrupted"):
                _LOGGER.info("Gemini Live speech interrupted")
                self._voice_converter.reset()
                self._text_accumulator = ""
                self._turn_response_accumulator = ""
                self._first_chunk_sent = False
                self._backup_audio_chunks.clear()
                self._tts_succeeded = False
                self._speech_generation += 1  # a sentence still being synthesised is dropped
                while not self._tts_queue.empty():
                    try:
                        self._tts_queue.get_nowait()
                    except (asyncio.QueueEmpty, ValueError):
                        break
                if self._current_segment_id:
                    await bus.publish(SegmentGenerationCompleted(segment_id=self._current_segment_id))
                    self._current_segment_id = None
                await bus.publish(DiscardAvatarSpeechBuffer())

            token_text = spoken_text(sc)
            if token_text or sc.get("modelTurn"):
                self._flush_user_transcript()  # Jarvis is answering: the user's utterance is complete

            if self._is_hybrid_clone:
                model_turn = sc.get("modelTurn")
                if model_turn:
                    for part in model_turn.get("parts", []):
                        inline_data = part.get("inlineData")
                        if inline_data and inline_data.get("data"):
                            PROBE.since(USER_VOICE_MARK, "resp.eos_to_gemini_first_audio_ms")
                            raw = await run_in_thread(self._decode_chunk, inline_data["data"])
                            self._backup_audio_chunks.append(raw)

                if token_text:
                    PROBE.since(USER_VOICE_MARK, "resp.eos_to_first_text_ms")
                    self._text_accumulator += token_text
                    
                    # For the very first chunk of a turn, trigger early on commas, dashes, colons or 4 words
                    # to drop the initial response latency from ~2s down to ~500-700ms!
                    words = self._text_accumulator.strip().split()
                    should_split = False
                    split_delims = [". ", "! ", "? ", "\n", "; ", ".\n"]
                    
                    if not self._first_chunk_sent:
                        if any(punct in self._text_accumulator for punct in [", ", ": ", " - ", "— "]) or len(words) >= 4:
                            split_delims = [", ", ": ", " - ", "— "] + split_delims
                            should_split = True
                    
                    if should_split or any(punct in self._text_accumulator for punct in split_delims):
                        pattern = r"(?<=[.!?\n;,:—])\s+" if not self._first_chunk_sent else r"(?<=[.!?\n;])\s+"
                        parts = re.split(pattern, self._text_accumulator, maxsplit=1)
                        if len(parts) > 1:
                            sentence = parts[0].strip()
                            self._text_accumulator = parts[1]
                            if sentence:
                                self._first_chunk_sent = True
                                _LOGGER.info("Queued fast early phrase for XTTS-v2 synthesis", avatar=self._config.avatar_id, sentence=sentence[:60])
                                await self._tts_queue.put((sentence, False))

                if sc.get("turnComplete"):
                    rem = self._text_accumulator.strip()
                    self._text_accumulator = ""
                    self._first_chunk_sent = False
                    if rem:
                        _LOGGER.info("Queued final sentence for XTTS-v2 synthesis", avatar=self._config.avatar_id, sentence=rem[:60])
                    await self._tts_queue.put((rem, True))
            else:
                model_turn = sc.get("modelTurn")
                if model_turn:
                    parts = model_turn.get("parts", [])
                    for part in parts:
                        inline_data = part.get("inlineData")
                        if inline_data and inline_data.get("data"):
                            PROBE.since(USER_VOICE_MARK, "resp.eos_to_gemini_first_audio_ms")
                            raw_chunk = await run_in_thread(self._decode_chunk, inline_data["data"])
                            chunk = await run_in_thread(self._convert_timed, raw_chunk)
                            if self._current_segment_id is None:
                                self._turn_counter += 1
                                self._current_segment_id = SegmentId(f"gemini-{self.stream_id}-{self._turn_counter}")
                                await bus.publish(SegmentGenerationStarted(segment_id=self._current_segment_id))

                            PROBE.since(USER_VOICE_MARK, "resp.eos_to_first_avatar_chunk_ms")
                            await bus.publish(SegmentChunkGenerated(segment_id=self._current_segment_id, buffer=chunk))

                if sc.get("turnComplete"):
                    if self._current_segment_id:
                        await bus.publish(SegmentGenerationCompleted(segment_id=self._current_segment_id))
                        self._current_segment_id = None

            if token_text:
                self._turn_response_accumulator += token_text
                if token_text.strip():
                    await bus.publish(ResponseTranscript(transcript=token_text.strip(), timestamp=tzutcnow().timestamp()))

            if sc.get("turnComplete"):
                turn_text = self._turn_response_accumulator.strip()
                self._turn_response_accumulator = ""
                if turn_text:
                    asyncio.create_task(self._send_transcript_to_jarvis(turn_text, role="assistant", is_final=True))

            input_text = ""
            if sc.get("inputTranscription", {}).get("text"):
                input_text = sc["inputTranscription"]["text"].strip()
            elif sc.get("inputAudioTranscription", {}).get("text"):
                input_text = sc["inputAudioTranscription"]["text"].strip()

            if input_text:
                INPUT_TAP.heard(self.stream_id, input_text)
                _LOGGER.info("Gemini heard", text=input_text, stream_id=self.stream_id)
                await bus.publish(InputTranscript(transcript=input_text, timestamp=tzutcnow().timestamp()))

            if sc.get("turnComplete"):
                self._flush_user_transcript()

    async def _tts_worker(self, bus: EventBus) -> None:
        """Speaks the cloned voice (XTTS) phrase by phrase, as it is generated.

        Each phrase (the first one cut early: a comma or 4 words) is streamed by the voice
        server while XTTS generates it, and each 20 ms chunk goes to the avatar at once — the
        avatar starts talking ~0.3 s after the first phrase's text exists, and later phrases
        are synthesised while earlier ones play (XTTS runs faster than speech).
        XTTS_HOLD_REPLY=1 restores the old behaviour (play the reply whole at turnComplete),
        for a GPU that can't render and synthesise at once.
        """
        bus.ready()
        hold = os.environ.get("XTTS_HOLD_REPLY") == "1"
        held: list[SpeechBuffer] = []
        held_generation = self._speech_generation
        while True:
            try:
                item = await self._tts_queue.get()
                if item is None:
                    break
                sentence, is_final = item
                generation = self._speech_generation
                if generation != held_generation:  # an interruption happened: drop held speech
                    held.clear()
                    held_generation = generation
                if sentence:
                    t0 = time.perf_counter()
                    first = True
                    async for chunk in self._hybrid_synthesizer.stream(sentence):
                        if generation != self._speech_generation:
                            held.clear()
                            break  # interrupted while synthesising
                        if first:
                            first = False
                            PROBE.record("tts.first_chunk_ms", (time.perf_counter() - t0) * 1000.0)
                        self._tts_succeeded = True
                        if hold:
                            held.append(chunk)
                        else:
                            await self._play(bus, [chunk])
                    PROBE.record("tts.synth_ms", (time.perf_counter() - t0) * 1000.0)

                if is_final:
                    if not self._tts_succeeded and self._backup_audio_chunks:
                        _LOGGER.info(
                            "Hybrid TTS synthesis produced no chunks; flushing converted Gemini audio backup",
                            avatar=self._config.avatar_id,
                            chunks=len(self._backup_audio_chunks)
                        )
                        for raw_b in self._backup_audio_chunks:
                            held.append(await run_in_thread(self._convert_timed, raw_b))
                    if held:
                        await self._play(bus, held)
                        held = []
                    if self._current_segment_id:
                        await bus.publish(SegmentGenerationCompleted(segment_id=self._current_segment_id))
                        self._current_segment_id = None
                    self._tts_succeeded = False
                    self._backup_audio_chunks.clear()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                _LOGGER.warning("TTS worker synthesis error", error=str(exc))

    async def _play(self, bus: EventBus, chunks: list[SpeechBuffer]) -> None:
        if self._current_segment_id is None:
            self._turn_counter += 1
            self._current_segment_id = SegmentId(f"gemini-{self.stream_id}-{self._turn_counter}")
            await bus.publish(SegmentGenerationStarted(segment_id=self._current_segment_id))
        PROBE.since(USER_VOICE_MARK, "resp.eos_to_first_avatar_chunk_ms")
        for c in chunks:
            await bus.publish(SegmentChunkGenerated(segment_id=self._current_segment_id, buffer=c))

    async def _handle_bus_events(self, bus: EventBus, ws: ClientConnection) -> None:
        async with bus.subscribe(UserSpeechReceived, TextEchoEnqueueText, Shutdown) as sub:
            bus.ready()
            async for event in sub:
                match event:
                    case UserSpeechReceived(buffer=buf):
                        if ws.state != State.OPEN:
                            return
                        if buf.rms >= VOICED_RMS:
                            PROBE.mark(USER_VOICE_MARK)
                        await self._send_speech(ws, buf)
                    case TextEchoEnqueueText(text=txt):
                        await self._send_user_text(ws, txt)
                    case Shutdown():
                        self._shutting_down = True
                        await self._tts_queue.put(None)
                        await ws.close()
                        return

    @async_log_entry_exit
    async def run(self, bus: EventBus, clocks: StreamClocks) -> None:
        reconnects = 0
        ready = False
        while True:
            try:
                async with self._connect() as ws:
                    async with asyncio.TaskGroup() as tg:
                        tg.create_task(self._listener(bus.clone(), ws), name="GeminiApiClient._listener")
                        tg.create_task(self._handle_bus_events(bus.clone(), ws), name="GeminiApiClient._handle_bus_events")
                        tg.create_task(self._vision_sender(ws), name="GeminiApiClient._vision_sender")
                        if self._is_hybrid_clone:
                            tg.create_task(self._tts_worker(bus.clone()), name="GeminiApiClient._tts_worker")
                        if not ready:  # once: this run's own clone (the reconnects' workers ready themselves)
                            bus.ready()
                            ready = True
                return
            except BaseExceptionGroup as error:
                if self._shutting_down or reconnects >= _MAX_RECONNECTS or not reconnectable(error):
                    raise
            reconnects += 1
            _LOGGER.warning(
                "Gemini Live dropped the session — reconnecting",
                attempt=reconnects,
                resume=bool(self._resume_handle),
                stream_id=self.stream_id,
            )
            # A reply cut mid-way: end its segment so the avatar returns to idle.
            if self._current_segment_id:
                await bus.publish(SegmentGenerationCompleted(segment_id=self._current_segment_id))
                self._current_segment_id = None
            self._text_accumulator = ""
            self._turn_response_accumulator = ""
            self._first_chunk_sent = False
            await asyncio.sleep(min(0.5 * reconnects, 2.0))
