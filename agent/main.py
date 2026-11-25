import logging
import os
from typing import Literal

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from google.adk.agents import LlmAgent
from google.genai import types
from pydantic import BaseModel, ConfigDict, Field

from specialists import SPECIALISTS, run_specialists
from assistant import register_assistant
from runtime import read_json, run_agent, vertex_model


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


async def invoke_specialist(name: str, facts: dict, model: str, location: str) -> list:
    agent = LlmAgent(
        name=f"atlas_{name}_analyst",
        model=vertex_model(model, location),
        instruction=SPECIALISTS[name],
        output_schema=Proposals,
        generate_content_config=types.GenerateContentConfig(max_output_tokens=750, candidate_count=1),
    )
    result, _ = await run_agent(agent, facts)
    return Proposals.model_validate_json(result).model_dump()["items"]


@app.get("/healthz")
async def health():
    return {"status": "ok"}


@app.post("/analyze")
async def analyze(request: Request):
    summary = await read_json(request, 12_000)
    if not isinstance(summary, dict) or set(summary) != {"start", "end", "asOf", "spending", "obligations"} or any(
        not isinstance(summary[name], list) or len(summary[name]) > 12 for name in SPECIALISTS
    ):
        raise HTTPException(400, "Invalid summary.")
    model = request.headers.get("x-atlas-model") or os.environ["ATLAS_VERTEX_MODEL"]
    location = request.headers.get("x-atlas-location") or os.environ["GOOGLE_CLOUD_LOCATION"]
    if model != os.environ["ATLAS_VERTEX_MODEL"] or location != os.environ["GOOGLE_CLOUD_LOCATION"]:
        raise HTTPException(503, "Configure the same analysis model and region on the API and worker.")

    async def invoke(name, facts):
        return await invoke_specialist(name, facts, model, location)

    return await run_specialists(summary, invoke)


if __name__ == "__main__":
    if os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").lower() != "true" or not all(
        os.environ.get(key) for key in ("GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "ATLAS_VERTEX_MODEL")
    ):
        raise SystemExit("Configure the Vertex AI project, region and model before starting the worker.")
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), access_log=False)
