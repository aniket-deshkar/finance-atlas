from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch

from fastapi.testclient import TestClient
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from google.genai.errors import ClientError

from assistant import Answer
from main import app
from runtime import ModelResponseError, run_agent


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

    async def test_provider_permission_failure_keeps_status_without_details(self):
        class DeniedModel(BaseLlm):
            async def generate_content_async(self, llm_request, stream=False):
                if stream:
                    yield LlmResponse()
                raise ClientError(403, {"error":{"code":403, "status":"PERMISSION_DENIED", "message":"Fictional provider details"}})

        agent = LlmAgent(name="denied", model=DeniedModel(model="fixture"), instruction="Run the fixture.")
        with self.assertRaises(ModelResponseError) as failure:
            await run_agent(agent, {"question":"fictional question"})
        self.assertEqual(failure.exception.code, "PERMISSION_DENIED")
        self.assertNotIn("Fictional provider details", str(failure.exception))


class WorkerRoutes(TestCase):
    def test_model_garden_uses_google_auth_and_counts_reasoning_tokens(self):
        body = {
            "id": "2c8d72ab-a0e1-462c-870f-4192a186f4dd", "model": "gpt-oss-120b-maas",
            "location": "global", "reasoning": "low", "maxOutput": 768, "question": "fictional question",
            "context": [{"ref": "overview", "start": "2026-11-01", "end": "2026-11-30", "values": {"savings": 200}}],
            "history": [],
        }
        with patch.dict("os.environ", {"GOOGLE_CLOUD_PROJECT": "test-project"}), \
                patch("assistant.google_credentials", return_value=(object(), "test-project")), \
                patch("assistant.AuthorizedSession") as session:
            post = session.return_value.__enter__.return_value.post
            post.return_value.json.return_value = {
                "choices": [{"finish_reason":"stop", "message": {
                    "content": '{"answer":"Use the supplied amount.","references":["overview"]}',
                    "reasoning_content": "Fictional internal reasoning",
                }}],
                "usage": {"prompt_tokens": 14, "completion_tokens": 7, "reasoning_tokens": 5, "total_tokens": 26},
            }
            client = TestClient(app)
            response = client.post("/chat", json=body)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["usage"], {"input":14, "output":12, "calls":1})
            self.assertNotIn("Fictional internal reasoning", response.text)
            endpoint, = post.call_args.args
            payload = post.call_args.kwargs["json"]
            self.assertEqual(endpoint, "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/endpoints/openapi/chat/completions")
            self.assertEqual(payload["model"], "openai/gpt-oss-120b-maas")
            self.assertEqual(payload["max_tokens"], 768)
            self.assertEqual(payload["response_format"]["type"], "json_schema")
            self.assertEqual(client.post("/chat", json={**body, "location":"asia-south1"}).status_code, 503)
            self.assertEqual(client.post("/chat", json={**body, "context":[]}).status_code, 503)
            self.assertEqual(post.call_count, 2)

    def test_openai_preview_routes_luna_and_terra_to_responses_without_storage(self):
        body = {
            "id": "2c8d72ab-a0e1-462c-870f-4192a186f4dd", "location":"global", "reasoning":"low",
            "maxOutput":768, "question":"Fictional question.", "context":[], "history":[],
        }
        with patch.dict("os.environ", {"GOOGLE_CLOUD_PROJECT":"test-project"}), \
                patch("assistant.google_credentials", return_value=(object(), "test-project")), \
                patch("assistant.AuthorizedSession") as session:
            post = session.return_value.__enter__.return_value.post
            upstream = {"status":"completed", "output":[{"type":"reasoning", "summary":[{"text":"Internal output"}]},
                {"type":"message", "role":"assistant", "content":[{"type":"output_text",
                    "text":'{"answer":"No amount was supplied.","references":[]}'}]}],
                "usage":{"input_tokens":12, "output_tokens":30, "output_tokens_details":{"reasoning_tokens":14}}}
            post.return_value.json.return_value = upstream
            client = TestClient(app)
            for model in ("gpt-6-luna", "gpt-6.1-terra"):
                with self.subTest(model=model):
                    response = client.post("/chat", json={**body, "model":model})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()["usage"], {"input":12, "output":30, "calls":1})
                    self.assertNotIn("Internal output", response.text)
                    self.assertTrue(post.call_args.args[0].endswith("/locations/global/publishers/openai/v1/responses"))
                    payload = post.call_args.kwargs["json"]
                    self.assertEqual(payload["model"], model)
                    self.assertFalse(payload["store"])
                    self.assertEqual(payload["text"]["format"]["type"], "json_schema")
                    self.assertEqual(payload["max_output_tokens"], 768)
            upstream["status"] = "incomplete"
            self.assertEqual(client.post("/chat", json={**body, "model":"gpt-6-luna"}).status_code, 503)

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
