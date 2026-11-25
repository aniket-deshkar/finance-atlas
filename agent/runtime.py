import json
import os
from contextlib import aclosing
from uuid import uuid4

from fastapi import HTTPException, Request
from google.adk.agents.run_config import RunConfig
from google.adk.models import Gemini
from google.adk.runners import InMemoryRunner
from google.genai import types
from pydantic import ValidationError


def vertex_model(model: str, location: str) -> Gemini:
    return Gemini(model=model, client_kwargs={
        "enterprise": True,
        "project": os.environ["GOOGLE_CLOUD_PROJECT"],
        "location": location,
        "http_options": types.HttpOptions(retry_options=types.HttpRetryOptions(attempts=1)),
    })


async def run_agent(agent, payload):
    app_name = "finance_atlas"
    runner = InMemoryRunner(agent=agent, app_name=app_name)
    try:
        session = await runner.session_service.create_session(
            app_name=app_name, user_id="owner", session_id=str(uuid4()),
        )
        prompt = types.Content(role="user", parts=[
            types.Part(text=json.dumps(payload, ensure_ascii=False, separators=(",", ":"))),
        ])
        async with aclosing(runner.run_async(
            user_id="owner", session_id=session.id, new_message=prompt, run_config=RunConfig(max_llm_calls=1),
        )) as events:
            async for event in events:
                if event.error_code:
                    raise ValueError("Model response unavailable.")
                if event.author != agent.name or not event.is_final_response() or not event.content:
                    continue
                text = "".join(part.text or "" for part in event.content.parts or [] if not part.thought)
                if text.strip():
                    return text, event
        raise ValueError("The agent did not return a final answer.")
    finally:
        await runner.close()


async def read_json(request: Request, limit: int, schema=None):
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise HTTPException(415, "Expected JSON.")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > limit:
            raise HTTPException(413, "The request is too large.")
        data.extend(chunk)
    try:
        return schema.model_validate_json(data) if schema else json.loads(data)
    except (ValidationError, ValueError):
        raise HTTPException(400, "The request is invalid.") from None
