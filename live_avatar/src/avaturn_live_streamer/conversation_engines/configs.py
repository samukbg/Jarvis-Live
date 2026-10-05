# SPDX-FileCopyrightText: 2026 Goodsize Inc.
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

from typing import Literal

from pydantic import BaseModel, ConfigDict

OpenaiRealtimeApiVoice = Literal[
    "alloy",
    "ash",
    "ballad",
    "cedar",
    "coral",
    "echo",
    "marin",
    "sage",
    "shimmer",
    "verse",
]


class OpenAIRealtimeAPIConversationEngineConfig(BaseModel):
    type: Literal["openai-realtime"] = "openai-realtime"
    client_secret: str | None = None
    avatar_id: str = "maria"

    model_config = ConfigDict(title="OpenAIRealtimeAPICEConfig", extra="ignore")


class CartesiaConversationEngineConfig(BaseModel):
    type: Literal["cartesia"] = "cartesia"
    access_token: str
    agent_id: str
    avatar_id: str = "maria"

    model_config = ConfigDict(title="CartesiaCEConfig", extra="ignore")


class GeminiConversationEngineConfig(BaseModel):
    type: Literal["gemini"] = "gemini"
    api_key: str
    model: str = "models/gemini-2.5-flash-native-audio-latest"
    prompt: str = ""
    voice: str = "Kore"
    avatar_id: str = "maria"
    enable_voice_conversion: bool = True
    jarvis_backend_url: str | None = None
    # Set when the Jarvis backend runs on another machine: the key the avatar calls it back with.
    jarvis_backend_key: str | None = None

    model_config = ConfigDict(title="GeminiCEConfig", extra="ignore")


class AgentConversationEngineConfig(BaseModel):
    type: Literal["agent"] = "agent"
    prompt: str = ""
    avatar_id: str = "maria"

    model_config = ConfigDict(title="AgentCEConfig", extra="ignore")


ConversationEngineConfig = (
    OpenAIRealtimeAPIConversationEngineConfig
    | CartesiaConversationEngineConfig
    | GeminiConversationEngineConfig
    | AgentConversationEngineConfig
)
