mod commands;
mod db;
mod error;
mod mcp;
mod paths;
mod process;
mod state;

#[cfg(test)]
#[path = "paths_tests.rs"]
mod paths_tests;

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod mcp_tests;

use mcp::McpRegistry;
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .manage(McpRegistry::default())
        .invoke_handler(tauri::generate_handler![
            // workspace
            commands::workspace::open_project,
            commands::workspace::close_project,
            commands::workspace::set_active_project,
            commands::workspace::list_open_projects,
            commands::workspace::get_active_project,
            commands::workspace::update_project_settings,
            commands::workspace::system_info,
            // 앱 전역 설정 (API 키 등)
            commands::settings::read_app_settings,
            commands::settings::write_app_settings,
            commands::settings::app_settings_path,
            // 스킬 문서 (절차서 — 도구와 다르다)
            commands::skills::skill_dirs,
            commands::skills::list_skill_files,
            commands::skills::create_skill_file,
            commands::skills::delete_skill_file,
            // shell
            commands::shell::execute_shell_command,
            commands::shell::cancel_shell_command,
            // file system
            commands::fs::read_file,
            commands::fs::read_file_base64,
            commands::fs::write_file,
            commands::fs::list_directory,
            commands::fs::create_directory,
            commands::fs::delete_path,
            commands::fs::path_info,
            commands::fs::search_project_files,
            commands::fs::save_attachment,
            commands::fs::read_attachment,
            // sessions & messages (대화 트리)
            commands::session::create_session,
            commands::session::list_sessions,
            commands::session::get_session,
            commands::session::rename_session,
            commands::session::delete_session,
            commands::session::append_message,
            commands::session::list_messages,
            commands::session::get_message_path,
            commands::session::update_message,
            commands::session::delete_message,
            commands::session::delete_messages,
            commands::session::restore_messages,
            commands::session::copy_messages,
            commands::session::branch_session,
            // 에이전트 메모리 (Phase 3)
            commands::memory::upsert_memory,
            commands::memory::list_memories,
            commands::memory::get_memory,
            commands::memory::delete_memory,
            // 서브에이전트 실행 기록 (Phase 4)
            commands::agent::create_agent_run,
            commands::agent::list_agent_runs,
            commands::agent::update_agent_run,
            commands::agent::delete_agent_run,
            commands::agent::reap_agent_runs,
            // MCP 브리지 (Phase 4-α)
            commands::mcp::mcp_connect,
            commands::mcp::mcp_call_tool,
            commands::mcp::mcp_cancel_tool,
            commands::mcp::mcp_disconnect,
            commands::mcp::mcp_list_servers,
            commands::mcp::mcp_server_logs,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 애플리케이션 실행에 실패했습니다");
}
