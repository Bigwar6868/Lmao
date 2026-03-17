"""Event bus for decoupled inter-module communication."""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from typing import Any, Callable

log = logging.getLogger(__name__)

EventHandler = Callable[..., Any]


class EventBus:
    """Simple pub/sub event bus."""

    def __init__(self) -> None:
        self._handlers: dict[str, list[EventHandler]] = defaultdict(list)

    def on(self, event_type: str, handler: EventHandler) -> None:
        self._handlers[event_type].append(handler)

    def off(self, event_type: str, handler: EventHandler) -> None:
        if handler in self._handlers[event_type]:
            self._handlers[event_type].remove(handler)

    def emit(self, event_type: str, data: Any = None, source: str = "") -> None:
        handlers = self._handlers.get(event_type, [])
        for handler in handlers:
            try:
                handler(data, source)
            except Exception as e:
                log.error("Event handler error for %s: %s", event_type, e)


event_bus = EventBus()
