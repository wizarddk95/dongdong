pub mod models;
pub mod queries;
pub mod schema;

#[cfg(test)]
mod tests;

use std::path::Path;

use rusqlite::Connection;

use crate::error::AppResult;
use crate::paths;

/// 프로젝트 루트에 `.agent_workspace/local.db` 를 만들고 마이그레이션까지 끝낸 커넥션을 반환한다.
pub fn open_workspace_db(root: &Path) -> AppResult<Connection> {
    let dir = paths::workspace_dir(root);
    std::fs::create_dir_all(&dir)?;

    // 워크스페이스 산출물이 사용자의 git 저장소를 오염시키지 않도록 한다.
    let gitignore = dir.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(&gitignore, "# dongdong 로컬 워크스페이스\n*\n")?;
    }

    let mut conn = Connection::open(paths::db_path(root))?;
    schema::apply_pragmas(&conn)?;
    schema::migrate(&mut conn)?;
    Ok(conn)
}
