"""Asynchronous generation jobs.

Trained-model inference takes seconds to minutes, so the UI must never block
on it. Requests become jobs; the frontend polls and drops the finished clip on
the timeline when it is ready.

A job only reaches ``succeeded`` when the audio store has *decoded* the
resulting file. There is no state in which a job claims success without real
audio behind it.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

from backend.providers.base import GenerationRequest, GenerationResult, ProviderError
from backend.providers.registry import ProviderRegistry

log = logging.getLogger("umbra.jobs")


class JobState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class Job:
    id: str
    provider: str
    request: GenerationRequest
    state: JobState = JobState.QUEUED
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    result: Optional[GenerationResult] = None
    error: Optional[str] = None
    hint: Optional[str] = None
    stage: str = "queued"

    def to_json(self) -> Dict[str, Any]:
        return {
            "jobId": self.id,
            "provider": self.provider,
            "state": self.state.value,
            "stage": self.stage,
            "createdAt": self.created_at,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "elapsed": round((self.finished_at or time.time()) - self.created_at, 2),
            "result": self.result.to_json() if self.result else None,
            "error": self.error,
            "hint": self.hint,
            "label": self.request.label,
            "sceneId": self.request.scene_id,
            "timelineStart": self.request.timeline_start,
        }


class JobManager:
    """Single-worker queue.

    One worker by default because local inference is GPU-bound — running two
    diffusion passes concurrently on one device is slower than running them in
    sequence, and risks OOM.
    """

    def __init__(self, registry: ProviderRegistry, workers: int = 1, max_jobs: int = 300):
        self.registry = registry
        self.workers = workers
        self.max_jobs = max_jobs
        self._jobs: Dict[str, Job] = {}
        self._order: List[str] = []
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._tasks: List[asyncio.Task] = []
        self._running = False

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        for i in range(self.workers):
            self._tasks.append(asyncio.create_task(self._worker(i), name=f"umbra-job-worker-{i}"))
        log.info("job manager started with %d worker(s)", self.workers)

    async def stop(self) -> None:
        self._running = False
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks.clear()

    def submit(self, request: GenerationRequest) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], provider=request.provider, request=request)
        self._jobs[job.id] = job
        self._order.append(job.id)
        self._trim()
        self._queue.put_nowait(job.id)
        return job

    def _trim(self) -> None:
        while len(self._order) > self.max_jobs:
            old = self._order.pop(0)
            j = self._jobs.get(old)
            if j and j.state in (JobState.QUEUED, JobState.RUNNING):
                self._order.append(old)  # never evict live work
                return
            self._jobs.pop(old, None)

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def list(self, limit: int = 50) -> List[Job]:
        ids = self._order[-limit:][::-1]
        return [self._jobs[i] for i in ids if i in self._jobs]

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if job is None or job.state is not JobState.QUEUED:
            return False
        job.state = JobState.CANCELLED
        job.stage = "cancelled"
        job.finished_at = time.time()
        return True

    def stats(self) -> Dict[str, Any]:
        counts: Dict[str, int] = {}
        for j in self._jobs.values():
            counts[j.state.value] = counts.get(j.state.value, 0) + 1
        durations = [
            j.finished_at - j.started_at
            for j in self._jobs.values()
            if j.state is JobState.SUCCEEDED and j.started_at and j.finished_at
        ]
        return {
            "counts": counts,
            "queued": self._queue.qsize(),
            "workers": self.workers,
            "avgSeconds": round(sum(durations) / len(durations), 2) if durations else None,
        }

    async def _worker(self, index: int) -> None:
        while self._running:
            try:
                job_id = await self._queue.get()
            except asyncio.CancelledError:
                return
            job = self._jobs.get(job_id)
            if job is None or job.state is JobState.CANCELLED:
                continue

            job.state = JobState.RUNNING
            job.started_at = time.time()
            job.stage = "loading model"

            provider = self.registry.get(job.provider)
            if provider is None:
                job.state = JobState.FAILED
                job.error = f"unknown provider '{job.provider}'"
                job.finished_at = time.time()
                continue

            try:
                job.stage = "inference"
                result = await provider.generate(job.request)
                job.result = result
                job.state = JobState.SUCCEEDED
                job.stage = "complete"
                log.info(
                    "job %s ok: %s %.2fs of audio @ %d Hz",
                    job.id, job.provider, result.duration, result.sample_rate,
                )
            except ProviderError as exc:
                job.state = JobState.FAILED
                job.error = str(exc)
                job.hint = exc.hint
                job.stage = "failed"
                log.warning("job %s failed: %s", job.id, exc)
            except asyncio.CancelledError:
                job.state = JobState.CANCELLED
                job.stage = "cancelled"
                job.finished_at = time.time()
                raise
            except Exception as exc:  # pragma: no cover - defensive
                job.state = JobState.FAILED
                job.error = f"{type(exc).__name__}: {exc}"
                job.stage = "failed"
                log.exception("job %s crashed", job.id)
            finally:
                job.finished_at = time.time()
