from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch

from fastapi.testclient import TestClient
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from assistant import Answer
from main import app
from runtime import run_agent


class FixtureModel(BaseLlm):
    async def generate_content_async(self, llm_request, stream=False):
        text = llm_request.contents[-1].parts[0].text
        assert "fictional question" in text
        assert llm_request.config.response_schema is Answer
        yield LlmResponse(
            content=types.Content(role="model", parts=[
                types.Part(text='{"answer":"Review the supplied figures.","references":["overview"]}'),
            ]),
            usage_metadata=types.GenerateContentResponseUsageMetadata(prompt_token_count=20, candidates_token_count=8),
        )


class PolicyModel(BaseLlm):
    async def generate_content_async(self, llm_request, stream=False):
        assert any(tool.google_search is not None for tool in llm_request.config.tools or [])
        payload = llm_request.contents[-1].parts[0].text
        assert "Fictional public policy" in payload and "history" not in payload
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="Review the published policy terms.")]),
            grounding_metadata=types.GroundingMetadata(
                grounding_chunks=[types.GroundingChunk(
                    web=types.GroundingChunkWeb(title="Public wording", uri="https://example.test/policy"),
                )],
                web_search_queries=["fictional public policy"],
            ),
            usage_metadata=types.GenerateContentResponseUsageMetadata(prompt_token_count=20, candidates_token_count=8),
        )


class RuntimeTests(IsolatedAsyncioTestCase):
    async def test_sdk_runner_returns_validated_text_and_usage(self):
        agent = LlmAgent(name="fixture", model=FixtureModel(model="fixture"), instruction="Reply from the fixture.", output_schema=Answer)
        text, event = await run_agent(agent, {"question": "fictional question"})
        self.assertEqual(Answer.model_validate_json(text).references, ["overview"])
        self.assertEqual(event.usage_metadata.candidates_token_count, 8)


class WorkerRoutes(TestCase):
    def test_chat_uses_the_adk_runner_and_keeps_grounding_references(self):
        client = TestClient(app)
        body = {
            "id": "2c8d72ab-a0e1-462c-870f-4192a186f4dd",
            "model": "gemini-3.1-flash-lite",
            "location": "global",
            "reasoning": "low",
            "maxOutput": 768,
            "question": "fictional question",
            "context": [{"ref": "overview", "start": "2026-11-01", "end": "2026-11-30", "values": {"savings": 200}}],
            "history": [],
        }
        with patch("assistant.vertex_model", return_value=FixtureModel(model="fixture")):
            response = client.post("/chat", json=body)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["references"], ["overview"])
            self.assertEqual(response.json()["usage"]["calls"], 1)

            response = client.post("/chat", json={**body, "context": []})
            self.assertEqual(response.status_code, 503)

    def test_worker_bounds_body_and_does_not_echo_input(self):
        client = TestClient(app)
        self.assertEqual(client.post("/policy", content="{}", headers={"content-type": "text/plain"}).status_code, 415)
        self.assertEqual(client.post("/chat", json={"large": "x" * 21_000}).status_code, 413)
        response = client.post("/chat", json={"secret": "fictional private value"})
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("fictional private value", response.text)

    def test_policy_research_keeps_adk_grounding_and_search_usage(self):
        model = "gemini-3.1-flash-lite"
        with patch("assistant.vertex_model", return_value=PolicyModel(model=model)):
            response = TestClient(app).post("/policy", json={
                "insurer": "Fictional insurer", "product": "Fictional public policy", "uin": "",
                "model": model, "location": "global", "reasoning": "low", "maxOutput": 768,
            })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["sources"], [{"title": "Public wording", "url": "https://example.test/policy"}])
        self.assertEqual(response.json()["usage"]["search"], 1)
