use serde::{Serialize, Serializer};

/// 프론트엔드로 그대로 직렬화되는 에러 타입.
/// Tauri command 의 Err 값은 문자열로 전달된다.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("IO 오류: {0}")]
    Io(#[from] std::io::Error),

    #[error("DB 오류: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("JSON 오류: {0}")]
    Json(#[from] serde_json::Error),

    #[error("잘못된 요청: {0}")]
    Invalid(String),

    #[error("경로 접근이 거부되었습니다: {0}")]
    PathDenied(String),

    #[error("열려 있는 프로젝트가 없습니다{0}")]
    NoProject(String),

    #[error("찾을 수 없습니다: {0}")]
    NotFound(String),
}

impl AppError {
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::Invalid(msg.into())
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::NotFound(msg.into())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
