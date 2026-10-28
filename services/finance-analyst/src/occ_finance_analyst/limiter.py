"""Per-domain request pacing.

Eastmoney is an external site: no matter how many pages a request asks for, we
never exceed a small per-domain rate and never run unbounded Playwright
contexts. The bucket spaces requests evenly (no burst) so a 16-page A-share
scrape looks like a slow human reader rather than a crawler.
"""

from __future__ import annotations

import asyncio
from urllib.parse import urlparse


class DomainLimiter:
    def __init__(self, rate_per_sec: float = 5.0) -> None:
        if rate_per_sec <= 0:
            raise ValueError("rate_per_sec must be > 0")
        self._interval = 1.0 / rate_per_sec
        self._next_allowed: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def acquire(self, url: str) -> None:
        host = urlparse(url).netloc
        loop = asyncio.get_running_loop()
        async with self._lock:
            now = loop.time()
            wait = max(0.0, self._next_allowed.get(host, 0.0) - now)
            self._next_allowed[host] = max(now, self._next_allowed.get(host, 0.0)) + self._interval
        if wait > 0:
            await asyncio.sleep(wait)

    def cooldown(self, url: str, seconds: float) -> None:
        """Push the next allowed slot back after a 429/503."""
        host = urlparse(url).netloc
        loop = asyncio.get_running_loop()
        now = loop.time()
        self._next_allowed[host] = max(self._next_allowed.get(host, 0.0), now + seconds)
