"""
Jobs Service

Manages generation jobs and async task tracking.
"""

import uuid
import asyncio
import logging
from typing import Optional, Callable, Any
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

logger = logging.getLogger(__name__)


class JobState(str, Enum):
    """Job state enumeration."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETE = "complete"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class Job:
    """Represents a generation job."""
    id: str
    job_type: str
    state: JobState = JobState.PENDING
    progress: float = 0.0
    message: str = ""
    created_at: datetime = field(default_factory=datetime.utcnow)
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    result: Optional[Any] = None
    error: Optional[str] = None
    metadata: dict = field(default_factory=dict)


class JobManager:
    """
    Manages async generation jobs.
    
    Features:
    - Job submission and tracking
    - Progress updates
    - Cancellation support
    - Result retrieval
    """
    
    def __init__(self):
        self._jobs: dict[str, Job] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._locks: dict[str, asyncio.Lock] = {}
    
    def create_job(
        self,
        job_type: str,
        metadata: dict = None,
    ) -> str:
        """
        Create a new job.
        
        Args:
            job_type: Type of job (e.g., 'stable_audio_generation')
            metadata: Additional job metadata
            
        Returns:
            Job ID
        """
        job_id = f"job_{uuid.uuid4().hex[:12]}"
        
        self._jobs[job_id] = Job(
            id=job_id,
            job_type=job_type,
            metadata=metadata or {},
        )
        
        self._locks[job_id] = asyncio.Lock()
        
        logger.info(f"Created job: {job_id} type={job_type}")
        return job_id
    
    def get_job(self, job_id: str) -> Optional[Job]:
        """Get a job by ID."""
        return self._jobs.get(job_id)
    
    async def update_progress(
        self,
        job_id: str,
        progress: float,
        message: str = "",
    ) -> None:
        """
        Update job progress.
        
        Args:
            job_id: Job ID
            progress: Progress 0.0-1.0
            message: Status message
        """
        if job_id not in self._locks:
            return
        
        async with self._locks[job_id]:
            job = self._jobs.get(job_id)
            if job:
                job.progress = min(1.0, max(0.0, progress))
                job.message = message
                logger.debug(f"Job {job_id}: {progress*100:.1f}% - {message}")
    
    async def complete_job(
        self,
        job_id: str,
        result: Any,
    ) -> None:
        """
        Mark a job as complete.
        
        Args:
            job_id: Job ID
            result: Job result data
        """
        if job_id not in self._locks:
            return
        
        async with self._locks[job_id]:
            job = self._jobs.get(job_id)
            if job:
                job.state = JobState.COMPLETE
                job.progress = 1.0
                job.result = result
                job.completed_at = datetime.utcnow()
                logger.info(f"Job {job_id} completed")
    
    async def fail_job(
        self,
        job_id: str,
        error: str,
    ) -> None:
        """
        Mark a job as failed.
        
        Args:
            job_id: Job ID
            error: Error message
        """
        if job_id not in self._locks:
            return
        
        async with self._locks[job_id]:
            job = self._jobs.get(job_id)
            if job:
                job.state = JobState.FAILED
                job.error = error
                job.completed_at = datetime.utcnow()
                logger.error(f"Job {job_id} failed: {error}")
    
    async def start_job(self, job_id: str) -> None:
        """Mark a job as started."""
        if job_id not in self._locks:
            return
        
        async with self._locks[job_id]:
            job = self._jobs.get(job_id)
            if job:
                job.state = JobState.RUNNING
                job.started_at = datetime.utcnow()
                logger.info(f"Job {job_id} started")
    
    def cancel_job(self, job_id: str) -> bool:
        """
        Cancel a running job.
        
        Returns:
            True if cancelled
        """
        job = self._jobs.get(job_id)
        if not job:
            return False
        
        if job.state == JobState.RUNNING:
            job.state = JobState.CANCELLED
            job.completed_at = datetime.utcnow()
            
            # Cancel the underlying task
            task = self._tasks.get(job_id)
            if task and not task.done():
                task.cancel()
            
            logger.info(f"Job {job_id} cancelled")
            return True
        
        return False
    
    async def run_job(
        self,
        job_id: str,
        coro: Callable,
        *args,
        **kwargs,
    ) -> Any:
        """
        Run a coroutine as a job.
        
        Args:
            job_id: Job ID
            coro: Coroutine to run
            *args, **kwargs: Arguments for the coroutine
            
        Returns:
            Job result
        """
        await self.start_job(job_id)
        
        try:
            result = await coro(*args, **kwargs)
            await self.complete_job(job_id, result)
            return result
            
        except asyncio.CancelledError:
            await self.fail_job(job_id, "Job cancelled")
            raise
            
        except Exception as e:
            await self.fail_job(job_id, str(e))
            raise
    
    def list_jobs(
        self,
        state: Optional[JobState] = None,
        limit: int = 50,
    ) -> list[Job]:
        """
        List jobs, optionally filtered by state.
        
        Args:
            state: Filter by state
            limit: Maximum results
            
        Returns:
            List of jobs
        """
        jobs = list(self._jobs.values())
        
        if state:
            jobs = [j for j in jobs if j.state == state]
        
        # Sort by creation time (newest first)
        jobs.sort(key=lambda j: j.created_at, reverse=True)
        
        return jobs[:limit]
    
    def cleanup_completed(self, max_age_hours: int = 24) -> int:
        """
        Remove old completed/failed jobs.
        
        Args:
            max_age_hours: Maximum age in hours
            
        Returns:
            Number of jobs removed
        """
        from datetime import timedelta
        
        cutoff = datetime.utcnow() - timedelta(hours=max_age_hours)
        removed = 0
        
        to_remove = []
        for job_id, job in self._jobs.items():
            if job.state in (JobState.COMPLETE, JobState.FAILED, JobState.CANCELLED):
                if job.completed_at and job.completed_at < cutoff:
                    to_remove.append(job_id)
        
        for job_id in to_remove:
            del self._jobs[job_id]
            self._locks.pop(job_id, None)
            self._tasks.pop(job_id, None)
            removed += 1
        
        if removed:
            logger.info(f"Cleaned up {removed} old jobs")
        
        return removed
