import json
import logging
import os
from typing import Literal
from uuid import uuid4

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from google.adk.agents import LlmAgent
from google.adk.agents.run_config import RunConfig
from google.adk.runners import InMemoryRunner
from google.genai import types
from pydantic import BaseModel, ConfigDict, Field

from specialists import SPECIALISTS, run_specialists
from assistant import register_assistant


class Proposal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ref: str = Field(pattern=r"^(spend|due)-[0-9]{1,2}$")
    reason: Literal["over_budget", "near_budget", "overdue", "due_soon", "check_pending"]


class Proposals(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[Proposal] = Field(max_length=6)


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
register_assistant(app)
logging.getLogger("google_adk").setLevel(logging.CRITICAL)
logging.getLogger("google_genai").setLevel(logging.CRITICAL)


async def invoke_specialist(name: str, facts: dict) -> list:
    agent = LlmAgent(
        name=f"atlas_{name}_analyst",
        model=os.environ["ATLAS_VERTEX_MODEL"],
        instruction=SPECIALISTS[name],
        output_schema=Proposals,
        generate_content_config=types.GenerateContentConfig(max_output_tokens=750, candidate_count=1),
    )
    runner = InMemoryRunner(agent=agent, app_name="finance_atlas")
    session = await runner.session_service.create_session(app_name="finance_atlas", user_id="owner", session_id=str(uuid4()))
    prompt = types.Content(role="user", parts=[types.Part(text=json.dumps(facts, separators=(",", ":")))])
    result = None
    try:
        async for event in runner.run_async(
            user_id="owner", session_id=session.id, new_message=prompt,
            run_config=RunConfig(max_llm_calls=1),
        ):
            if event.is_final_response() and event.content:
                result = "".join(part.text or "" for part in event.content.parts or [] if not part.thought)
        return Proposals.model_validate_json(result or "").model_dump()["items"]
    finally:
        await runner.close()


@app.get("/healthz")
async def health():
    return {"status": "ok"}


@app.post("/analyze")
async def analyze(request: Request):
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > 12_000:
            raise HTTPException(413, "Summary is too large.")
        body.extend(chunk)
    try:
        summary = json.loads(body)
        if not isinstance(summary, dict) or set(summary) != {"start", "end", "asOf", "spending", "obligations"}:
            raise ValueError
        if any(not isinstance(summary[name], list) or len(summary[name]) > 12 for name in SPECIALISTS):
            raise ValueError
    except (ValueError, TypeError):
        raise HTTPException(400, "Invalid summary.") from None
    return await run_specialists(summary, invoke_specialist)


if __name__ == "__main__":
    if os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").lower() != "true" or not all(
        os.environ.get(key) for key in ("GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "ATLAS_VERTEX_MODEL")
    ):
        raise SystemExit("Configure the Vertex AI project, region and model before starting the worker.")
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), access_log=False)
