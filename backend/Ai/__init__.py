"""Just-Save-It AI Module."""

from .content_extractor import (
    extract_text_for_ai,
    is_safe_url,
    validate_safe_url,
)
from .llm_client import (
    call_builtin_llm,
    call_byok_or_custom_llm,
    generate_structured_summary,
)
from .mcp_server import (
    create_item,
    delete_item,
    get_authenticated_user_id,
    get_item_detail,
    list_folders,
    list_tags,
    manage_folder,
    manage_item_tags,
    mcp,
    rename_or_delete_tag,
    resolve_user_id_from_token,
    search_and_list_items,
    set_authenticated_user_id,
    set_or_cancel_reminder,
    share_folder_link,
    summarize_item_to_note,
    update_item,
    verify_mcp_token,
)
from .router import router
from .schemas import (
    AIConfig,
    AISummaryOutput,
    SummarizeRequest,
    SummarizeResponse,
)
from .summarizer_service import (
    check_and_increment_quota,
    check_item_access_permission,
    get_supabase_client,
    summarize_item_once,
)

__all__ = [
    "AIConfig",
    "AISummaryOutput",
    "SummarizeRequest",
    "SummarizeResponse",
    "call_builtin_llm",
    "call_byok_or_custom_llm",
    "check_and_increment_quota",
    "check_item_access_permission",
    "create_item",
    "delete_item",
    "extract_text_for_ai",
    "generate_structured_summary",
    "get_authenticated_user_id",
    "get_item_detail",
    "get_supabase_client",
    "is_safe_url",
    "list_folders",
    "list_tags",
    "manage_folder",
    "manage_item_tags",
    "mcp",
    "rename_or_delete_tag",
    "resolve_user_id_from_token",
    "router",
    "search_and_list_items",
    "set_authenticated_user_id",
    "set_or_cancel_reminder",
    "share_folder_link",
    "summarize_item_once",
    "summarize_item_to_note",
    "update_item",
    "validate_safe_url",
    "verify_mcp_token",
]
