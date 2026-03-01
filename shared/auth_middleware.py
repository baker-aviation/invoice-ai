"""
Shared authentication middleware for FastAPI backend services.

Defense-in-depth: verifies a Bearer token on all requests (except /healthz).
Cloud Run IAM remains the primary auth layer; this is a second check so that
a misconfigured IAM policy doesn't expose all endpoints.

Usage in each service's main.py:

    from auth_middleware import add_auth_middleware
    app = FastAPI()
    add_auth_middleware(app)

The expected token is read from the SERVICE_AUTH_TOKEN environment variable.
If SERVICE_AUTH_TOKEN is not set, the middleware is a no-op (allows gradual rollout).
"""

import os
from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

# Paths that skip token verification (health checks, readiness probes)
_PUBLIC_PATHS = frozenset({"/healthz", "/readyz", "/"})


class _ServiceAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, token: str):
        super().__init__(app)
        self._token = token

    async def dispatch(self, request: Request, call_next):
        if request.url.path in _PUBLIC_PATHS:
            return await call_next(request)

        auth_header = request.headers.get("authorization", "")
        if not auth_header.startswith("Bearer "):
            return JSONResponse({"error": "Missing Bearer token"}, status_code=401)

        if auth_header[7:] != self._token:
            return JSONResponse({"error": "Invalid token"}, status_code=403)

        return await call_next(request)


def add_auth_middleware(app) -> None:
    """Add Bearer-token auth middleware if SERVICE_AUTH_TOKEN is set."""
    token = os.getenv("SERVICE_AUTH_TOKEN", "").strip()
    if not token:
        return  # no-op — allows gradual rollout
    app.add_middleware(_ServiceAuthMiddleware, token=token)
