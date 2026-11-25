"""Serve the production worker on loopback with a deterministic ADK model."""

import json
import socket
from unittest.mock import patch

import uvicorn
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from main import app


class EvaluationModel(BaseLlm):
    async def generate_content_async(self, llm_request, stream=False):
        payload = json.loads(llm_request.contents[-1].parts[0].text)
        grounding = None
        if "insurer" in payload:
            assert any(tool.google_search is not None for tool in llm_request.config.tools)
            answer = "Review the fictional policy wording."
            grounding = types.GroundingMetadata(
                grounding_chunks=[types.GroundingChunk(
                    web=types.GroundingChunkWeb(title="Fictional policy wording", uri="https://example.test/policy"),
                )],
                web_search_queries=["fictional policy wording"],
            )
        else:
            assert not llm_request.config.tools
            facts = payload["facts"]
            refs = [fact["ref"] for fact in facts]
            if payload["question"] == "Simulate an unknown reference.":
                refs = ["unknown-reference"]
            if payload["question"] == "Simulate a partial reply." and "tax" in refs:
                raise RuntimeError("Synthetic specialist failure")
            answer = json.dumps({"answer": "Review the supplied figures." if facts else "No figures were provided.", "references": refs})
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text=answer)]),
            grounding_metadata=grounding,
            usage_metadata=types.GenerateContentResponseUsageMetadata(prompt_token_count=90, candidates_token_count=30),
        )


if __name__ == "__main__":
    with socket.create_server(("127.0.0.1", 0)) as listener:
        print(f"PORT {listener.getsockname()[1]}", flush=True)
        with patch("assistant.vertex_model", side_effect=lambda model, location: EvaluationModel(model=model)):
            uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False)).run(sockets=[listener])
