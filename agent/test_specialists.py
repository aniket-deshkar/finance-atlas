import asyncio
import unittest

from specialists import run_specialists


class SpecialistTests(unittest.IsolatedAsyncioTestCase):
    async def test_specialists_share_neither_context_nor_failures(self):
        events = []
        running = asyncio.Event()

        async def invoke(name, facts):
            events.append((name, facts))
            if name == "spending":
                await running.wait()
                return [{"ref": "spend-0", "reason": "over_budget"}]
            running.set()
            raise ValueError("Fake provider failure")

        result = await run_specialists({
            "asOf": "2026-11-15", "start": "2026-11-01", "end": "2026-11-30",
            "spending": [{"id": "spend-0"}], "obligations": [{"id": "due-0"}],
        }, invoke)
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0][1]["items"], [{"id": "spend-0"}])
        self.assertEqual(events[1][1]["items"], [{"id": "due-0"}])
        self.assertIsNone(result["obligations"])
        self.assertEqual(result["spending"][0]["ref"], "spend-0")

    async def test_missing_facts_do_not_call_model(self):
        async def invoke(*_args):
            self.fail("An empty summary should not call the model.")

        result = await run_specialists({"spending": [], "obligations": []}, invoke)
        self.assertEqual(result, {"spending": [], "obligations": []})
