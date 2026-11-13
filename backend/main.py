"""Just-Save-It FastAPI Backend & Remote MCP Server.

Integrates:
1. AI Summarization Router (/api/ai/summarize)
2. Remote MCP Server (/mcp) for external AI assistants (Claude Desktop, Cursor, etc.)
3. Health check & CORS middleware
"""

import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from Ai.mcp_server import MCPAuthMiddleware, mcp
from Ai.router import router as ai_router

app = FastAPI(
    title="Just-Save-It Backend API & Remote MCP Server",
    description="Backend services for saving links, On-Demand AI summarization, and external AI MCP access.",
    version="1.0.0",
)

# CORS Middleware for Web App, Mobile App, and Browser Extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ai_router)

if mcp is not None:
    try:
        mcp_starlette_app = mcp.sse_app()
        mcp_starlette_app.add_middleware(MCPAuthMiddleware)
        app.mount("/mcp", mcp_starlette_app)
    except Exception as e:
        import logging
        logging.getLogger("just_save_it.main").warning("Could not mount MCP SSE app: %s", e)


@app.get("/health", tags=["Health"])
def health_check():
    """Health check endpoint for container orchestrators and uptime monitoring."""
    return {
        "status": "healthy",
        "service": "Just-Save-It Backend",
        "mcp_enabled": mcp is not None,
    }


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host=host, port=port, reload=True)
