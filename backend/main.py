"""Just-Save-It FastAPI Backend & Remote MCP Server.

Integrates:
1. AI Summarization Router (/api/ai/summarize)
2. Remote MCP Server (/mcp) for external AI assistants (Claude Desktop, Cursor, etc.)
   supporting both SSE (/mcp/sse, /mcp/messages) and Streamable HTTP (/mcp)
3. Health check & CORS middleware
"""

from contextlib import asynccontextmanager
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.applications import Starlette

_BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(dotenv_path=_BACKEND_DIR / ".env", override=False)

from Ai.mcp_server import MCPAuthMiddleware, mcp
from Ai.router import router as ai_router
from Database.router import router as database_router
from Database.supabase_client import is_supabase_configured
from Login.router import router as login_router
from Reminders.router import router as reminders_router
from Unfurl.router import router as unfurl_router
from Unfurl.security import redact_secrets_in_text

CHROME_EXTENSION_ORIGIN_REGEX = r"^chrome-extension://[a-p]{32}$"


_DEFAULT_CORS_ORIGINS = (
    "https://just-save-it-web.onrender.com,"
    "http://localhost:4173,http://127.0.0.1:4173,"
    "http://localhost:3000,http://127.0.0.1:3000,"
    "http://localhost:8081"
)


def parse_cors_settings():
    """Resolve CORS origins, regex (allowing unpacked Chrome extensions), and credentials flag."""
    raw_origins = os.getenv("CORS_ALLOW_ORIGINS", _DEFAULT_CORS_ORIGINS).strip()
    cors_origins = [o.strip() for o in raw_origins.split(",") if o.strip()] or [
        o.strip() for o in _DEFAULT_CORS_ORIGINS.split(",")
    ]
    allow_all = "*" in cors_origins
    default_regex = "" if allow_all else CHROME_EXTENSION_ORIGIN_REGEX
    cors_regex = os.getenv("CORS_ALLOW_ORIGIN_REGEX", default_regex).strip() or None
    return cors_origins, cors_regex, not allow_all

logger = logging.getLogger("just_save_it.main")

_mcp_sse_app = None
_mcp_streamable_app = None


def _create_streamable_app():
    if mcp is None:
        return None
    streamable_factory = getattr(mcp, "streamable_http_app", None)
    if not callable(streamable_factory):
        return None
    return streamable_factory(
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        host="0.0.0.0",
    )


def _build_mcp_mount_app():
    """Build composite Starlette ASGI app serving SSE and Streamable HTTP behind MCPAuthMiddleware."""
    global _mcp_sse_app
    if mcp is None:
        return None

    _mcp_sse_app = mcp.sse_app()

    async def _mcp_dispatcher(scope, receive, send):
        if scope.get("type") != "http":
            await _mcp_sse_app(scope, receive, send)
            return

        sub_path = scope.get("path", "") or "/"
        if sub_path.startswith("/sse") or sub_path.startswith("/messages"):
            await _mcp_sse_app(scope, receive, send)
            return

        forwarded_scope = {**scope, "path": "/mcp", "raw_path": b"/mcp", "root_path": ""}
        active_streamable = _mcp_streamable_app
        if active_streamable is not None:
            await active_streamable(forwarded_scope, receive, send)
            return

        temp_streamable = _create_streamable_app()
        if temp_streamable is None:
            await _mcp_sse_app(scope, receive, send)
            return
        async with temp_streamable.router.lifespan_context(temp_streamable):
            await temp_streamable(forwarded_scope, receive, send)

    mounted = Starlette()
    mounted.mount("/", _mcp_dispatcher)
    mounted.add_middleware(MCPAuthMiddleware)
    return mounted


_mcp_mount_app = None
try:
    _mcp_mount_app = _build_mcp_mount_app()
except Exception as e:
    logger.warning("Could not initialize MCP mount app: %s", e)


@asynccontextmanager
async def _app_lifespan(_app: FastAPI):
    global _mcp_streamable_app
    streamable_app = _create_streamable_app()
    if streamable_app is not None and hasattr(streamable_app.router, "lifespan_context"):
        _mcp_streamable_app = streamable_app
        try:
            async with streamable_app.router.lifespan_context(streamable_app):
                yield
        finally:
            _mcp_streamable_app = None
    else:
        yield


app = FastAPI(
    title="Sherlink Backend API & Remote MCP Server",
    description="Backend services for saving links, Auth/Profile, Multi-language DB CRUD, On-Demand AI summarization, and external AI MCP access.",
    version="1.0.0",
    lifespan=_app_lifespan,
)

# Inner pure-ASGI unhandled error guard sits INSIDE CORSMiddleware so 500 errors keep CORS headers
class _UnhandledExceptionMiddleware:
    def __init__(self, asgi_app):
        self.asgi_app = asgi_app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.asgi_app(scope, receive, send)
            return
        response_started = False

        async def _send_wrapper(message):
            nonlocal response_started
            if message.get("type") == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.asgi_app(scope, receive, _send_wrapper)
        except Exception as exc:
            safe_err = redact_secrets_in_text(exc)
            logger.error("Unhandled %s %s exception: %s", scope.get("method", "?"), scope.get("path", "?"), safe_err)
            if response_started:
                raise
            resp = JSONResponse(status_code=500, content={"detail": "Internal server error"})
            await resp(scope, receive, send)


# Add inner error guard BEFORE CORSMiddleware (add_middleware wraps LIFO -> CORS becomes outer)
app.add_middleware(_UnhandledExceptionMiddleware)

_cors_origins, _cors_origin_regex, _cors_credentials = parse_cors_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=_cors_origin_regex,
    allow_credentials=_cors_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(login_router)
app.include_router(database_router)
app.include_router(ai_router)
app.include_router(unfurl_router)
app.include_router(reminders_router)

if _mcp_mount_app is not None:
    app.mount("/mcp", _mcp_mount_app)

if not is_supabase_configured():
    _local_media_dir = _BACKEND_DIR / ".local_thumbnails"
    app.mount(
        "/local-media",
        StaticFiles(directory=str(_local_media_dir), check_dir=False),
        name="local-media",
    )


@app.get("/health", tags=["Health"])
def health_check():
    """Health check endpoint for container orchestrators and uptime monitoring."""
    return {
        "status": "healthy",
        "service": "Sherlink Backend",
        "auth_enabled": True,
        "mcp_enabled": mcp is not None,
        "storage_mode": "supabase" if is_supabase_configured() else "local_dev",
    }


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host=host, port=port, reload=True)
