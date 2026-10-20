# SPDX-FileCopyrightText: 2026 Goodsize Inc.
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

"""Shared engine builders used by local CLI entry points."""

import asyncio
from collections.abc import Callable, Coroutine
from typing import Annotated, Literal

import httpx
from pydantic import BaseModel, Discriminator

from avaturn_live_streamer.clocks import StreamClocks
from avaturn_live_streamer.conversation_engines.cartesia_client import CartesiaApiClient
from avaturn_live_streamer.conversation_engines.configs import (
    AgentConversationEngineConfig,
    CartesiaConversationEngineConfig,
    ConversationEngineConfig,
    GeminiConversationEngineConfig,
    OpenAIRealtimeAPIConversationEngineConfig,
    OpenaiRealtimeApiVoice,
)
from avaturn_live_streamer.conversation_engines.gemini_client import GeminiApiClient
from avaturn_live_streamer.conversation_engines.realtime_api_client import RealtimeApiClient
from avaturn_live_streamer.event_bus import EventBus
from avaturn_live_streamer.events import Shutdown

EngineKind = Literal["openai", "cartesia", "gemini", "agent"]
ENGINE_KINDS: tuple[EngineKind, ...] = ("openai", "cartesia", "gemini", "agent")

type EngineRun = Callable[[EventBus, StreamClocks], Coroutine[None, None, None]]
type BuiltEngine = tuple[ConversationEngineConfig, EngineRun]

_CARTESIA_TOKEN_URL = "https://api.cartesia.ai/access-token"
_CARTESIA_VERSION = "2025-04-16"

DEFAULT_OPENAI_PROMPT = (
    "You are a friendly, concise voice assistant. Speak naturally and keep "
    "answers under 50 words. Avoid emojis or unreadable symbols."
)
DEFAULT_OPENAI_VOICE: OpenaiRealtimeApiVoice = "shimmer"
DEFAULT_OPENAI_MODEL = "gpt-realtime-2"


class OpenAIEngineOptions(BaseModel):
    type: Literal["openai"] = "openai"
    api_key: str
    model: str = DEFAULT_OPENAI_MODEL
    prompt: str = DEFAULT_OPENAI_PROMPT
    voice: OpenaiRealtimeApiVoice = DEFAULT_OPENAI_VOICE


class CartesiaEngineOptions(BaseModel):
    type: Literal["cartesia"] = "cartesia"
    api_key: str
    agent_id: str


class GeminiEngineOptions(BaseModel):
    type: Literal["gemini"] = "gemini"
    api_key: str
    model: str = "models/gemini-3.8-live"
    prompt: str = ""
    voice: str = "Kore"
    avatar_id: str = "maria"
    enable_voice_conversion: bool = True
    jarvis_backend_url: str | None = None
    # Set when the Jarvis backend runs on another machine: the key the avatar calls it back with.
    jarvis_backend_key: str | None = None


class AgentEngineOptions(BaseModel):
    type: Literal["agent"] = "agent"
    prompt: str = ""


EngineOptions = Annotated[
    OpenAIEngineOptions | CartesiaEngineOptions | GeminiEngineOptions | AgentEngineOptions,
    Discriminator("type"),
]


async def _mint_cartesia_token(api_key: str) -> str:
    async with httpx.AsyncClient(timeout=10.0) as http:
        r = await http.post(
            _CARTESIA_TOKEN_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Cartesia-Version": _CARTESIA_VERSION,
            },
            json={"grants": {"agent": True}, "expires_in": 300},
        )
        r.raise_for_status()
        token = r.json().get("token")
        if not token:
            raise RuntimeError("Cartesia access-token response missing 'token' field")
        return token


async def mint_openai_realtime_secret(
    *,
    api_key: str,
    model: str = DEFAULT_OPENAI_MODEL,
    prompt: str = DEFAULT_OPENAI_PROMPT,
    voice: OpenaiRealtimeApiVoice = DEFAULT_OPENAI_VOICE,
    tracing: dict[str, object] | str | None = "auto",
) -> str:
    from openai import AsyncClient

    oai = AsyncClient(api_key=api_key)
    session: dict[str, object] = {
        "type": "realtime",
        "model": model,
        "audio": {
            "input": {
                "turn_detection": {"type": "semantic_vad", "eagerness": "high"},
            },
            "output": {"voice": voice},
        },
    }
    if prompt.strip():
        session["instructions"] = prompt
    if tracing is not None:
        session["tracing"] = tracing
    secret = await oai.realtime.client_secrets.create(
        expires_after={"seconds": 7200, "anchor": "created_at"},
        session=session,
    )
    return secret.value


async def build_cartesia(
    *,
    stream_id: str,
    options: CartesiaEngineOptions,
) -> BuiltEngine:
    import os
    api_key = options.api_key
    if not api_key or api_key == "SERVER_MANAGED":
        api_key = os.environ.get("CARTESIA_API_KEY", "")
    if not api_key:
        raise RuntimeError("Cartesia API Key not configured. Provide it in Settings or set CARTESIA_API_KEY in .env")
    token = await _mint_cartesia_token(api_key)
    cfg = CartesiaConversationEngineConfig(access_token=token, agent_id=options.agent_id)
    return cfg, CartesiaApiClient(cfg, stream_id=stream_id).run


async def build_openai(
    *,
    stream_id: str,
    options: OpenAIEngineOptions,
) -> BuiltEngine:
    tracing: dict[str, object] = {
        "workflow_name": "avaturn-live-local",
        "group_id": stream_id,
        "metadata": {"engine": "openai-realtime", "stream_id": stream_id},
    }
    secret = await mint_openai_realtime_secret(
        api_key=options.api_key,
        model=options.model,
        prompt=options.prompt,
        voice=options.voice,
        tracing=tracing,
    )
    cfg = OpenAIRealtimeAPIConversationEngineConfig(client_secret=secret)
    return cfg, RealtimeApiClient(cfg).run


async def build_gemini(
    *,
    stream_id: str,
    options: GeminiEngineOptions,
) -> BuiltEngine:
    cfg = GeminiConversationEngineConfig(
        api_key=options.api_key,
        model=options.model,
        prompt=options.prompt,
        voice=options.voice,
        avatar_id=options.avatar_id,
        enable_voice_conversion=options.enable_voice_conversion,
        jarvis_backend_url=options.jarvis_backend_url,
        jarvis_backend_key=options.jarvis_backend_key,
    )
    return cfg, GeminiApiClient(cfg, stream_id=stream_id).run


async def build_agent(
    *,
    stream_id: str,
    options: AgentEngineOptions,
) -> BuiltEngine:
    cfg = AgentConversationEngineConfig(prompt=options.prompt)
    async def _agent_run(bus: EventBus, clocks: StreamClocks) -> None:
        async with bus.subscribe(Shutdown) as sub:
            bus.ready()
            await sub.get_next()
    return cfg, _agent_run


async def build_engine(options: EngineOptions, *, stream_id: str) -> BuiltEngine:
    match options:
        case OpenAIEngineOptions():
            return await build_openai(stream_id=stream_id, options=options)
        case CartesiaEngineOptions():
            return await build_cartesia(stream_id=stream_id, options=options)
        case GeminiEngineOptions():
            return await build_gemini(stream_id=stream_id, options=options)
        case AgentEngineOptions():
            return await build_agent(stream_id=stream_id, options=options)
